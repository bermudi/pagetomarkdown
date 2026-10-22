/**
 * Noise removal: the parts of a page that a reader never sees but a
 * markdown converter happily copies.
 *
 * The extractor works on a detached clone, so only attributes and inline
 * styles can be inspected — class-driven hiding (`sr-only`, Tailwind
 * `hidden`) cannot be computed here.
 */

// Links whose only destination is a share/bookmark endpoint carry no article
// content (issue #24: Hackaday's share icons leaked into the markdown).
const SHARE_HREF_PATTERN =
    /facebook\.com\/shar|(?:twitter\.com|x\.com)\/(?:intent|share)|linkedin\.com\/shar|reddit\.com\/submit|news\.ycombinator\.com\/submitlink|pinterest\.[a-z.]+\/pin\/create|bsky\.app\/intent|(?:api\.)?whatsapp\.com\/send|wa\.me\/|(?:t|telegram)\.me\/share|buffer(?:app)?\.com\/add|mailto:\s*\?/i;

// Tracking pixels / analytics beacons. Defuddle's small-image pass needs
// layout dimensions a detached clone doesn't have, so these survive unless
// we match them ourselves.
const TRACKER_IMG_PATTERN = new RegExp(
    [
        '\\/\\/[^/?#]*(?:analytics|metrics|telemetry|beacon|stats|track|pixel|impression)[.-]',
        'trackingservlet',
        'google-analytics\\.com',
        'googletagmanager\\.com',
        'doubleclick\\.',
        'scorecardresearch\\.com',
        'quantserve\\.',
        'clarity\\.ms',
        'bat\\.bing\\.com',
        'facebook\\.com\\/tr',
        '\\/(?:pixel|beacon|collect|impression|spacer|1x1|track|tracking|pageview)(?:\\.[a-z0-9]{2,5}|[/?#]|$)'
    ].join('|'),
    'i'
);

// Share-widget containers defuddle's blocklist doesn't cover (it has
// 'sharing_' but not bare 'sharing', and nothing for share dialogs).
const SHARE_WIDGET_SELECTOR = [
    '[class~="sharing"]',
    '[class~="share-menu"]',
    '[id="share-menu"]',
    '[class~="share-dialog"]',
    '[class~="share-dialog-content"]',
    '[class~="social-sharing"]',
    '[class~="post-share"]',
    '[class~="entry-share"]',
    '[class~="share-buttons"]',
    '[class*="addtoany"]',
    '[class*="addthis"]',
    '[class*="sharethis"]',
    '[class*="shareaholic"]'
].join(',');

// Elements that can be dropped once share links/trackers leave them empty.
// Anything with media descendants or real text is kept.
const EMPTIABLE_SELECTOR = 'li, ul, ol, i, span, p, div, form, section, aside';
const CONTENT_BEARING_SELECTOR =
    'img, svg, video, audio, iframe, canvas, object, embed, pre, code, table, figure, math, mjx-container, input, select, textarea, hr';

