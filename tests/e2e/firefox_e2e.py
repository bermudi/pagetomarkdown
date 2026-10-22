#!/usr/bin/env python3
"""
End-to-end check: install the extension in Firefox, click its toolbar button,
convert a real page and verify the file that lands on disk.

This covers what the unit tests cannot: the content script → background
script → frontmatter → downloads API chain, in the browser the extension
actually ships to, with the add-on installed the way a user installs it.

Run it with:

    pnpm build
    uv run --with marionette_driver python tests/e2e/firefox_e2e.py

Environment:
    FIREFOX_BIN   Firefox binary (default: Developer Edition, then firefox)
"""

from __future__ import annotations

import http.server
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def find_firefox() -> str:
    candidates = [
        os.environ.get("FIREFOX_BIN", ""),
        "/usr/bin/firefox-developer-edition",
        "/usr/bin/firefox",
        "/usr/bin/firefox-esr",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise SystemExit("no Firefox binary found — set FIREFOX_BIN")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102 - silence the request log
        pass


def start_server() -> tuple[socketserver.TCPServer, int]:
    handler = lambda *a, **kw: QuietHandler(*a, directory=str(REPO), **kw)  # noqa: E731
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def write_profile(profile: Path, download_dir: Path) -> None:
    profile.mkdir(parents=True, exist_ok=True)
    prefs = {
        # Let the extension write files without asking.
        "browser.download.folderList": 2,
        "browser.download.dir": str(download_dir),
        "browser.download.useDownloadDir": True,
        "browser.download.always_ask_before_handling_new_types": False,
        "browser.helperApps.neverAsk.saveToDisk": "text/markdown,text/plain,application/octet-stream",
        "browser.shell.checkDefaultBrowser": False,
        "browser.startup.homepage": "about:blank",
        "datareporting.policy.dataSubmissionEnabled": False,
        "toolkit.telemetry.enabled": False,
    }
    lines = []
    for key, value in prefs.items():
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, int):
            value = str(value)
        else:
            value = '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'
        lines.append(f'user_pref("{key}", {value});\n')
    (profile / "user.js").write_text("".join(lines))


