# Tools

## fix_deepwiki.py — DeepWiki post-processor

**Status: Option B (kept as separate fixer, see issue #16)**

The extension's in-extension mermaid handling (`src/content.js` `normalizeContentHtml`) converts
`<svg id="mermaid-...">` blocks to fenced ` ```mermaid ` when a textual source can be found.
That covers live SVG diagrams. However, some DeepWiki pages ship *already-rendered* mermaid
output as compressed CSS blobs (`#mermaid-... { ... } @keyframes ...`) inside plain ` ``` `
blocks, plus tables that are compressed into `||` delimited rows inside a code fence, and broken
`data:image/svg+xml` images. Those are artifacts of the *already-downloaded markdown*,
not the live DOM, so they cannot be fixed by DOM preprocessing alone.

`fix_deepwiki.py` patches the downloaded `.md` files after the fact:

1. Compressed tables inside code fences → proper markdown tables
2. Mangled mermaid CSS blobs → `> **Diagram:** …` blockquote placeholders
3. Broken `![Mermaid diagram](data:image/svg+xml...)` images → removed

### Pipeline

```
extension (Page to Markdown) → raw .md → fix_deepwiki.py → clean .md
```

### Usage

```bash
# single file
python tools/fix_deepwiki.py path/to/file.md

# multiple
python tools/fix_deepwiki.py docs/*.md

# preview without writing
python tools/fix_deepwiki.py --dry-run path/to/file.md
```

### Why Option B?

Issue #16 asked to pick a strategy:

- **Option A** — fix entirely in-extension, delete the script.
- **Option B** — keep the script as a documented post-processor.

Option B is kept for now because:

- The extension pipeline hasn't been verified end-to-end against real DeepWiki HTML fixtures.
- The fixes are post-download regex patches on markdown text; they would require new turndown
  rules *and* markdown-level passes inside the extension, which is a larger change.
- The script is idempotent and cheap; keeping it as `tools/` with tests is reversible. If
  future work proves in-extension handling covers all cases, we can delete it then.

### Testing

A fixture lives in `tests/fixtures/deepwiki/` (links to issue #13). The Python helper is
covered by `tools/test_fix_deepwiki.py` (happy-dom style for Python):

```bash
uv run pytest tools/test_fix_deepwiki.py -q
# or
python -m pytest tools/test_fix_deepwiki.py
```

### Maintenance

- If the extension's DeepWiki output improves, add a failing fixture first, then decide
  whether to extend `content.js` or extend this script.
- Keep `publish.yml` ignoring `tools/**` so the helper never ships in the XPI.
