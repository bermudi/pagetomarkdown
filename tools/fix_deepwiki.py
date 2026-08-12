#!/usr/bin/env python3
"""
Fix deepwiki.com markdown extraction issues:
1. Fix compressed tables inside code blocks -> proper markdown tables
2. Replace mangled mermaid CSS blobs -> clean blockquote placeholders
3. Remove broken SVG images at end of files
"""

import re
import sys
import argparse
from pathlib import Path


def is_mermaid_garbage(content: str) -> bool:
    """Check if a code block contains mangled mermaid rendered output."""
    return any(
        [
            content.startswith("#mermaid-"),
            "font-family:ui-sans-serif" in content,
            "edge-animation-frame" in content,
            "stroke-dasharray" in content,
            "arrowMarkerPath" in content,
            "#mermaid-" in content and "@keyframes" in content,
        ]
    )


def remove_css_blocks(text: str) -> str:
    """Remove CSS blocks by finding known selector patterns followed by balanced braces."""
    # Pattern for comma-separated #mermaid- selectors, @keyframes, and :root
    css_start = re.compile(
        r"(?:#mermaid-[a-z0-9]+(?:\s*[@.#:>+~]?[\w-]+)*\s*,\s*)*"
        r"#mermaid-[a-z0-9]+(?:\s*[@.#:>+~]?[\w-]+)*\s*\{"
        r"|@keyframes\s+[\w-]+\s*\{"
        r"|:root\s*\{"
    )

    result = []
    i = 0
    while True:
        m = css_start.search(text, i)
        if not m:
            result.append(text[i:])
            break

        # Keep text before the CSS block
        result.append(text[i : m.start()])

        # Find matching }
        depth = 1
        j = m.end()  # position right after {
        while j < len(text) and depth > 0:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1

        if depth == 0:
            i = j
        else:
            # Unmatched brace – keep the rest as-is
            result.append(text[m.start() :])
            break

    return "".join(result)


def extract_mermaid_labels(content: str) -> str:
    """Extract human-readable labels from mangled mermaid output."""
    text = content

    # Remove CSS blocks
    text = remove_css_blocks(text)

    # Remove remaining braces
    text = text.replace("{", "").replace("}", "")

    # Remove SVG tags
    text = re.sub(r"<[^>]+>", "", text)

    # Remove URLs
    text = re.sub(r"https?://\S+", "", text)

    # Remove stray @keyframes keyword
    text = re.sub(r"\b@keyframes\b", "", text)

    # Clean up whitespace but preserve newlines for readability
    text = re.sub(r"[ \t]+", " ", text).strip()

    if not text:
        return ""

    # Split concatenated words
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    text = re.sub(r"([a-zA-Z])/(\w)", r"\1/ \2", text)

    # Insert space after punctuation followed by letter, preserve file extensions
    def split_punct(m: re.Match) -> str:
        punct, letter = m.group(1), m.group(2)
        if punct == "." and letter.lower() in "mjtyshxcpnrgkvwbfdqeluoaiz":
            return m.group(0)
        return f"{punct} {letter}"

    text = re.sub(r"([.?)\\\]])([A-Za-z])", split_punct, text)

    # Collapse multiple spaces, keep single newlines
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r" +", " ", text).strip()

    return text