def launch_firefox(profile: Path) -> subprocess.Popen:
    return subprocess.Popen(
        [
            find_firefox(),
            "--marionette",
            "--profile",
            str(profile),
            "--new-instance",
            "--no-remote",
            "--headless",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        # The chrome context (where the toolbar button lives) needs this.
        env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"},
    )


def find_download(download_dir: Path) -> Path | None:
    if not download_dir.exists():
        return None
    markdown = sorted(p for p in download_dir.iterdir() if p.is_file() and p.suffix.lower() == ".md")
    return markdown[0] if markdown else None


def wait_for_download(download_dir: Path, timeout: float = 30.0) -> Path | None:
    """Wait for the file, then for its size to settle (Firefox writes in chunks)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = find_download(download_dir)
        if found:
            last = -1
            stable = 0
            while stable < 3:
                size = found.stat().st_size
                if size == last and size > 0:
                    stable += 1
                else:
                    stable = 0
                    last = size
                time.sleep(0.3)
            return found
        time.sleep(0.3)
    return None


def click_toolbar_button(client, addon_id: str) -> str:
    """Open the unified extensions panel and click the extension's button."""
    client.set_context(client.CONTEXT_CHROME)
    widget_id = "_" + addon_id.strip("{}") + "_-BAP"

    for attempt in range(3):
        client.execute_script(
            "document.getElementById('unified-extensions-button').click();",
            script_timeout=20000,
        )
        time.sleep(1.0 + attempt)
        result = client.execute_script(
            """
            const [widgetId] = arguments;
            const button = document.getElementById(widgetId);
            if (!button) return 'missing';
            button.click();
            return 'clicked';
            """,
            script_args=[widget_id],
            script_timeout=20000,
        )
        if result == "clicked":
            return result
    return result


def diagnose(client) -> str:
    """Console + download state from the browser chrome — for failures."""
    try:
        client.set_context(client.CONTEXT_CHROME)
    except Exception:
        return "(no chrome context)"
    try:
        console = client.execute_script(
            """
            try {
                const msgs = Services.console.getMessageArray() || [];
                return msgs.slice(-20)
                    .map(m => (m.errorMessage || m.message || String(m)))
                    .filter(t => !/normandy|Telemetry|ClientID|Shield/i.test(t))
                    .join('\\n');
            } catch (e) { return 'console dump failed: ' + e.message; }
            """,
            script_timeout=20000,
        )
        downloads = client.execute_script(
            """
            try {
                const list = [];
                for (let i = 0; i < Downloads.count; i++) {
                    const d = Downloads.get(i);
                    list.push(d.targetPath + ' | ' + d.state + ' | ' + (d.error || ''));
                }
                return list.join('\\n') || 'no downloads';
            } catch (e) { return 'downloads dump failed: ' + e.message; }
            """,
            script_timeout=20000,
        )
        return f"console:\n{console}\ndownloads:\n{downloads}"
    except Exception as error:  # pragma: no cover - diagnostics only
        return f"(diagnostics failed: {error})"


SCENARIOS = [
    {
        "name": "docs page",
        "page": "tests/fixtures/pipeline/docs-shell.html",
        "checks": {
            "frontmatter present": lambda text: text.startswith("---\n"),
            "title in frontmatter": lambda text: "title:" in text.split("---")[1] if text.startswith("---") else False,
            "article content present": lambda text: "The widget renders interactive charts" in text,
            "diagram recovered": lambda text: "```mermaid" in text,
            "table rendered": lambda text: "| Option | Type | Default |" in text,
            "code fence kept": lambda text: "```bash" in text,
            "no page chrome": lambda text: "SIDEBAR NOISE" not in text and "HEADER CHROME" not in text,
            "no upgrade promo": lambda text: "Upgrade to Pro" not in text,
        },
    },
    {
        # The Reddit extractor must not hijack the modern UI: no old-reddit
        # markup, so it has to step aside and let the generic pipeline run.
        # The file must contain the post body, not just the thread title.
        "name": "modern reddit thread",
        "page": "tests/fixtures/pipeline/reddit-modern.html",
        "checks": {
            "frontmatter present": lambda text: text.startswith("---\n"),
            "post body present": lambda text: "borrow checker is the reason" in text,
            "comments present": lambda text: "refuses to let me write the bug" in text,
            "not a title-only file": lambda text: len(text.strip()) > 400,
        },
    },
]


def main() -> int:
    from marionette_driver.addons import Addons
    from marionette_driver.marionette import Marionette

    if not (REPO / "dist" / "content.js").exists():
        print("dist/ is missing — run `pnpm build` first", file=sys.stderr)
        return 2

    httpd, port = start_server()
    workdir = Path(tempfile.mkdtemp(prefix="pagetomd-e2e-"))
    profile = workdir / "profile"
    downloads = workdir / "downloads"
    downloads.mkdir()
    write_profile(profile, downloads)

    firefox = launch_firefox(profile)
    client = None
    failures: list[str] = []

    try:
        client = Marionette(host="127.0.0.1", port=2828)
        client.start_session()
        print(f"firefox up ({find_firefox()})")

        addon = Addons(client).install(str(REPO), temp=True)
        print(f"installed {addon}")

        for scenario in SCENARIOS:
            name = scenario["name"]
            print(f"\n=== scenario: {name} ===")

            # Content scripts are only injected into tabs opened *after* the
            # add-on was loaded, so navigate afterwards. Navigation needs the
            # content context; the toolbar click leaves us in the chrome one.
            client.set_context(client.CONTEXT_CONTENT)
            url = f"http://127.0.0.1:{port}/{scenario['page']}"
            client.navigate(url)
            print(f"navigated to {url}")
            time.sleep(2)

            # Start each scenario with an empty download directory.
            for stale in downloads.iterdir():
                if stale.is_file():
                    stale.unlink()

            result = click_toolbar_button(client, addon)
            print(f"toolbar button: {result}")
            if result != "clicked":
                failures.append(f"{name}: could not click the toolbar button ({result})")
                continue

            downloaded = wait_for_download(downloads)
            if downloaded is None:
                failures.append(f"{name}: no file was downloaded")
                print(diagnose(client))
                continue

            content = downloaded.read_text(encoding="utf-8")
            print(f"downloaded {downloaded.name} ({len(content)} bytes)")
            print("---- file ----")
            print(content)
            print("---- end ----")

            for check_name, check in scenario["checks"].items():
                ok = check(content)
                print(f"  {'PASS' if ok else 'FAIL'}  {check_name}")
                if not ok:
                    failures.append(f"{name}: {check_name}")
    finally:
        if client is not None:
            try:
                client.delete_session()
            except Exception:
                pass
        firefox.terminate()
        try:
            firefox.wait(timeout=10)
        except subprocess.TimeoutExpired:
            firefox.kill()
        httpd.shutdown()
        if failures:
            print(f"workdir kept for inspection: {workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
