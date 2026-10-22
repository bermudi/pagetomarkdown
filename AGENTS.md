# AGENTS.md — pagetomd

Browser extension (MV2, Firefox) that saves pages as markdown. Read the root
README for architecture; this file is lessons that don't fit anywhere else.

## YouTube transcript extraction (state of the art, verified 2026-09-25)

The landscape, after a full day of archaeology:

- **timedtext caption URLs** (the classic pipeline: ANDROID innertube player →
  fresh baseUrl → XML/json3) return `HTTP 200` with a **zero-byte body** when
  YouTube enforces the proof-of-origin (`pot`) token requirement. Enforcement
  is **per-video**: some videos serve fine (644KB XML), others return empty
  from the same session/IP/minute. Never assume "empty body = no captions".
- **`get_transcript` innertube** with the page's own context/key/params returns
  `400 FAILED_PRECONDITION` without botguard attestation data. The
  `web_generate_att_data_for_get_transcript_request` experiment flag is the
  tell.
- Every third-party tool breaks identically: `youtube-transcript-plus`
  (tested — same empty body), yt-dlp with all player clients
  (`tv_simply`, `android_vr`, `web_embedded`, `mweb` — all "Did not get any
  data blocks"), public Invidious/Piped mirrors (dead or captcha'd).
  yt-dlp's working answer is a POT provider (botguard solver service) — not
  feasible inside an extension.
- **What works in a real browser**: the page's own transcript panel machinery
  (attested fetch). The extension drives/harvests it:
  - **2026 "modern" UI**: panel `ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]`,
    segments are `transcript-segment-view-model` (timestamp:
    `.ytwTranscriptSegmentViewModelTimestamp`, text: `span[role="text"]`).
  - **Old UI**: `engagement-panel-searchable-transcript` +
    `ytd-transcript-segment-renderer` inside `ytd-transcript-body-renderer`.
  - **yt-action harvest**: the page fires `yt-engagement-panel-visible-changed`
    CustomEvents whose `detail.args[0].content` carries the **entire
    transcript as JSON** (`sectionListRenderer.contents[].itemSectionRenderer
    .contents[].macroMarkersPanelItemViewModel.item.timelineItemViewModel`),
    even when the panel flashes open and auto-closes. Events cross
    content-script world boundaries. Listener attaches at module load.
  - The new-UI trigger button (ytSpec/Lit stack) ignores synthetic clicks
    (plain and full pointer sequences) **in automation-tainted sessions** —
    in clean sessions the plain click works. Scroll the button into view
    before dispatching (out-of-viewport pointer coordinates are rejected).
- **Speaker `>>` markers exist only in raw timedtext XML**, not in the panel
  data (pre-merged paragraphs). Videos blocked from the API fall back to the
  panel and lose the markers — that's a data limitation, not a bug.

## Debugging protocol for YouTube issues

1. Console on the YouTube tab shows the full pipeline trace under
   `[PageToMD:youtube]` (always on; `[PageToMD]` lines need the debug option).
2. Test the API path standalone first (works per-video):
   `curl` the ANDROID player endpoint, then the returned baseUrl — 0 bytes
   means pot-enforced for that video.
3. **Never debug via Marionette/selenium-style automation on the user's
   browser**: `navigator.webdriver=true` makes YouTube reject the session's
   transcript fetches, which poisons every observation (panels auto-close,
   buttons look inert). Attach for DOM inspection only; drive interactions
   through the extension or a human. This cost hours of wrong conclusions.
4. Marionette quirks: `execute_script` runs in a fresh sandbox per call —
   persist state via DOM attributes, not `window.*`; screenshots return
   base64; use `set_context(Marionette.CONTEXT_CONTENT)` right after
   `start_session()`.
5. Vision models misidentify Chrome vs Firefox screenshots — verify browser
   identity from UI details before drawing conclusions from them.

## Mermaid / rendered-diagram salvage (verified 2026-10-21, DeepWiki)

All of this lives in `src/lib/mermaid.js` now (it was 376 lines inside
`content.js`); `content.js` only orchestrates it.

- DeepWiki renders ` ```mermaid ` code blocks inside `<pre>` wrappers; mermaid.js
  replaces the code text with the rendered `<svg id="mermaid-…">`.
- **defuddle strips `id`, `class`, and `aria-*` attributes** (not in its
  `ALLOWED_ATTRIBUTES`) and dissolves the svg into raw text → the `pre` keeps
  `<code>#mermaid-x{…css…}GluedLabelText</code>`. The old `svg[id^="mermaid-"]`
  detector sees nothing; the fenced-`pre` rule then emits the CSS blob.
- The original diagram source survives in the page payload — Next.js RSC
  `<script>` strings (`self.__next_f.push`, `\n`-escaped — the collector
  decodes it). defuddle output never contains it.
- Matching: score each ` ```mermaid ` candidate by fraction of its identifier
  tokens (labels/paths) present in the remnant text. Verified margins: 0.86 /
  0.58 / 1.0 / 1.0 correct vs ≤0.5 runners-up on the live page.
- A mermaid SVG rendered by mermaid v10+ has **no text nodes**: the labels
  live in `<foreignObject>` HTML, so `svg.textContent` is empty and label
  matching cannot work on the live SVG — only on the *dissolved* remnant.
  The type-based fallback (graph/state/sequence + document order) is what
  pairs a live SVG with a source.
- happy-dom v20 **preserves** `<script>` text through an `innerHTML`
  round-trip (verified 2026-10-22; older notes here claimed otherwise —
  the pipeline reads the payload from `document.body.innerHTML` *and* from
  the live `<script>` elements).
- Firefox+Marionette e2e: `--marionette --profile <existing-dir>
  --new-instance --no-remote`, `Addons(client).install(repo, temp=True)`, then
  chrome context needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` *at launch*; click
  `_<id>_-BAP` in `#unified-extensions-view` after opening
  `unified-extensions-button`. Works headless (`-headless`) too.

## One content object, one truth (2026-10-22)

The pipeline used to keep the extracted content twice: `extractMainContent()`
returned a DOM element while `convertToMarkdown()` read a separate
`this.defuddleHtml` string. When the two disagreed, the converter swapped the
selection for `document.body.innerHTML` — the whole live page, nav bars and
sidebars included, with frontmatter that still described the small selection.

- `extractMainContent()` now returns **one** object: `{ element, html, kind }`.
  The markdown and the word count are both derived from it.
- **Rule: the live page may be read to *discover sources* (diagram code,
  captions), never as *content*.** If a diagram is missing from the
  selection, recover the diagram — not the page.
- A diagram the extractor dropped is rescued from the page and injected after
  the heading it sat under (`rescueMissingDiagrams`), not appended blindly.

## Fixtures and golden files (2026-10-22)

- `src/pipeline.test.js` runs whole pages through the pipeline and compares
  against `tests/fixtures/pipeline/*.expected.md`. Regenerate with
  `UPDATE_GOLDEN=1 pnpm vitest run src/pipeline.test.js`.
- **Capture real pages, don't invent them.** `agent-browser` (headless
  Chrome) gets pages that `curl` cannot — DeepWiki serves a Vercel security
  checkpoint to plain requests but renders fine in a browser.
  `agent-browser eval "document.documentElement.outerHTML"` dumps the
  rendered DOM.
