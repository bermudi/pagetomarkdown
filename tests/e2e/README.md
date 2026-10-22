# End-to-end test (Firefox)

`firefox_e2e.py` installs the extension in a throwaway Firefox profile, clicks
its toolbar button on a real page and checks the markdown file that lands on
disk.

It covers the part the unit tests cannot: the content script → background
script → frontmatter → `browser.downloads` chain, with the add-on installed
the way a user installs it.

## Running it

```bash
pnpm build
uv run --with marionette_driver python tests/e2e/firefox_e2e.py
```

Needs a Firefox binary — Developer Edition (`/usr/bin/firefox-developer-edition`)
is used when present, otherwise `firefox` or `firefox-esr`. Override with
`FIREFOX_BIN=/path/to/firefox`.

It runs headless, needs no display, and touches nothing outside a temporary
directory (removed on success, kept for inspection on failure).

## What it checks

Two scenarios, each one a page served over HTTP by the script itself:

- `tests/fixtures/pipeline/docs-shell.html` — nav chrome, sidebar, code
  blocks, a diagram and a table. Asserts the frontmatter, the article text,
  the recovered diagram, the rendered table, the kept code fence — and that
  no page chrome (sidebar, header, promo box) made it into the file.
- `tests/fixtures/pipeline/reddit-modern.html` — a stand-in for Reddit's
  modern UI (shreddit elements, none of the old-reddit markup). The Reddit
  extractor must step aside here: the file has to contain the post body and
  the comments, not just the thread title.

## How it works

- Firefox is launched with `--marionette --headless` and a generated profile
  whose prefs point the download directory at a temp folder.
- The add-on is installed as a *temporary* add-on through Marionette's
  `Addons(client).install(repo, temp=True)`.
- The toolbar button lives in Firefox's unified extensions panel: open
  `#unified-extensions-button`, then click the extension's
  `_<addon-id>_-BAP` widget in the chrome context. The chrome context needs
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in the environment at launch time.
- The content script is only injected into tabs opened *after* the add-on was
  installed, so the script navigates afterwards.

## In CI

`.github/workflows/ci.yml` runs it in a separate `e2e-firefox` job on
`ubuntu-22.04` (Ubuntu 24.04 ships Firefox as a snap, which cannot use a
custom profile directory).
