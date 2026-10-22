# Roadmap

> **Note (2025-08):** The previous detailed "Code Block Extraction & Heading Cleanup" roadmap was historical — it quoted `content.js:44-56` from a Readability-era codebase and described tasks that have since been implemented (code-block preservation via `defuddle` + `normalizeContentHtml`, `detectLanguage`, heading link cleanup, etc.). That content is preserved in git history.

Current planning is tracked in **GitHub Issues** — see the `bermudi/pagetomarkdown` issues list. At the time of this rewrite the active items were:

- **#15** Reddit extractor modern-UI fallback — fixed to return `null` and let `defuddle` handle modern `shreddit` pages
- **#14** Dead code (mermaid duplicate, placeholder swap, `preferredLang`) — removed
- **#12** Console spam + debug toggle — gated via `this.log()` / `ytLog` and cheaper YouTube key extraction
- **#16** DeepWiki: fixed in the extension (Option A) — the diagram source is recovered from the page payload and emitted as a fenced ` ```mermaid ` block, compressed tables are repaired into real tables, and the `tools/fix_deepwiki.py` post-processor was deleted. `tests/fixtures/pipeline/deepwiki.html` is a real captured DeepWiki page used as a regression fixture.
- **#13** Tests for core pipeline — added `vitest` + `happy-dom` fixtures for code/mermaid/headings, frontmatter/filename, `pickBestTrack`, plus a golden-file harness (`src/pipeline.test.js`) over real captured pages
- **#18** Version source of truth — `package.json` is source; `build_zip.sh` stages a patched manifest, CI guards against drift
- **#19** Static analysis & source maps — `eslint` + `pnpm run lint`, `sourcemap: mode !== 'production'` so prod `dist` ships without maps
- **#17** Docs & stray files — README/ROADMAP refreshed, `tools/README.md`, `*.xcf` ignored, `pagetomd-*.zip` not tracked

**Future candidates** (not yet filed) could include:
- Shreddit-aware Reddit extractor (real `shreddit-post` / `shreddit-comment` parsing)
- Full TypeScript + `biome check` migration
- Browser e2e fixture harness (capture real page HTML → expected markdown)

For proposals, please open a discussion or issue — no separate roadmap file is needed beyond this pointer.
