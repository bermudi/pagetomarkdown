import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock webextension-polyfill before importing the module under test
vi.mock('webextension-polyfill', () => ({
    default: {
        storage: { local: { get: async () => ({ debugLogging: false }) } }
    }
}));

import {
    pickBestTrack,
    isTrackForVideo,
    scrapeTranscriptFromDom,
    findTranscriptTriggerButton,
    openTranscriptPanelAndScrape,
    parseTranscriptFromPanelContent
} from './youtubeTranscript.js';

const VIDEO_URL = (id) => `https://www.youtube.com/api/timedtext?v=${id}&lang=en&signature=abc`;

function makePanelWithSegments(cues) {
    const panel = document.createElement('ytd-transcript-body-renderer');
    for (const { ts, text } of cues) {
        const seg = document.createElement('ytd-transcript-segment-renderer');
        const tsEl = document.createElement('div');
        tsEl.className = 'timestamp';
        tsEl.textContent = ts;
        const textEl = document.createElement('yt-formatted-string');
        textEl.className = 'segment-text';
        textEl.textContent = text;
        seg.append(tsEl, textEl);
        panel.append(seg);
    }
    document.body.append(panel);
    return panel;
}

describe('pickBestTrack', () => {
    it('prefers a manual English track over an auto-generated one', () => {
        const auto = { languageCode: 'en', kind: 'asr', baseUrl: VIDEO_URL('a') };
        const manual = { languageCode: 'en', kind: '', baseUrl: VIDEO_URL('a') };
        expect(pickBestTrack([auto, manual])).toBe(manual);
    });

    it('falls back to auto-generated English', () => {
        const auto = { languageCode: 'en', kind: 'asr', baseUrl: VIDEO_URL('a') };
        const german = { languageCode: 'de', kind: '', baseUrl: VIDEO_URL('a') };
        expect(pickBestTrack([german, auto])).toBe(auto);
    });

    it('walks the language fallback chain', () => {
        const russian = { languageCode: 'ru', baseUrl: VIDEO_URL('a') };
        const german = { languageCode: 'de-DE', baseUrl: VIDEO_URL('a') };
        expect(pickBestTrack([russian, german])).toBe(german);
    });

    it('returns the first track when nothing matches', () => {
        const only = { languageCode: 'sv', baseUrl: VIDEO_URL('a') };
        expect(pickBestTrack([only])).toBe(only);
    });

    it('returns null for empty input', () => {
        expect(pickBestTrack([])).toBeNull();
        expect(pickBestTrack(null)).toBeNull();
    });
});

describe('isTrackForVideo', () => {
    it('accepts a track whose URL matches the video id', () => {
        expect(isTrackForVideo({ baseUrl: VIDEO_URL('abc123DEF-g') }, 'abc123DEF-g')).toBe(true);
    });

    it('rejects a track for a different video (stale SPA data)', () => {
        expect(isTrackForVideo({ baseUrl: VIDEO_URL('otherVideo11') }, 'abc123DEF-g')).toBe(false);
    });

    it('keeps tracks whose URL has no v param', () => {
        expect(isTrackForVideo({ baseUrl: 'https://www.youtube.com/api/timedtext?lang=en' }, 'x')).toBe(true);
    });

    it('rejects missing baseUrl or videoId', () => {
        expect(isTrackForVideo({}, 'x')).toBe(false);
        expect(isTrackForVideo({ baseUrl: VIDEO_URL('x') }, '')).toBe(false);
    });
});

describe('scrapeTranscriptFromDom', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('collects timestamped lines from a rendered panel', () => {
        makePanelWithSegments([
            { ts: '0:02', text: 'Hello world' },
            { ts: '0:05', text: 'Second line' }
        ]);
        expect(scrapeTranscriptFromDom()).toEqual(['[0:02] Hello world', '[0:05] Second line']);
    });

    it('collects lines from the modern transcript panel (PAmodern_transcript_view)', () => {
        const panel = document.createElement('ytd-engagement-panel-section-list-renderer');
        panel.setAttribute('target-id', 'PAmodern_transcript_view');

        const seg1 = document.createElement('transcript-segment-view-model');
        const ts1 = document.createElement('div');
        ts1.className = 'ytwTranscriptSegmentViewModelTimestamp';
        ts1.textContent = '0:00';
        const a11y1 = document.createElement('div');
        a11y1.className = 'ytwTranscriptSegmentViewModelTimestampA11yLabel';
        a11y1.textContent = '0 segundos';
        const text1 = document.createElement('span');
        text1.setAttribute('role', 'text');
        text1.textContent = 'Hey everybody, welcome back.';
        seg1.append(ts1, a11y1, text1);

        const seg2 = document.createElement('transcript-segment-view-model');
        const ts2 = document.createElement('div');
        ts2.className = 'ytwTranscriptSegmentViewModelTimestamp ytwTranscriptSegmentViewModelTimestampActive';
        ts2.textContent = '0:07';
        const text2 = document.createElement('span');
        text2.setAttribute('role', 'text');
        text2.textContent = '  Second   cue  ';
        seg2.append(ts2, text2);

        panel.append(seg1, seg2);
        document.body.append(panel);

        expect(scrapeTranscriptFromDom()).toEqual([
            '[0:00] Hey everybody, welcome back.',
            '[0:07] Second cue'
        ]);
    });

    it('returns null when no panel exists', () => {
        expect(scrapeTranscriptFromDom()).toBeNull();
    });
});

