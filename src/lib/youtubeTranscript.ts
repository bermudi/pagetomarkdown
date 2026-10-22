/**
 * YouTube transcript extraction.
 *
 * Pipeline (reordered based on observed behavior):
 *   1. POST youtubei/v1/player with ANDROID client → fresh playerResponse
 *      with non-expired caption track URLs.
 *   2. Fetch transcript XML from the fresh track's baseUrl.
 *   3. Fallback: regex-extract captionTracks from inline HTML.
 *   4. Fallback: scrape visible transcript panel from DOM.
 *   5. Fallback: click "Show transcript" in the page UI ourselves, wait for
 *      the panel to populate, scrape it, then restore the page state.
 *      YouTube now returns empty bodies (200) for timedtext URLs that lack
 *      a proof-of-origin token, and rejects unattested get_transcript calls,
 *      so the page's own (attested) transcript machinery is often the only
 *      path that still works.
 */

import browser from 'webextension-polyfill';

const YT_WATCH_RE = /^https?:\/\/(www\.)?youtube\.com\/watch\?/;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface CaptionTrack {
    baseUrl: string;
    languageCode: string;
    name?: { simpleText: string };
    kind?: string;
}

export interface PlayerResponse {
    captions?: {
        playerCaptionsTracklistRenderer?: {
            captionTracks?: CaptionTrack[];
        };
    };
    videoDetails?: {
        title?: string;
        author?: string;
        shortDescription?: string;
        keywords?: string[];
    };
    microformat?: {
        playerMicroformatRenderer?: {
            ownerChannelName?: string;
            publishDate?: string;
        };
    };
}

export interface TranscriptMetadata {
    title: string;
    author: string;
    source: string;
    url: string;
    domain: string;
    description: string;
    publishedDate: string;
    tags: string[];
}

export interface TranscriptResult {
    found: boolean;
    isYouTube: boolean;
    markdown: string;
    metadata: Partial<TranscriptMetadata>;
}

let ytDebug = false;
function ytLog(...args: unknown[]): void {
    if (ytDebug) console.log('[PageToMD]', ...args);
}
// Pipeline checkpoints that should always be visible when diagnosing
// "no transcript" reports — not gated behind the debug option.
function ytTrace(...args: unknown[]): void {
    console.info('[PageToMD:youtube]', ...args);
}
async function updateYtDebug(): Promise<void> {
    try {
        const result = await browser.storage.local.get('debugLogging');
        ytDebug = !!result.debugLogging;
    } catch {
        ytDebug = false;
    }
}
function extractInnertubeApiKeyFromScripts(): string {
    for (const script of document.querySelectorAll('script')) {
        const text = script.textContent || '';
        const m = text.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/);
        if (m?.[1]) return m[1];
    }
    return '';
}

export function isYouTubeWatchPage(): boolean {
    return YT_WATCH_RE.test(window.location.href);
}

function getVideoId(): string {
    return new URL(window.location.href).searchParams.get('v') || '';
}

/* ------------------------------------------------------------------ */
/*  1.  Inline HTML helpers (fallback only)                           */
/* ------------------------------------------------------------------ */

function extractInnertubeApiKey(html: string): string {
    const m = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/);
    return m?.[1] || '';
}

function extractCaptionTracksFromHtml(html: string): CaptionTrack[] | null {
    const parts = html.split('"captions":');
    if (parts.length < 2) return null;
    const jsonPart = parts[1].split(',"videoDetails')[0].replace('\n', '');
    if (!jsonPart) return null;
    try {
        const renderer = JSON.parse(jsonPart).playerCaptionsTracklistRenderer;
        if (!renderer?.captionTracks) return null;
        return renderer.captionTracks.map((t: CaptionTrack) => ({
            baseUrl: t.baseUrl.startsWith('/api/timedtext')
                ? `https://www.youtube.com${t.baseUrl}`
                : t.baseUrl,
            languageCode: t.languageCode,
            name: { simpleText: t.name?.simpleText || t.languageCode },
            kind: t.kind || ''
        }));
    } catch {
        return null;
    }
}

