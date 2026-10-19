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