def fix_codeblock_table(content: str) -> str | None:
    """
    If content looks like a compressed table inside a code block,
    return the fixed markdown. Otherwise return None.
    """
    if "||" not in content or "|" not in content:
        return None

    has_header = bool(re.search(r"^#{1,6}\s+", content))
    has_separator = "--" in content

    if not (has_header or has_separator):
        return None

    header_match = re.match(r"^(#{1,6}\s+[^|\n]+)(.*)", content, re.DOTALL)
    if header_match:
        header = header_match.group(1).strip()
        rest = header_match.group(2)
    else:
        header = None
        rest = content

    raw_rows = [r.strip() for r in rest.split("||")]
    rows = []

    for raw in raw_rows:
        if not raw:
            continue
        if raw.startswith("|"):
            raw = raw[1:]
        if raw.endswith("|"):
            raw = raw[:-1]
        raw = raw.strip()
        if not raw:
            continue

        if re.match(r"^[\s\-:|]+$", raw) and "-" in raw:
            cells = [c.strip() for c in raw.split("|")]
            sep_cells = []
            for c in cells:
                c = c.strip()
                if not c:
                    continue
                if c.startswith(":") and c.endswith(":"):
                    sep_cells.append(":---:")
                elif c.startswith(":"):
                    sep_cells.append(":---")
                elif c.endswith(":"):
                    sep_cells.append("---:")
                else:
                    sep_cells.append("---")
            rows.append("| " + " | ".join(sep_cells) + " |")
        else:
            rows.append("| " + raw + " |")

    if not rows:
        return None

    result = ""
    if header:
        result += header + "\n\n"
    result += "\n".join(rows) + "\n"
    return result


def process_codeblocks(text: str, processor) -> str:
    """Find code blocks and apply processor to their content."""
    lines = text.split("\n")
    result = []
    i = 0
    while i < len(lines):
        if lines[i].strip() == "```":
            i += 1
            content_lines = []
            while i < len(lines) and lines[i].strip() != "```":
                content_lines.append(lines[i])
                i += 1
            if i < len(lines):
                content = "\n".join(content_lines)
                replacement = processor(content)
                if replacement is not None:
                    result.append(replacement.rstrip("\n"))
                else:
                    result.append("```")
                    result.extend(content_lines)
                    result.append("```")
                i += 1
            else:
                result.append("```")
                result.extend(content_lines)
        else:
            result.append(lines[i])
            i += 1
    return "\n".join(result)


def fix_file(path: Path, dry_run: bool = False) -> bool:
    text = path.read_text(encoding="utf-8")
    original = text

    # Fix 1: compressed tables inside code blocks
    def process_table(content: str) -> str | None:
        return fix_codeblock_table(content)

    text = process_codeblocks(text, process_table)

    # Fix 2: mangled mermaid inside code blocks
    def process_mermaid(content: str) -> str | None:
        if not is_mermaid_garbage(content):
            return None
        labels = extract_mermaid_labels(content)
        if labels:
            # Format as multi-line blockquote if there are newlines
            lines = labels.split("\n")
            if len(lines) > 1:
                display = "\n> ".join(lines)
                return f"\n> **Diagram:** {display}\n"
            display = labels[:500] + "..." if len(labels) > 500 else labels
            return f"\n> **Diagram:** {display}\n"
        return "\n> *(Mermaid diagram omitted)*\n"

    text = process_codeblocks(text, process_mermaid)

    # Fix 3: remove broken mermaid SVG images
    text = re.sub(
        r"!\[Mermaid diagram\]\(data:image/svg\+xml[^)]*?(?:Syntax error|mermaid version)[^)]*?\)\n*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"\n*!\[Mermaid diagram\]\(data:image/svg\+xml[^)]+\)\s*$",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"!\[Mermaid diagram\]\(data:image/svg\+xml[^)]+\)\n*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    if text == original:
        print(f"  no changes  → {path}")
        return False

    if not dry_run:
        path.write_text(text, encoding="utf-8")
        print(f"  fixed       → {path}")
    else:
        print(f"  would fix   → {path}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fix common extraction artifacts in DeepWiki markdown files."
    )
    parser.add_argument("paths", nargs="+", help="Markdown file(s) to fix")
    parser.add_argument(
        "--dry-run", "-n", action="store_true", help="Preview changes without writing"
    )
    args = parser.parse_args()

    changed = 0
    for p in args.paths:
        path = Path(p)
        if not path.exists():
            print(f"  not found   → {path}", file=sys.stderr)
            continue
        if fix_file(path, dry_run=args.dry_run):
            changed += 1

    print(f"\n{changed} file(s) changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