function extractYtInitialPlayerResponseFromDom(): PlayerResponse | null {
    for (const script of document.querySelectorAll('script')) {
        const text = script.textContent || '';
        if (!text.includes('ytInitialPlayerResponse')) continue;

        const idx = text.indexOf('var ytInitialPlayerResponse');
        if (idx !== -1) {
            const eq = text.indexOf('=', idx);
            if (eq !== -1) {
                let depth = 0;
                let inStr = false;
                let esc = false;
                const start = eq + 1;
                let i = start;
                for (; i < text.length; i++) {
                    const ch = text[i];
                    if (esc) { esc = false; continue; }
                    if (ch === '\\') { esc = true; continue; }
                    if (ch === '"') { inStr = !inStr; continue; }
                    if (inStr) continue;
                    if (ch === '{') depth++;
                    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
                }
                try { return JSON.parse(text.slice(start, i)); } catch { /* continue */ }
            }
        }
    }
    return null;
}

/* ------------------------------------------------------------------ */
/*  2.  youtubei/v1/player (ANDROID client) — PRIMARY                 */
/* ------------------------------------------------------------------ */

const ANDROID_CONTEXT = {
    client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38'
    }
};

async function fetchPlayerResponse(videoId: string, apiKey: string): Promise<PlayerResponse> {
    const url = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Format-Version': '1'
        },
        body: JSON.stringify({
            context: ANDROID_CONTEXT,
            videoId
        })
    });
    if (!resp.ok) throw new Error(`player API ${resp.status}`);
    return resp.json();
}

/* ------------------------------------------------------------------ */
/*  3.  Language selection                                            */
/* ------------------------------------------------------------------ */

const LANG_FALLBACK_CHAIN = [
    'en', 'de', 'fr', 'es', 'it', 'zh', 'ja', 'ko', 'pt', 'ru'
];

export function pickBestTrack(tracks: CaptionTrack[] | null | undefined): CaptionTrack | null {
    if (!tracks || tracks.length === 0) return null;
    const byTwo = (code: string) => code.toLowerCase().slice(0, 2);

    const enTracks = tracks.filter((t) => byTwo(t.languageCode) === 'en');
    const manualEn = enTracks.find((t) => t.kind !== 'asr');
    if (manualEn) return manualEn;
    const autoEn = enTracks.find((t) => t.kind === 'asr');
    if (autoEn) return autoEn;

    for (const lang of LANG_FALLBACK_CHAIN) {
        const match = tracks.find((t) => byTwo(t.languageCode) === lang);
        if (match) return match;
    }

    return tracks[0];
}

/**
 * caption track URLs carry the video id they belong to (…&v=<id>). After
 * client-side (SPA) navigation the inline ytInitialPlayerResponse still
 * describes the *first* video loaded in the tab, so HTML/DOM fallbacks can
 * hand us tracks for the wrong video. Filter those out.
 */
export function isTrackForVideo(track: { baseUrl?: string } | null | undefined, videoId: string): boolean {
    if (!track?.baseUrl || !videoId) return false;
    try {
        const v = new URL(track.baseUrl).searchParams.get('v');
        // No v param → can't tell; keep it and let the fetch fail loudly.
        return v ? v === videoId : true;
    } catch {
        return true;
    }
}

/* ------------------------------------------------------------------ */
/*  4.  Timestamp formatting                                          */
/* ------------------------------------------------------------------ */

function formatTimestamp(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`;
    return `${mins}:${pad(secs)}`;
}

/* ------------------------------------------------------------------ */
/*  5.  Transcript fetch with debugging                               */
/* ------------------------------------------------------------------ */

async function fetchTranscriptXml(baseUrl: string): Promise<string[]> {
    const url = new URL(baseUrl);
    url.searchParams.delete('fmt');

    const resp = await fetch(url.toString());
    const text = await resp.text();

    if (!resp.ok) {
        throw new Error(`timedtext xml HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    if (!text.trim()) {
        throw new Error('timedtext xml: empty body');
    }

    ytLog('timedtext response preview:', text.slice(0, 300));

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const texts = doc.getElementsByTagName('text');

    const lines: string[] = [];
    for (const el of Array.from(texts)) {
        const raw = el.textContent || '';
        const decoded = raw
            .replace(/<[^>]*>/gi, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\n/g, ' ')
            .trim();
        if (!decoded) continue;
        const start = Number(el.getAttribute('start') || '0');
        lines.push(`[${formatTimestamp(start)}] ${decoded}`);
    }

    if (lines.length === 0) throw new Error('timedtext xml: no <text> nodes');
    return lines;
}