describe('findTranscriptTriggerButton', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('finds the button inside the description transcript section', () => {
        const section = document.createElement('ytd-video-description-transcript-section-renderer');
        const button = document.createElement('button');
        button.textContent = 'Show transcript';
        section.append(button);
        document.body.append(section);
        expect(findTranscriptTriggerButton()).toBe(button);
    });

    it('falls back to label matching without the section wrapper', () => {
        const button = document.createElement('button');
        button.textContent = '  Show Transcript  ';
        document.body.append(button);
        expect(findTranscriptTriggerButton()).toBe(button);
    });

    it('returns null when nothing matches', () => {
        expect(findTranscriptTriggerButton()).toBeNull();
    });
});

describe('openTranscriptPanelAndScrape', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function setupPage({ segments }) {
        // Collapsed description with expand/collapse buttons
        const expander = document.createElement('div');
        expander.id = 'description-inline-expander';
        expander.setAttribute('expanded', 'false');
        const expand = document.createElement('button');
        expand.id = 'expand';
        const collapse = document.createElement('button');
        collapse.id = 'collapse';
        expander.append(expand, collapse);

        // Transcript trigger section (only "exists" once expanded)
        const section = document.createElement('ytd-video-description-transcript-section-renderer');
        const trigger = document.createElement('button');
        trigger.textContent = 'Show transcript';
        section.append(trigger);

        // Engagement panel
        const panel = document.createElement('ytd-engagement-panel-section-list-renderer');
        panel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
        panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
        const body = document.createElement('ytd-transcript-body-renderer');
        panel.append(body);

        document.body.append(expander, section, panel);

        // Wire the fake YouTube UI: expand reveals trigger, trigger toggles panel
        expand.addEventListener('click', () => expander.setAttribute('expanded', 'true'));
        collapse.addEventListener('click', () => expander.setAttribute('expanded', 'false'));
        trigger.addEventListener('click', () => {
            const open = panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
            panel.setAttribute(
                'visibility',
                open ? 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN' : 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
            );
            if (!open && segments) {
                setTimeout(() => makeSegmentsIn(body, segments), 300);
            }
        });

        return { expander, panel };
    }

    function makeSegmentsIn(body, cues) {
        for (const { ts, text } of cues) {
            const seg = document.createElement('ytd-transcript-segment-renderer');
            const tsEl = document.createElement('div');
            tsEl.className = 'timestamp';
            tsEl.textContent = ts;
            const textEl = document.createElement('yt-formatted-string');
            textEl.className = 'segment-text';
            textEl.textContent = text;
            seg.append(tsEl, textEl);
            body.append(seg);
        }
    }

    it('opens the panel, scrapes the transcript and restores the UI state', async () => {
        const { expander, panel } = setupPage({
            segments: [
                { ts: '0:01', text: 'First cue' },
                { ts: '0:04', text: 'Second cue' }
            ]
        });

        const promise = openTranscriptPanelAndScrape();
        // Drive the poll loop forward
        await vi.advanceTimersByTimeAsync(3000);
        const lines = await promise;

        expect(lines).toEqual(['[0:01] First cue', '[0:04] Second cue']);
        // Panel closed again and description collapsed again
        expect(panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
        expect(expander.getAttribute('expanded')).toBe('false');
    });

    it('leaves an already-open panel open', async () => {
        const { panel } = setupPage({ segments: [{ ts: '0:01', text: 'Cue' }] });
        panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
        makeSegmentsIn(panel.querySelector('ytd-transcript-body-renderer'), [{ ts: '0:01', text: 'Cue' }]);

        const promise = openTranscriptPanelAndScrape();
        await vi.advanceTimersByTimeAsync(2000);
        const lines = await promise;

        expect(lines).toEqual(['[0:01] Cue']);
        expect(panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    });

    it('gives up after the timeout and restores the UI', async () => {
        const { expander, panel } = setupPage({ segments: null });

        const promise = openTranscriptPanelAndScrape();
        await vi.advanceTimersByTimeAsync(20000);
        const lines = await promise;

        expect(lines).toBeNull();
        expect(panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
        expect(expander.getAttribute('expanded')).toBe('false');
    });
});

describe('parseTranscriptFromPanelContent (yt-action payload)', () => {
    it('extracts timestamped lines from a real captured payload shape', () => {
        const content = {
            sectionListRenderer: {
                contents: [
                    {
                        itemSectionRenderer: {
                            contents: [
                                {
                                    macroMarkersPanelItemViewModel: {
                                        item: {
                                            timelineItemViewModel: {
                                                timestamp: '0:00',
                                                contentItems: [
                                                    {
                                                        transcriptSegmentViewModel: {
                                                            simpleText: 'Hey everybody, welcome back.',
                                                            timestamp: '0:00'
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                },
                                {
                                    macroMarkersPanelItemViewModel: {
                                        item: {
                                            timelineItemViewModel: {
                                                timestamp: '0:07',
                                                contentItems: [
                                                    {
                                                        transcriptSegmentViewModel: {
                                                            simpleText: '  Second   cue  ',
                                                            timestamp: '0:07'
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                }
                            ]
                        }
                    }
                ]
            }
        };
        expect(parseTranscriptFromPanelContent(content)).toEqual([
            '[0:00] Hey everybody, welcome back.',
            '[0:07] Second cue'
        ]);
    });

    it('returns null for empty or malformed content', () => {
        expect(parseTranscriptFromPanelContent(null)).toBeNull();
        expect(parseTranscriptFromPanelContent({})).toBeNull();
        expect(parseTranscriptFromPanelContent({ sectionListRenderer: { contents: [] } })).toBeNull();
    });
});
