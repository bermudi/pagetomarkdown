# DeepWiki fixture

This directory holds a minimal representative fixture for issue #16 / #13.

- `raw.md` — output as produced by the extension before `fix_deepwiki.py`
- `expected.md` — output after `fix_deepwiki.py` (or after in-extension fix)

The Python helper `tools/fix_deepwiki.py` is tested via `tools/test_fix_deepwiki.py`.
For the core pipeline (issue #13), see `src/lib/content.test.js` once added.

To regenerate from a real page:
1. Save a DeepWiki page with the extension (producing raw.md)
2. Run `python tools/fix_deepwiki.py raw.md`
3. Diff and commit both files.