async function fetchTranscriptJson3(baseUrl: string): Promise<string[]> {
    const url = new URL(baseUrl);
    url.searchParams.delete('fmt');
    url.searchParams.set('fmt', 'json3');

    const resp = await fetch(url.toString());
    const text = await resp.text();

    if (!resp.ok) {
        throw new Error(`timedtext json3 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    ytLog('json3 response preview:', text.slice(0, 300));

    const data = JSON.parse(text);
    const events = data.events || [];
    const lines = [];

    for (const event of events) {
        if (!event.segs || event.segs.length === 0) continue;
        const text = event.segs
            .map((seg: { utf8?: string }) => seg.utf8 || '')
            .join('')
            .replace(/\n/g, ' ')
            .trim();
        if (!text) continue;
        const ts = formatTimestamp((event.tStartMs || 0) / 1000);
        lines.push(`[${ts}] ${text}`);
    }

    if (lines.length === 0) throw new Error('timedtext json3: no segments');
    return lines;
}

/* ------------------------------------------------------------------ */
/*  6.  DOM panel scraping (last resort)                              */
/* ------------------------------------------------------------------ */

function querySelectorDeep(root: ParentNode | null, selector: string): Element | null {
    if (!root) return null;
    const el = root.querySelector(selector);
    if (el) return el;
    for (const h of root.querySelectorAll('*')) {
        if (h.shadowRoot) {
            const found = querySelectorDeep(h.shadowRoot, selector);
            if (found) return found;
        }
    }
    return null;
}

function querySelectorAllDeep(root: ParentNode | null, selector: string): Element[] {
    if (!root) return [];
    const out = Array.from(root.querySelectorAll(selector));
    for (const h of root.querySelectorAll('*')) {
        if (h.shadowRoot) out.push(...querySelectorAllDeep(h.shadowRoot, selector));
    }
    return out;
}

export function scrapeTranscriptFromDom(): string[] | null {
    // Old UI: ytd-transcript-body-renderer > ytd-transcript-segment-renderer
    const panel = querySelectorDeep(document, 'ytd-transcript-body-renderer');
    if (panel) {
        const segments = querySelectorAllDeep(panel, 'ytd-transcript-segment-renderer');
        const lines = [];
        for (const seg of segments) {
            const tsEl = querySelectorDeep(seg, '[class*="timestamp"]') || seg.querySelector('div:first-child');
            const textEl = querySelectorDeep(seg, '[class*="text"]') || seg.querySelector('yt-formatted-string');
            const ts = tsEl ? tsEl.textContent.trim() : '';
            const text = textEl ? textEl.textContent.trim() : seg.textContent.trim();
            if (!text) continue;
            lines.push(ts ? `[${ts}] ${text}` : text);
        }
        if (lines.length) return lines;
    }

    // New UI (2025+): transcript-segment-view-model inside the
    // "PAmodern_transcript_view" engagement panel (ytSpec/Lit stack).
    const modernPanel = querySelectorDeep(
        document,
        'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]'
    );
    const modernSegments = querySelectorAllDeep(
        modernPanel || document,
        'transcript-segment-view-model'
    );
    if (!modernSegments.length) return null;

    const lines = [];
    for (const seg of modernSegments) {
        const tsEl = seg.querySelector('.ytwTranscriptSegmentViewModelTimestamp');
        const textEl = seg.querySelector('span[role="text"]');
        const text = (textEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const ts = tsEl ? tsEl.textContent.trim() : '';
        lines.push(ts ? `[${ts}] ${text}` : text);
    }
    return lines.length ? lines : null;
}

/* ------------------------------------------------------------------ */
/*  6b. Open the transcript panel ourselves and scrape it            */
/* ------------------------------------------------------------------ */

const PANEL_POLL_INTERVAL_MS = 400;
const PANEL_OPEN_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/*  6a. Harvest transcript payloads from the page's command bus       */
/* ------------------------------------------------------------------ */

/**
 * YouTube's page fires `yt-action` CustomEvents as its UI command bus.
 * When a transcript panel opens/closes, `yt-engagement-panel-visible-changed`
 * carries the ENTIRE transcript as structured JSON in args[0].content —
 * even when the panel flashes open and auto-closes. Events cross content-
 * script world boundaries, so listening from the extension captures
 * transcript data whenever the page loads it, however it was triggered.
 */
let harvestedTranscript: string[] | null = null;
let harvestListenerAttached = false;

interface PanelContent {
    sectionListRenderer?: {
        contents?: {
            itemSectionRenderer?: {
                contents?: {
                    macroMarkersPanelItemViewModel?: {
                        item?: {
                            timelineItemViewModel?: {
                                timestamp?: string;
                                contentItems?: {
                                    transcriptSegmentViewModel?: { simpleText?: string };
                                }[];
                            };
                        };
                    };
                }[];
            };
        }[];
    };
}

export function parseTranscriptFromPanelContent(content: unknown): string[] | null {
    const items = (content as PanelContent)?.sectionListRenderer?.contents || [];
    const lines: string[] = [];
    for (const item of items) {
        const markers = item?.itemSectionRenderer?.contents || [];
        for (const mk of markers) {
            const tl = mk?.macroMarkersPanelItemViewModel?.item?.timelineItemViewModel;
            if (!tl) continue;
            const ts = tl.timestamp || '';
            const texts = (tl.contentItems || [])
                .map((ci) => ci?.transcriptSegmentViewModel?.simpleText || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (texts) lines.push(ts ? `[${ts}] ${texts}` : texts);
        }
    }
    return lines.length ? lines : null;
}

export function ensureTranscriptHarvestListener(): void {
    if (harvestListenerAttached) return;
    harvestListenerAttached = true;
    window.addEventListener(
        'yt-action',
        (event: Event) => {
            try {
                const d = (event as CustomEvent).detail as {
                    actionName?: string;
                    args?: { content?: unknown; panelIdentifier?: string }[];
                };
                if (d?.actionName !== 'yt-engagement-panel-visible-changed') return;
                const a = d.args?.[0];
                if (!a || !/transcript/i.test(String(a.panelIdentifier || ''))) return;
                const lines = parseTranscriptFromPanelContent(a.content);
                if (lines?.length) {
                    harvestedTranscript = lines;
                    ytTrace(`harvested ${lines.length} transcript lines from yt-action payload`);
                }
            } catch {
                // a listener must never throw into the page
            }
        },
        true
    );
}

// Attach as soon as the content script loads, so transcripts harvested from
// panel activity earlier in the session are available to later conversions.
if (typeof window !== 'undefined') {
    ensureTranscriptHarvestListener();
}

const TRANSCRIPT_PANEL_SELECTORS = [
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
];
const SEGMENT_SELECTORS = 'ytd-transcript-segment-renderer, transcript-segment-view-model';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTranscriptPanel(): HTMLElement | null {
    for (const selector of TRANSCRIPT_PANEL_SELECTORS) {
        const panel = querySelectorDeep(document, selector) as HTMLElement | null;
        if (panel) return panel;
    }
    return null;
}

export function findTranscriptTriggerButton(): HTMLElement | null {
    const section = querySelectorDeep(document, 'ytd-video-description-transcript-section-renderer');
    if (section) {
        const buttons = Array.from(section.querySelectorAll('button'));
        // Locale-tolerant label match ("Show transcript" / "Mostrar transcripción" / …)
        const labeled = buttons.find((b) =>
            /transcrip/i.test(`${b.textContent || ''} ${b.getAttribute('aria-label') || ''}`)
        );
        if (labeled) return labeled;
        if (buttons[0]) return buttons[0];
    }

    // Fallback: scan by label for layout variants without the section wrapper.
    for (const candidate of document.querySelectorAll('button')) {
        if (/transcrip/i.test(`${candidate.textContent || ''} ${candidate.getAttribute('aria-label') || ''}`)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Drive the page's own "Show transcript" UI: expand the description if
 * needed, click the transcript button, wait for segments to render, scrape
 * them, then restore the description/panel state we found. This uses the
 * page's attested transcript machinery, so it keeps working when raw
 * timedtext/get_transcript calls are rejected.
 */
export async function openTranscriptPanelAndScrape(): Promise<string[] | null> {
    ytLog('Trying to open the transcript panel in the page UI');

    const descriptionExpander = document.querySelector('#description-inline-expander');
    const wasDescriptionExpanded = descriptionExpander?.getAttribute('expanded') === 'true';
    const wasPanelVisible =
        getTranscriptPanel()?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';

    const restoreUiState = async () => {
        // The trigger button is a toggle; only close what we opened.
        if (!wasPanelVisible) {
            const panel = getTranscriptPanel();
            if (panel?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
                findTranscriptTriggerButton()?.dispatchEvent(new MouseEvent('click'));
                await sleep(400);
            }
        }
        if (!wasDescriptionExpanded) {
            document
                .querySelector<HTMLElement>('#description-inline-expander #collapse')
                ?.click();
        }
    };

    try {
        if (!wasDescriptionExpanded) {
            const expand = document.querySelector<HTMLElement>('#description-inline-expander #expand');
            if (expand) {
                ytLog('Expanding the video description to reach the transcript button');
                expand.click();
                await sleep(1000);
            }
        }

        const trigger = findTranscriptTriggerButton();
        if (!trigger) {
            ytTrace('no "Show transcript" button found in the page — panel path unavailable');
            return null;
        }

        if (!wasPanelVisible) {
            trigger.click();
            // Some button stacks ignore bare clicks; follow up with a full
            // synthetic pointer sequence shortly after.
            setTimeout(() => {
                try {
                    const rect = trigger.getBoundingClientRect();
                    const base = {
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        view: window,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2,
                        button: 0
                    };
                    trigger.dispatchEvent(
                        new PointerEvent('pointerdown', { ...base, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse' })
                    );
                    trigger.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
                    trigger.dispatchEvent(
                        new PointerEvent('pointerup', { ...base, buttons: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse' })
                    );
                    trigger.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, detail: 1 }));
                    trigger.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
                } catch {
                    // best-effort gesture; the plain click may already have worked
                }
            }, 150);
            trigger.scrollIntoView({ block: 'center' });
        }

        const deadline = Date.now() + PANEL_OPEN_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(PANEL_POLL_INTERVAL_MS);
            const segments = querySelectorAllDeep(document, SEGMENT_SELECTORS);
            if (segments.length > 0) {
                await sleep(600); // let the full segment list settle
                const lines = scrapeTranscriptFromDom();
                if (lines?.length) {
                    ytTrace(`panel scrape produced ${lines.length} lines`);
                    return lines;
                }
            }
            if (harvestedTranscript?.length) {
                ytTrace('using harvested yt-action transcript');
                return harvestedTranscript;
            }
        }

        ytTrace(
            `transcript panel did not populate within ${PANEL_OPEN_TIMEOUT_MS / 1000}s ` +
                `(final visibility: ${getTranscriptPanel()?.getAttribute('visibility') ?? 'none'})`
        );
        return null;
    } finally {
        await restoreUiState();
    }
}

/* ------------------------------------------------------------------ */
/*  7.  Metadata                                                      */
/* ------------------------------------------------------------------ */

function extractYouTubeMetadata(playerResponse: PlayerResponse | null): TranscriptMetadata {
    const vd = playerResponse?.videoDetails || {};
    const mi = playerResponse?.microformat?.playerMicroformatRenderer || {};
    return {
        title: vd.title || document.title || 'Untitled',
        author: vd.author || mi.ownerChannelName || '',
        source: 'youtube.com',
        url: window.location.href,
        domain: 'youtube.com',
        description: vd.shortDescription?.substring(0, 500) || '',
        publishedDate: mi.publishDate || '',
        tags: Array.isArray(vd.keywords) ? vd.keywords.slice(0, 10) : []
    };
}

/* ------------------------------------------------------------------ */
/*  8.  Main entry point                                              */
/* ------------------------------------------------------------------ */

export async function tryExtractYouTubeTranscript(): Promise<TranscriptResult> {
    if (!isYouTubeWatchPage()) {
        return { found: false, isYouTube: false, markdown: '', metadata: {} };
    }

    const videoId = getVideoId();
    if (!videoId) {
        return { found: false, isYouTube: true, markdown: '', metadata: {} };
    }

    await updateYtDebug();
    ensureTranscriptHarvestListener();
    ytLog('YouTube video ID:', videoId);

    let htmlCache: string | null = null;
    const getHtml = () => {
        if (htmlCache === null) htmlCache = document.documentElement.innerHTML;
        return htmlCache;
    };
    const apiKey = extractInnertubeApiKeyFromScripts() || extractInnertubeApiKey(getHtml());
    ytLog('API key:', apiKey ? 'found' : 'missing');

    let captionTracks: CaptionTrack[] | null = null;
    let playerResponse: PlayerResponse | null = null;

    /* -------------------------------------------------------------- */
    /*  1. PRIMARY: ANDROID client for FRESH tracks                   */
    /* -------------------------------------------------------------- */
    if (apiKey) {
        try {
            playerResponse = await fetchPlayerResponse(videoId, apiKey);
            captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
            ytLog('captionTracks from ANDROID player API:', captionTracks?.length ?? 'none');
        } catch (err) {
            ytTrace('ANDROID player API failed:', errorMessage(err));
        }
    }

    /* -------------------------------------------------------------- */
    /*  2. FALLBACK: Regex from raw HTML                              */
    /* -------------------------------------------------------------- */
    if (!captionTracks || captionTracks.length === 0) {
        try {
            const tracks = extractCaptionTracksFromHtml(getHtml());
            captionTracks = tracks ? tracks.filter((t) => isTrackForVideo(t, videoId)) : null;
            if (captionTracks) {
                ytLog('captionTracks from HTML regex:', captionTracks.length);
            }
        } catch (err) {
            ytTrace('HTML regex extract failed:', errorMessage(err));
        }
    }

    /* -------------------------------------------------------------- */
    /*  3. FALLBACK: DOM parse                                        */
    /* -------------------------------------------------------------- */
    if (!captionTracks || captionTracks.length === 0) {
        playerResponse = extractYtInitialPlayerResponseFromDom();
        if (playerResponse) {
            ytLog('ytInitialPlayerResponse parsed from DOM');
            const tracks =
                playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            captionTracks = tracks ? tracks.filter((t) => isTrackForVideo(t, videoId)) : null;
            if (captionTracks) {
                ytLog('captionTracks from DOM parse:', captionTracks.length);
            }
        }
    }

    /* -------------------------------------------------------------- */
    /*  4. Try to fetch transcript                                    */
    /* -------------------------------------------------------------- */
    let lines: string[] = [];

    if (captionTracks && captionTracks.length > 0) {
        const track = pickBestTrack(captionTracks);
        if (track?.baseUrl) {
            ytLog('Selected track:', track.languageCode, track.kind || 'manual');

            // Try XML
            try {
                lines = await fetchTranscriptXml(track.baseUrl);
                ytLog('XML fetch lines:', lines.length);
            } catch (err) {
                ytTrace(`timedtext ${track.languageCode} XML failed:`, errorMessage(err));
            }

            // Try JSON3
            if (lines.length === 0) {
                try {
                    lines = await fetchTranscriptJson3(track.baseUrl);
                    ytLog('JSON3 fetch lines:', lines.length);
                } catch (err) {
                    ytTrace('timedtext json3 failed:', errorMessage(err));
                }
            }
        } else {
            ytTrace('caption track had no baseUrl');
        }
    } else {
        ytTrace('no caption tracks found via player API or inline HTML');
    }

    /* -------------------------------------------------------------- */
    /*  5. LAST RESORT: Scrape visible transcript panel               */
    /* -------------------------------------------------------------- */
    if (lines.length === 0) {
        lines = scrapeTranscriptFromDom() || [];
    }

    /* -------------------------------------------------------------- */
    /*  6. LAST RESORT: Open the transcript panel ourselves and       */
    /*     scrape it (survives timedtext/get_transcript blocking)     */
    /* -------------------------------------------------------------- */
    if (lines.length === 0) {
        try {
            lines = (await openTranscriptPanelAndScrape()) || [];
        } catch (err) {
            ytTrace('Panel-driven transcript scrape failed:', errorMessage(err));
        }
    }

    if (lines.length === 0 && harvestedTranscript?.length) {
        ytTrace('using harvested yt-action transcript (post-panel-attempt)');
        lines = harvestedTranscript;
    }

    if (!lines || lines.length === 0) {
        ytTrace('all transcript extraction paths exhausted — giving up');
        return { found: false, isYouTube: true, markdown: '', metadata: {} };
    }

    /* -------------------------------------------------------------- */
    /*  7. Build markdown                                               */
    /* -------------------------------------------------------------- */
    const metadata = playerResponse
        ? extractYouTubeMetadata(playerResponse)
        : {
              title: document.title || 'Untitled',
              author: '',
              source: 'youtube.com',
              url: window.location.href,
              domain: 'youtube.com',
              description: '',
              publishedDate: '',
              tags: []
          };

    const body = lines.join('\n\n');
    const markdown = `# ${metadata.title}\n\n${body}`;

    return { found: true, isYouTube: true, markdown, metadata };
}
