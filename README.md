**Markdown Page Downloader for Firefox**

[Firefox Add-on Store](https://addons.mozilla.org/firefox/addon/page-to-markdown/)

Page to Markdown is a Firefox extension that converts the current page into **clean, structured Markdown**, then downloads it to your machine. It's designed for:

- **Note‑taking and knowledge bases** (Obsidian, Logseq, Notion, etc.)
- **LLM workflows**, where HTML is noisy and wastes context window
- **Long‑term archiving** of articles, tutorials, and documentation

---

## Features

- **One‑click capture**
  Click the toolbar button to extract and save the current page as a `.md` file. Hold `Shift` to toggle the default "keep links/images" vs "plain text" mode.

- **Readable content extraction**
  Uses [defuddle](https://github.com/kepano/defuddle) to pull out the main article content and avoid chrome, sidebars, ads, and unrelated UI where possible. Specialized extractors run first for YouTube transcripts, Poe conversations, and old Reddit threads. Falls back to the page body clone if defuddle can't parse or returns an implausibly thin selection (e.g. SPA chat transcripts). The body clone is scrubbed of invisible chrome first — `display:none`/`visibility:hidden` inline styles, `[hidden]`, `<template>`, skip-to-content links, and `[aria-hidden="true"]` subtrees (math renderers and content-dominating subtrees exempted) — so screen-reader live regions and skip links never reach the markdown. Hidden tab panels are pruned via `preserveActiveTabs` so only the active tab's code survives.

- **High‑quality Markdown**
  Uses `turndown` + GFM plugin with custom rules for:
  - Fenced code blocks, including language hints from `language-*`, `data-lang`, `data-language`, and `lang-*`
  - Mermaid diagrams: `<svg id="mermaid-...">` with `data-source` or nearby ` ```mermaid ` source → fenced ` ```mermaid `; otherwise a placeholder or `data:image/svg+xml` data URI
  - Headings: `## [Link](#anchor)` and `<a><h3>…</h3></a>` → `## Link`
  - Figures and captions (`<figure>`, `<figcaption>`) → image + italic caption
  - Pruned noise elements (`script`, `style`, `noscript`, `iframe`, `object`, `embed`, `footer`, `nav`, …)

- **YAML frontmatter for metadata**
  Each file starts with frontmatter containing:
  - `title`, `url`, `domain`
  - `date_saved`
  - `word_count`, `reading_time`
  - When available: `author`, `date_published`, `description`, `tags`

- **LLM‑friendly structure**
  Clean, compact Markdown that is easy to paste into chat interfaces without wasting tokens on boilerplate HTML. A "Plain text" mode strips links and images.

- **Safe, informative filenames**
  Filenames are generated from the page title and domain, with unsafe characters removed and length limited to 100 chars, e.g.:

  `Understanding defuddle in Firefox - developer.mozilla.org.md`

---

## How it works

1. You click the **Page to Markdown** toolbar button (or `Shift+click` to toggle link stripping).
2. `src/background.js` (`MarkdownDownloader`) reads `defaultStripLinks` from `browser.storage.local`, checks modifiers, and sends `trigger_conversion` with `{ stripLinks, stripImages }` to the active tab.
3. `src/content.js` (`AdvancedMarkdownConverter.processPage`):
   - Reads `debugLogging` from storage to gate diagnostics (`this.log()`).
   - Tries `tryExtractYouTubeTranscript()` first (YouTube watch pages) — fetches fresh caption tracks via the `youtubei/v1/player` ANDROID client, falls back to inline `ytInitialPlayerResponse` parsing and DOM scraping.
   - Else tries Poe conversation transcript (`poe.com` chat messages) and Reddit thread extractor (`old.reddit.com` via `#siteTable .thing.link`; modern `shreddit` UI falls through).
   - Else clones `document.body`, runs `preserveActiveTabs`, prunes invisible chrome (`pruneNoiseElements`), passes a synthetic document to `Defuddle` (`defuddle.parse()`), with a hybrid fallback if defuddle drops `pre` blocks or returns a near-empty selection.
   - Collects metadata from `defuddle` result + meta tags.
   - Converts the resulting HTML to Markdown via `TurndownService` + GFM, after `normalizeContentHtml` preprocessing (mermaid SVG → `pre.language-mermaid`, `pre` → normalized `code` with language).
4. `content.js` posts `{ markdown, metadata }` back via `browser.runtime.sendMessage`.
5. `background.js` builds YAML frontmatter, generates a safe filename, creates a `Blob` URL, and calls `browser.downloads.download`.

If anything fails you see a console error (gated behind the "Enable debug logging" option) and, for most failures, an in‑page alert.

---

## Installation

### From Mozilla Add-ons (recommended)

1. Visit the add-on page:
   https://addons.mozilla.org/firefox/addon/page-to-markdown/
2. Click **Add to Firefox**.
3. Pin the extension icon if you use it frequently.

### From source (development)

1. Clone this repository.
2. `pnpm install`
3. `pnpm run build` — builds `dist/content.js`, `dist/background.js`, `dist/options.*` (sourcemaps only in dev mode: `npx vite build --mode development`).
4. In Firefox, open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and choose `manifest.json`.

The extension will remain installed until you restart the browser or unload it.

---

## Permissions explained

The extension requests these WebExtension permissions:

- `activeTab`
  Needed to run the content script and read the DOM of the currently active tab when you click the icon.

- `downloads`
  Required to create and download the resulting Markdown file.

- `storage`
  Used for the default download mode and the "Enable debug logging" toggle (options page).

No other permissions (cookies, history, storage sync, remote servers, etc.) are used.

---

## Privacy

- All processing happens **locally in your browser**.
- The extension **does not send any page content or metadata to external servers**.
- Downloaded files are generated from in-memory content and saved using the browser's downloads API.

For auditing, the main logic lives in:

- `src/content.js` — extraction, cleanup, mermaid/code normalization, and Markdown conversion
- `src/background.js` — frontmatter generation, filename sanitization, and file download
- `src/options.{js,html,css}` — default mode and debug toggle
- `src/lib/redditExtractor.js`, `src/lib/tabState.js`, `src/lib/youtubeTranscript.js` — site-specific extractors
- `dist/` — bundled output from Vite (see `vite.*.config.js`)

---

## Development

- **Manifest:** `manifest.json` (Manifest V2 for Firefox; `version` synced from `package.json` at build/publish time — `package.json` is the source of truth)
- **Build:** Vite with three configs (`vite.content.config.js`, `vite.background.config.js`, `vite.options.config.js`) → `dist/`; `sourcemap: mode !== 'production'` so `pnpm dev` keeps maps and `pnpm build` drops them
- **Tests:** `vitest` + `happy-dom` (`pnpm test`) — covers Reddit extractor, tab state, code/mermaid/heading pipeline, frontmatter/filename edge cases, and `pickBestTrack`
- **Lint:** `eslint` (`pnpm run lint`; also `web-ext lint` in CI)
- **Packaging:** `build_zip.sh` stages a version-patched `manifest.json` in a temp dir and zips `manifest.json` + `dist` + `icons` → `pagetomd-*.zip` (never mutates the tracked `manifest.json`)

Typical dev loop:

1. Make changes to `src/content.js`, `src/background.js`, or libraries under `src/lib/`.
2. `pnpm run build` (or `pnpm run dev` for watch mode).
3. Reload the extension from `about:debugging` → **This Firefox** → **Reload**.
4. Open a page, click the icon, and — if "Enable debug logging" is on — inspect the console for `[PageToMD]` diagnostics.

DeepWiki post-processing: see `tools/README.md` (`tools/fix_deepwiki.py` patches downloaded markdown for compressed tables, mangled mermaid CSS, and broken `data:image/svg+xml` images).

---

## Limitations & notes

- Defuddle works best on article‑style pages (blogs, docs, news). Highly dynamic apps or dashboards may not extract cleanly.
- Some sites use non‑standard markup for code, images, or tags; the output quality can vary.
- Tables require the GFM plugin to be present and loaded (configured via `turndown-plugin-gfm`).

Bug reports and improvement ideas are welcome — please file them as GitHub issues.