export function pruneNoiseElements(root, log = () => {}) {
        const emptyCounts = {
            hidden: 0,
            ariaHidden: 0,
            skipLinks: 0,
            templates: 0,
            trackers: 0,
            shareWidgets: 0,
            shareLinks: 0,
            emptied: 0
        };
        if (!root) return emptyCounts;

        const counts = { ...emptyCounts };
        // KaTeX/MathJax mark their *rendered* output aria-hidden; stripping it
        // would destroy math. The check walks all ancestors because real math
        // trees nest aria-hidden spans with generic classes.
        const mathish = /(^|[\s_-])(katex|mathjax|mjx|latex|math)([\s_-]|$)/i;
        const isMathSubtree = (el) => {
            for (let anc = el; anc && anc !== root; anc = anc.parentElement) {
                if (mathish.test(anc.getAttribute?.('class') || '')) return true;
                if (/^mjx-/i.test(anc.tagName || '')) return true;
            }
            return false;
        };

        root.querySelectorAll('template').forEach((el) => {
            el.remove();
            counts.templates += 1;
        });

        root.querySelectorAll('[hidden]').forEach((el) => {
            el.remove();
            counts.hidden += 1;
        });

        root.querySelectorAll('[style]').forEach((el) => {
            const style = (el.getAttribute('style') || '').replace(/url\([^)]*\)/gi, '');
            if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(style)) {
                el.remove();
                counts.hidden += 1;
            }
        });

        // aria-hidden marks content invisible to screen readers, not to
        // sighted users. Modal implementations (react-aria, Bootstrap) flip
        // aria-hidden on the whole page wrapper behind a dialog – removing
        // that would delete the real content. So: keep math trees, and keep
        // any aria-hidden subtree that holds most of the page's text.
        const totalTextLength = (root.textContent || '').length;
        root.querySelectorAll('[aria-hidden="true"]').forEach((el) => {
            if (isMathSubtree(el)) return;
            const share = totalTextLength > 0 ? (el.textContent || '').length / totalTextLength : 0;
            if (share > 0.5) return;
            el.remove();
            counts.ariaHidden += 1;
        });

        root.querySelectorAll('a').forEach((el) => {
            const text = (el.textContent || '').trim();
            if (/^skip to (the )?(main )?content$/i.test(text)) {
                el.remove();
                counts.skipLinks += 1;
            }
        });

        // Tracking pixels and analytics beacon images. Dimension checks
        // catch classic 1x1 bugs; src/class patterns catch the rest.
        root.querySelectorAll('img').forEach((el) => {
            const src = [
                el.getAttribute('src'),
                el.getAttribute('data-src'),
                el.getAttribute('srcset'),
                el.getAttribute('data-srcset')
            ]
                .filter(Boolean)
                .join(' ');
            const width = Number.parseInt(el.getAttribute('width') || '', 10);
            const height = Number.parseInt(el.getAttribute('height') || '', 10);
            const style = el.getAttribute('style') || '';
            const tinyDeclared =
                (width > 0 && width <= 2) ||
                (height > 0 && height <= 2) ||
                /(?:width|height)\s*:\s*[012]px\b/i.test(style);
            const trackerClass =
                /(?:^|[\s_.-])(?:track|tracker|beacon|pixel|analytics|impression)/i.test(
                    `${el.getAttribute('class') || ''} ${el.id || ''}`
                ) && !(el.getAttribute('alt') || '').trim();

            if (tinyDeclared || TRACKER_IMG_PATTERN.test(src) || trackerClass) {
                el.remove();
                counts.trackers += 1;
            }
        });

        // Share widgets: containers that only exist to repost the page.
        root.querySelectorAll(SHARE_WIDGET_SELECTOR).forEach((el) => {
            el.remove();
            counts.shareWidgets += 1;
        });

        // Links to share/bookmark endpoints, regardless of container markup.
        root.querySelectorAll('a[href]').forEach((el) => {
            if (SHARE_HREF_PATTERN.test(el.getAttribute('href') || '')) {
                el.remove();
                counts.shareLinks += 1;
            }
        });

        // Removing the links above leaves wrappers like <ul><li><i></i></li>
        // </ul> that would emit stray "-" bullets. Sweep emptied containers,
        // outermost passes first so nested shells collapse.
        for (let pass = 0; pass < 4; pass += 1) {
            let removedThisPass = 0;
            root.querySelectorAll(EMPTIABLE_SELECTOR).forEach((el) => {
                if (!root.contains(el)) return;
                if ((el.textContent || '').trim() === '' && !el.querySelector(CONTENT_BEARING_SELECTOR)) {
                    el.remove();
                    removedThisPass += 1;
                }
            });
            counts.emptied += removedThisPass;
            if (removedThisPass === 0) break;
        }

        const total =
            counts.hidden +
            counts.ariaHidden +
            counts.skipLinks +
            counts.templates +
            counts.trackers +
            counts.shareWidgets +
            counts.shareLinks +
            counts.emptied;
        if (total > 0) {
            log('pruneNoiseElements removed', counts);
        }
        return counts;
}
