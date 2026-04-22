/**
 * YouTube transcript extraction.
 *
 * Pipeline (reordered based on observed behavior):
 *   1. POST youtubei/v1/player with ANDROID client → fresh playerResponse
 *      with non-expired caption track URLs.
 *   2. Fetch transcript XML from the fresh track's baseUrl.
 *   3. Fallback: regex-extract captionTracks from inline HTML.
 *   4. Fallback: scrape visible transcript panel from DOM.
 */

const YT_WATCH_RE = /^https?:\/\/(www\.)?youtube\.com\/watch\?/;

export function isYouTubeWatchPage() {
    return YT_WATCH_RE.test(window.location.href);
}

function getVideoId() {
    return new URL(window.location.href).searchParams.get('v') || '';
}

/* ------------------------------------------------------------------ */
/*  1.  Inline HTML helpers (fallback only)                           */
/* ------------------------------------------------------------------ */

function extractInnertubeApiKey(html) {
    const m = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/);
    return m?.[1] || '';
}

function extractCaptionTracksFromHtml(html) {
    const parts = html.split('"captions":');
    if (parts.length < 2) return null;
    const jsonPart = parts[1].split(',"videoDetails')[0].replace('\n', '');
    if (!jsonPart) return null;
    try {
        const renderer = JSON.parse(jsonPart).playerCaptionsTracklistRenderer;
        if (!renderer?.captionTracks) return null;
        return renderer.captionTracks.map((t) => ({
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

function extractYtInitialPlayerResponseFromDom() {
    for (const script of document.querySelectorAll('script')) {
        const text = script.textContent || '';
        if (!text.includes('ytInitialPlayerResponse')) continue;

        let idx = text.indexOf('var ytInitialPlayerResponse');
        if (idx !== -1) {
            const eq = text.indexOf('=', idx);
            if (eq !== -1) {
                let depth = 0;
                let inStr = false;
                let esc = false;
                let start = eq + 1;
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

async function fetchPlayerResponse(videoId, apiKey) {
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

function pickBestTrack(tracks, preferredLang = 'auto') {
    if (!tracks || tracks.length === 0) return null;
    const byTwo = (code) => code.toLowerCase().slice(0, 2);

    if (preferredLang !== 'auto') {
        const exact = tracks.find((t) => t.languageCode === preferredLang);
        if (exact) return exact;
        const fuzzy = tracks.find((t) => byTwo(t.languageCode) === byTwo(preferredLang));
        if (fuzzy) return fuzzy;
    }

    if (preferredLang === 'auto') {
        const enTracks = tracks.filter((t) => byTwo(t.languageCode) === 'en');
        const manualEn = enTracks.find((t) => t.kind !== 'asr');
        if (manualEn) return manualEn;
        const autoEn = enTracks.find((t) => t.kind === 'asr');
        if (autoEn) return autoEn;
    }

    for (const lang of LANG_FALLBACK_CHAIN) {
        const match = tracks.find((t) => byTwo(t.languageCode) === lang);
        if (match) return match;
    }

    return tracks[0];
}

/* ------------------------------------------------------------------ */
/*  4.  Timestamp formatting                                          */
/* ------------------------------------------------------------------ */

function formatTimestamp(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, '0');
    if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`;
    return `${mins}:${pad(secs)}`;
}

/* ------------------------------------------------------------------ */
/*  5.  Transcript fetch with debugging                               */
/* ------------------------------------------------------------------ */

async function fetchTranscriptXml(baseUrl) {
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

    // Log first 300 chars so we can see what came back
    console.log('[PageToMD] timedtext response preview:', text.slice(0, 300));

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const texts = doc.getElementsByTagName('text');

    const lines = [];
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

async function fetchTranscriptJson3(baseUrl) {
    const url = new URL(baseUrl);
    url.searchParams.delete('fmt');
    url.searchParams.set('fmt', 'json3');

    const resp = await fetch(url.toString());
    const text = await resp.text();

    if (!resp.ok) {
        throw new Error(`timedtext json3 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    console.log('[PageToMD] json3 response preview:', text.slice(0, 300));

    const data = JSON.parse(text);
    const events = data.events || [];
    const lines = [];

    for (const event of events) {
        if (!event.segs || event.segs.length === 0) continue;
        const text = event.segs
            .map((seg) => seg.utf8 || '')
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

function querySelectorDeep(root, selector) {
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

function querySelectorAllDeep(root, selector) {
    if (!root) return [];
    const out = Array.from(root.querySelectorAll(selector));
    for (const h of root.querySelectorAll('*')) {
        if (h.shadowRoot) out.push(...querySelectorAllDeep(h.shadowRoot, selector));
    }
    return out;
}

function scrapeTranscriptFromDom() {
    const panel = querySelectorDeep(document, 'ytd-transcript-body-renderer');
    if (!panel) return null;

    const segments = querySelectorAllDeep(panel, 'ytd-transcript-segment-renderer');
    if (!segments.length) return null;

    const lines = [];
    for (const seg of segments) {
        const tsEl = querySelectorDeep(seg, '[class*="timestamp"]') || seg.querySelector('div:first-child');
        const textEl = querySelectorDeep(seg, '[class*="text"]') || seg.querySelector('yt-formatted-string');
        const ts = tsEl ? tsEl.textContent.trim() : '';
        const text = textEl ? textEl.textContent.trim() : seg.textContent.trim();
        if (!text) continue;
        lines.push(ts ? `[${ts}] ${text}` : text);
    }

    if (lines.length) {
        console.log(`[PageToMD] Scraped ${lines.length} lines from DOM panel`);
        return lines;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/*  7.  Metadata                                                      */
/* ------------------------------------------------------------------ */

function extractYouTubeMetadata(playerResponse) {
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

export async function tryExtractYouTubeTranscript() {
    if (!isYouTubeWatchPage()) {
        return { found: false, isYouTube: false, markdown: '', metadata: {} };
    }

    const videoId = getVideoId();
    if (!videoId) {
        return { found: false, isYouTube: true, markdown: '', metadata: {} };
    }

    console.log('[PageToMD] YouTube video ID:', videoId);

    const apiKey = extractInnertubeApiKey(document.documentElement.innerHTML);
    console.log('[PageToMD] API key:', apiKey ? 'found' : 'missing');

    let captionTracks = null;
    let playerResponse = null;

    /* -------------------------------------------------------------- */
    /*  1. PRIMARY: ANDROID client for FRESH tracks                   */
    /* -------------------------------------------------------------- */
    if (apiKey) {
        try {
            playerResponse = await fetchPlayerResponse(videoId, apiKey);
            captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            console.log('[PageToMD] captionTracks from ANDROID player API:', captionTracks?.length ?? 'none');
        } catch (err) {
            console.warn('[PageToMD] ANDROID player API failed:', err);
        }
    }

    /* -------------------------------------------------------------- */
    /*  2. FALLBACK: Regex from raw HTML                              */
    /* -------------------------------------------------------------- */
    if (!captionTracks || captionTracks.length === 0) {
        try {
            captionTracks = extractCaptionTracksFromHtml(document.documentElement.innerHTML);
            if (captionTracks) {
                console.log('[PageToMD] captionTracks from HTML regex:', captionTracks.length);
            }
        } catch (err) {
            console.warn('[PageToMD] HTML regex extract failed:', err);
        }
    }

    /* -------------------------------------------------------------- */
    /*  3. FALLBACK: DOM parse                                        */
    /* -------------------------------------------------------------- */
    if (!captionTracks || captionTracks.length === 0) {
        playerResponse = extractYtInitialPlayerResponseFromDom();
        if (playerResponse) {
            console.log('[PageToMD] ytInitialPlayerResponse parsed from DOM');
            captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (captionTracks) {
                console.log('[PageToMD] captionTracks from DOM parse:', captionTracks.length);
            }
        }
    }

    /* -------------------------------------------------------------- */
    /*  4. Try to fetch transcript                                    */
    /* -------------------------------------------------------------- */
    let lines = [];

    if (captionTracks && captionTracks.length > 0) {
        const track = pickBestTrack(captionTracks, 'auto');
        if (track?.baseUrl) {
            console.log('[PageToMD] Selected track:', track.languageCode, track.kind || 'manual');

            // Try XML
            try {
                lines = await fetchTranscriptXml(track.baseUrl);
                console.log('[PageToMD] XML fetch lines:', lines.length);
            } catch (err) {
                console.warn('[PageToMD] XML fetch failed:', err);
            }

            // Try JSON3
            if (lines.length === 0) {
                try {
                    lines = await fetchTranscriptJson3(track.baseUrl);
                    console.log('[PageToMD] JSON3 fetch lines:', lines.length);
                } catch (err) {
                    console.warn('[PageToMD] JSON3 fetch failed:', err);
                }
            }
        }
    }

    /* -------------------------------------------------------------- */
    /*  5. LAST RESORT: Scrape visible transcript panel               */
    /* -------------------------------------------------------------- */
    if (lines.length === 0) {
        lines = scrapeTranscriptFromDom();
    }

    if (!lines || lines.length === 0) {
        console.log('[PageToMD] No transcript available for this YouTube video');
        return { found: false, isYouTube: true, markdown: '', metadata: {} };
    }

    /* -------------------------------------------------------------- */
    /*  6. Build markdown                                               */
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
