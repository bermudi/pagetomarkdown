**Markdown Page Downloader for Firefox**

[Firefox Add-on Store](https://addons.mozilla.org/firefox/addon/page-to-markdown/)

Page to Markdown is a Firefox extension that converts the current page into **clean, structured Markdown**, then downloads it to your machine. It’s designed for:

- **Note‑taking and knowledge bases** (Obsidian, Logseq, Notion, etc.)
- **LLM workflows**, where HTML is noisy and wastes context window
- **Long‑term archiving** of articles, tutorials, and documentation

---

## Features

- **One‑click capture**  
  Click the toolbar button to extract and save the current page as a `.md` file.

- **Readable content extraction**  
  Uses Mozilla’s `Readability` library to pull out the main article content and avoid chrome, sidebars, ads, and unrelated UI where possible. Falls back to the page body if Readability can’t parse.

- **High‑quality Markdown**  
  Uses `turndown` (+ optional GFM plugin) with custom rules for:
  - Fenced code blocks, including language hints from classes like `language-js`
  - Figures and captions (`<figure>`, `<figcaption>`) → image + italic caption
  - Pruned noise elements (`script`, `style`, `noscript`, `iframe`, `object`, `embed`, `footer`, `nav`, …)

- **YAML frontmatter for metadata**  
  Each file starts with frontmatter containing:
  - `title`, `url`, `domain`
  - `date_saved`
  - `word_count`, `reading_time`
  - When available: `author`, `date_published`, `description`, `tags`

- **LLM‑friendly structure**  
  Clean, compact Markdown that is easy to paste into chat interfaces without wasting tokens on boilerplate HTML.

- **Safe, informative filenames**  
  Filenames are generated from the page title and domain, with unsafe characters removed and length limited to avoid OS issues, e.g.:
  
  `Understanding Readability in Firefox - developer.mozilla.org.md`

---

## How it works

1. You click the **Page to Markdown** browser action.
2. `background.js` sends a `trigger_conversion` message to the active tab.
3. `content.js`:
   - Extracts the main article content (Readability → fallback to `document.body` clone).
   - Collects metadata from `<title>` and common meta tags (`og:title`, `description`, `keywords`, etc.).
   - Converts the cleaned HTML to Markdown via `TurndownService` with custom rules.
4. `content.js` posts `{ markdown, metadata }` back to the background script.
5. `background.js`:
   - Builds YAML frontmatter from the metadata.
   - Generates a safe filename from the title + domain.
   - Uses the `downloads` API to save the `.md` file.

If anything fails during processing, you’ll see an error in the console and (for most failures) an alert in the page.

---

## Installation

### From Mozilla Add-ons (recommended)

1. Visit the add-on page:  
   https://addons.mozilla.org/firefox/addon/page-to-markdown/
2. Click **Add to Firefox**.
3. Pin the extension icon if you use it frequently.

### From source (development)

1. Clone this repository.
2. In Firefox, open `about:debugging` → **This Firefox**.
3. Click **Load Temporary Add-on…** and choose `manifest.json` from this repo.

The extension will remain installed until you restart the browser or unload it.

---

## Permissions explained

The extension requests these WebExtension permissions:

- `activeTab`  
  Needed to run the content script and read the DOM of the currently active tab when you click the icon.

- `downloads`  
  Required to create and download the resulting Markdown file via the Firefox downloads API.

No other permissions (cookies, history, storage sync, remote servers, etc.) are used.

---

## Privacy

- All processing happens **locally in your browser**.
- The extension **does not send any page content or metadata to external servers**.
- Downloaded files are generated from in-memory content and saved using the browser’s downloads API.

For auditing, the main logic lives in:

- `content.js` – extraction, cleanup, and Markdown conversion
- `background.js` – frontmatter generation and file download
- `lib/readability.js` – Mozilla Readability implementation
- `lib/turndown.js`, `lib/turndown-plugin-gfm.js` – HTML → Markdown

---

## Development

- **Manifest:** `manifest.json` (Manifest V2 for Firefox)
- **Content script pipeline:** configured under `content_scripts` in `manifest.json`
- **Build tooling:** none required; this is a plain WebExtension project.

Typical dev loop:

1. Make changes to `content.js`, `background.js`, or libraries under `lib/`.
2. Reload the extension from `about:debugging` → **This Firefox** → **Reload**.
3. Open a page, click the icon, and inspect the console in the page or background for logs.

---

## Limitations & notes

- Readability works best on article‑style pages (blogs, docs, news). Highly dynamic apps or dashboards may not extract cleanly.
- Some sites use non‑standard markup for code, images, or tags; the output quality can vary.
- Tables require the GFM plugin (`turndown-plugin-gfm.js`) to be present and loaded, which this extension is configured for.

Bug reports and improvement ideas are welcome.