- Store the **dissolved** diagram form in fixtures, not the live SVG: a
  36KB mermaid SVG with `foreignObject` labels does not survive happy-dom's
  parser (a 78KB fixture parsed down to 22KB, losing everything after the
  `<pre>`). Replacing the SVG with its own `textContent` (what defuddle
  leaves behind) is both smaller and faithful to what the extension sees.
- Defuddle's element picking needs layout metrics, so happy-dom picks
  different elements than Firefox. Fixtures that depend on the *selection*
  should feed the article container directly (`mode: 'content'` in the
  harness) instead of pinning happy-dom's guess.

## Firefox end-to-end (2026-10-22)

`tests/e2e/firefox_e2e.py` is the only check that covers the whole chain:
add-on installed → toolbar button clicked → content script → background
script → file on disk.

    pnpm build && uv run --with marionette_driver python tests/e2e/firefox_e2e.py

- `marionette_driver` is installed on the fly by `uv`; there is no geckodriver
  and no selenium — Marionette talks to Firefox directly.
- The chrome context needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` **in the
  environment at launch**; without it `set_context(CHROME)` fails with
  "System access is required".
- The toolbar button lives in Firefox's unified extensions panel: click
  `#unified-extensions-button`, then the extension's `_<addon-id>_-BAP`
  widget (the id has the braces stripped).
- Content scripts are only injected into tabs opened **after** the add-on was
  installed — install first, navigate second.
- `user_pref` values that are strings must be quoted, or Firefox refuses to
  parse the profile and silently ignores the pref (this cost an hour of
  "the download never happened").
- The content script's `window.markdownConverter` is **not visible** from
  Marionette's content context: content scripts live in an isolated world.
  Drive the extension through its UI (or the background page), not through
  the page's `window`.

## Misc

- Firefox temp add-ons (about:debugging) do not inject content scripts into
  tabs opened before loading — F5 the tab after (re)loading the add-on.
- Smoke-test loop: `pnpm dlx web-ext run --source-dir . --firefox
  /usr/bin/firefox-developer-edition --no-input --start-url <url>` —
  throws up Dev Edition on a throwaway profile with the add-on from
  `dist/` and auto-reloads on file changes. Run `pnpm build` first. The
  loaded add-on reports the in-repo manifest version (4.3.x — only
  `build_zip.sh` syncs it from package.json), so it *looks* identical to
  the AMO copy; "Temporary Extension" label is the tell.
- `pnpm lint && pnpm test && pnpm build` must pass before commits;
  `eslint.config.js` lists browser globals explicitly (add new ones there).
  Test files run in Node, so they get their own globals block there.
- `tools/fix_deepwiki.py` is **gone** (2026-10-22): the DeepWiki repairs moved
  into the extension (mermaid recovery, compressed-table repair, no more
  broken `data:image/svg+xml` diagrams). Git history keeps it for old files.
