import browser from 'webextension-polyfill';
import Defuddle from 'defuddle';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { extractClaudeConversation } from './lib/claudeExtractor';
import {
    applyMermaidToDoc,
    createMermaidContext,
    rescueMissingDiagrams
} from './lib/mermaid';
import { extractRedditThread } from './lib/redditExtractor';
import { extractPoeConversation } from './lib/poeExtractor';
import { preserveActiveTabs } from './lib/tabState';
import { tryExtractYouTubeTranscript } from './lib/youtubeTranscript';

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

export class AdvancedMarkdownConverter {
    constructor() {
        this.turndown = null;
        this.debug = false;
        // Metadata only. The *content* never lives here — it is returned by
        // extractMainContent() as a single object.
        this.defuddleResult = null;
        this.options = { stripLinks: false, stripImages: false };
        this.metadataOverrides = null;

        this.initializeConverter();
        this.setupListeners();
    }

    setupListeners() {
        browser.runtime.onMessage.addListener((message) => {
            if (message?.action === 'trigger_conversion') {
                void this.processPage(message?.options);
            }
        });
    }

    initializeConverter() {
        this.turndown = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            fence: '```',
            preformattedCode: true,
            emDelimiter: '*',
            strongDelimiter: '**',
            linkStyle: 'inlined'
        });

        if (gfm) {
            this.turndown.use(gfm);
        }

        this.addCustomRules();
    }

    addCustomRules() {
        const self = this;

        this.turndown.addRule('stripLinks', {
            filter: (node) => self.options.stripLinks && node.nodeName === 'A',
            replacement: (content) => content
        });

        this.turndown.addRule('stripImages', {
            filter: (node) => self.options.stripImages && node.nodeName === 'IMG',
            replacement: (_content, node) => {
                const alt = (node.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
                if (!alt) return '';
                return `(Image: ${alt})`;
            }
        });

        this.turndown.addRule('preformattedCode', {
            filter: (node) => {
                const match = node.nodeName === 'PRE';
                if (match) {
                    self.log('preformattedCode: filter matched PRE node');
                }
                return match;
            },
            replacement: (_content, node) => {
                self.log('preformattedCode: replacement called');
                const codeElement = node.querySelector('code');
                const language = codeElement ? self.detectLanguage(codeElement) : '';
                const code = (codeElement?.textContent ?? node.textContent ?? '').trim();

                if (!code) {
                    self.log('preformattedCode: empty code block skipped');
                    return '';
                }

                const fence = self.computeFence(code);
                const langSuffix = language ? language : '';
                const result = `\n\n${fence}${langSuffix}\n${code}\n${fence}\n\n`;
                self.log('preformattedCode: returning fenced block', { codeLen: code.length, lang: langSuffix });

                return result;
            }
        });

        this.prioritizeRule('preformattedCode');

        this.turndown.addRule('inlineCode', {
            filter: (node) => node.nodeName === 'CODE' && (!node.parentNode || node.parentNode.nodeName !== 'PRE'),
            replacement: (_content, node) => {
                const code = node.textContent || '';
                if (!code) return '';
                if (code.includes('`')) {
                    return '``' + code + '``';
                }
                return '`' + code + '`';
            }
        });

        this.turndown.addRule('cleanHeadings', {
            filter: (node) => /^H[1-6]$/.test(node.nodeName),
            replacement: (_content, node) => {
                const level = Number.parseInt(node.nodeName.substring(1), 10);
                const hashes = '#'.repeat(level);
                const text = node.textContent.trim();
                return `\n\n${hashes} ${text}\n\n`;
            }
        });

        this.turndown.addRule('headingLinks', {
            filter: (node) => {
                if (/^H[1-6]$/.test(node.nodeName)) {
                    const anchors = Array.from(node.querySelectorAll(':scope > a'));
                    if (anchors.length === 1) return true;

                    const nonWhitespaceChildren = Array.from(node.childNodes).filter(
                        (n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent.trim())
                    );
                    if (nonWhitespaceChildren.length === 1 && nonWhitespaceChildren[0].nodeName === 'A') {
                        return true;
                    }
                }
                return false;
            },
            replacement: (_content, node) => {
                const level = Number.parseInt(node.nodeName.substring(1), 10);
                const hashes = '#'.repeat(level);
                const text = node.textContent.trim();
                return `\n\n${hashes} ${text}\n\n`;
            }
        });

        this.turndown.addRule('linkedHeadings', {
            filter: (node) => node.nodeName === 'A' && !!node.querySelector('h1, h2, h3, h4, h5, h6'),
            replacement: (_content, node) => {
                const heading = node.querySelector('h1, h2, h3, h4, h5, h6');
                const level = heading ? Number.parseInt(heading.nodeName.substring(1), 10) : 1;
                const hashes = '#'.repeat(level);
                const text = (heading ? heading.textContent : node.textContent || '').trim();
                return `\n\n${hashes} ${text}\n\n`;
            }
        });

        this.prioritizeRule('cleanHeadings');
        this.prioritizeRule('headingLinks');
        this.prioritizeRule('linkedHeadings');

        this.turndown.addRule('figure', {
            filter: 'figure',
            replacement: (content, node) => {
                const img = node.querySelector('img');
                const caption = node.querySelector('figcaption');

                let markdown = '';
                if (img) {
                    const alt = img.getAttribute('alt') || '';
                    const src = img.getAttribute('src') || '';
                    if (self.options.stripImages) {
                        const safeAlt = String(alt).trim().replace(/\s+/g, ' ');
                        if (safeAlt) {
                            markdown += `(Image: ${safeAlt})\n`;
                        }
                    } else {
                        markdown += `![${alt}](${src})\n`;
                    }
                }
                if (caption) {
                    markdown += `*${caption.textContent.trim()}*\n`;
                }

                // Include any other converted content (e.g., code blocks inside figure)
                if (content && content.trim()) {
                    markdown += content.trim() + '\n';
                }

                return markdown + '\n';
            }
        });

        this.turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'footer', 'nav']);

        this.prioritizeRule('stripLinks');
        this.prioritizeRule('stripImages');
    }

    async processPage(options) {
        try {
            const debugResult = await browser.storage.local.get('debugLogging');
            this.debug = !!debugResult.debugLogging;
        } catch {
            this.debug = false;
        }
        this.log('Starting conversion...');

        this.metadataOverrides = null;
        this.options = {
            stripLinks: !!options?.stripLinks,
            stripImages: !!options?.stripImages
        };

        try {
            const yt = await tryExtractYouTubeTranscript();
            if (yt.found) {
                await this.sendToBackground(yt.markdown, yt.metadata);
                this.log('YouTube transcript sent to background.');
                return;
            }
            if (yt.isYouTube) {
                alert(
                    'Could not get the transcript automatically.\n\n' +
                        'Open the transcript panel yourself (…more in the description → "Show transcript"), then run Save as Markdown again.'
                );
                return;
            }

            const content = this.extractMainContent();
            const metadata = this.extractMetadata(content);
            const markdown = this.convertToMarkdown(content);

            await this.sendToBackground(markdown, metadata);
            this.log('Conversion sent to background.');
        } catch (error) {
            console.error('Processing failed:', error);
            alert('Failed to convert page: ' + (error?.message ?? String(error)));
        }
    }


    /**
     * Pick the content to convert.
     *
     * Returns one object that describes *what we ship*: the DOM element
     * (used for word counts) and the exact HTML that goes through turndown.
     * Both always describe the same thing — the previous design kept the
     * element and the HTML in two separate places, and the two could
     * disagree (which is how page chrome ended up in files whose frontmatter
     * described a much smaller document).
     *
     * @returns {{element: Element, html: string, kind: string, wordCount?: number}}
     */
    extractMainContent() {
        const claudeConversation = extractClaudeConversation(document);
        if (claudeConversation?.article) {
            this.log('Using Claude conversation extractor');
            this.metadataOverrides = claudeConversation.metadataOverrides ?? null;
            this.defuddleResult = null;
            return {
                element: claudeConversation.article,
                html: claudeConversation.article.outerHTML || '',
                kind: 'claude'
            };
        }

        const poeConversation = extractPoeConversation(document);
        if (poeConversation?.article) {
            this.log('Using Poe conversation extractor');
            this.metadataOverrides = poeConversation.metadataOverrides ?? null;
            this.defuddleResult = null;
            return {
                element: poeConversation.article,
                html: poeConversation.article.innerHTML || '',
                kind: 'poe'
            };
        }

        const redditThread = extractRedditThread(document);
        if (redditThread?.article) {
            this.log('Using Reddit thread extractor');
            this.metadataOverrides = redditThread.metadataOverrides ?? null;
            this.defuddleResult = null;
            return {
                element: redditThread.article,
                html: redditThread.article.outerHTML || '',
                kind: 'reddit'
            };
        }

        const originalBodyClone = document.body.cloneNode(true);
        const tabStateResult = this.preserveInteractiveState(originalBodyClone);
        const prunedNoise = this.pruneNoiseElements(originalBodyClone);
        const originalPreCount = originalBodyClone.querySelectorAll('pre').length;

        try {
            this.log('Defuddle: parsing document');
            const defuddleInput = this.createDocumentForDefuddle(originalBodyClone);
            const defuddle = new Defuddle(defuddleInput, { url: window.location.href });
            const result = defuddle.parse();
            this.defuddleResult = result;
            this.log('Interactive-state preprocessing complete', { ...tabStateResult, prunedNoise });

            const parsedBody = this.parseContentFragment(result?.content);
            if (parsedBody && this.isSubstantiveExtraction(parsedBody, originalBodyClone)) {
                const parsedPreCount = parsedBody.querySelectorAll('pre').length;

                if (this.shouldFallbackToOriginalCodeBlocks(originalBodyClone, parsedBody)) {
                    console.warn('[PageToMD] Defuddle removed code blocks – falling back to page DOM');
                    this.log('Hybrid fallback triggered', { originalPreCount, parsedPreCount });
                    return {
                        element: originalBodyClone,
                        html: originalBodyClone.innerHTML || '',
                        kind: 'body-fallback'
                    };
                }

                return {
                    element: parsedBody,
                    html: parsedBody.innerHTML || '',
                    kind: 'defuddle',
                    // Defuddle counts the very selection we ship — and does it
                    // better than a whitespace split (it counts CJK per
                    // character).
                    wordCount: result?.wordCount
                };
            }

            this.log('Defuddle content missing or too thin – using body fallback', {
                hadContent: !!result?.content,
                extractedTextLength: (parsedBody?.textContent || '').trim().length,
                bodyTextLength: (originalBodyClone.textContent || '').trim().length,
                prunedNoise
            });
        } catch (error) {
            console.warn('Defuddle failed, falling back to manual extraction:', error);
        }

        this.log('Using body fallback');
        return {
            element: originalBodyClone,
            html: originalBodyClone.innerHTML || '',
            kind: 'body-fallback'
        };
    }

    shouldFallbackToOriginalCodeBlocks(originalBody, parsedBody) {
        const originalPreCount = originalBody ? originalBody.querySelectorAll('pre').length : 0;
        if (originalPreCount === 0) {
            return false;
        }

        const parsedPreCount = parsedBody ? parsedBody.querySelectorAll('pre').length : 0;
        if (parsedPreCount >= originalPreCount) {
            return false;
        }

        // Only abandon defuddle's selection when real code blocks were lost;
        // trivial <pre> remnants are not worth a full-page fallback.
        return this.hasMeaningfulCodeBlocks(originalBody) && !this.hasMeaningfulCodeBlocks(parsedBody);
    }

    parseContentFragment(html) {
        if (!html) return null;
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return doc.body || doc.documentElement;
        } catch (error) {
            console.warn('[PageToMD] Failed to parse defuddle content', error);
            return null;
        }
    }

    /**
     * Defuddle occasionally returns an empty or near-empty selection on
     * SPA-style pages (chat transcripts, dashboards) whose content lives in
     * anonymous markup. Treat that as an extraction failure so the caller
     * falls back to the noise-pruned page body instead of shipping an
     * almost empty document.
     */
    isSubstantiveExtraction(parsedBody, originalBody) {
        const extractedLength = (parsedBody?.textContent || '').replace(/\s+/g, '').length;
        if (extractedLength >= 64) return true;

        // A tiny page has nothing more to offer; trust defuddle regardless.
        const bodyLength = (originalBody?.textContent || '').replace(/\s+/g, '').length;
        return bodyLength < 512;
    }

    /**
     * Remove elements that are invisible to users but very visible to
     * turndown: screen-reader live regions, skip links, hidden templates.
     * Only attributes and inline styles are inspected – the clone is
     * detached from the document, so class-driven hiding (sr-only etc.)
     * cannot be computed here.
     */
    pruneNoiseElements(root) {
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
            this.log('pruneNoiseElements removed', counts);
        }
        return counts;
    }

    preserveInteractiveState(root) {
        if (!root) {
            return { tablistsProcessed: 0, panelsRemoved: 0 };
        }

        try {
            return preserveActiveTabs(root);
        } catch (error) {
            console.warn('[PageToMD] Failed to preserve interactive state', error);
            return { tablistsProcessed: 0, panelsRemoved: 0 };
        }
    }

    createDocumentForDefuddle(bodyClone) {
        const doc = document.implementation.createHTMLDocument(document.title || 'Page to Markdown');

        const sourceHead = document.head;
        if (sourceHead) {
            for (const node of Array.from(sourceHead.childNodes)) {
                doc.head.appendChild(node.cloneNode(true));
            }
        }

        if (bodyClone) {
            for (const node of Array.from(bodyClone.childNodes)) {
                doc.body.appendChild(node.cloneNode(true));
            }
        }

        return doc;
    }

    hasMeaningfulCodeBlocks(root) {
        if (!root) return false;
        return Array.from(root.querySelectorAll('pre')).some((pre) => {
            const codeEl = pre.querySelector('code');
            const text = (codeEl?.textContent ?? pre.textContent ?? '').trim();
            return text.length > 10;
        });
    }

    convertToMarkdown(content) {
        if (!this.turndown) throw new Error('Turndown not initialized');

        const element = content?.element;
        const sourceHtml = content?.html ?? '';

        this.log('Turndown: starting conversion', {
            kind: content?.kind,
            preCount: element?.querySelectorAll('pre').length ?? 0,
            codeCount: element?.querySelectorAll('code').length ?? 0,
            sourceHtmlLength: sourceHtml.length
        });

        const normalizedHtml = this.normalizeContentHtml(sourceHtml);

        const markdown = this.turndown.turndown(normalizedHtml);
        const cleaned = this.cleanupMarkdown(markdown);

        this.log('Turndown: conversion done', {
            length: cleaned.length
        });

        return cleaned;
    }

    normalizeContentHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const body = doc.body || doc.documentElement;

        // Defuddle's output can still contain share widgets and tracking
        // pixels (its blocklist and small-image pass miss them).
        this.pruneNoiseElements(body);

        // Mermaid sources can live in the selected content or only in the
        // page's own payload (Next.js/SPA pages ship the original markdown
        // inside RSC <script> payloads that defuddle strips). Pool both.
        const pageHtml =
            typeof document !== 'undefined' && document.body
                ? document.body.innerHTML || ''
                : '';
        const ctx = createMermaidContext(`${html}\n${pageHtml}`);

        const mermaidStats = applyMermaidToDoc(doc, ctx);
        // Diagrams the extractor dropped (the SVG lived outside the selected
        // container) are recovered from the page instead of shipping the
        // whole page as a fallback.
        const rescueStats = rescueMissingDiagrams({
            liveDoc: typeof document !== 'undefined' ? document : null,
            selectionDoc: doc,
            ctx
        });

        if (mermaidStats.svgSeen || mermaidStats.garbageRecovered || rescueStats.injected) {
            this.log('normalizeContentHtml: mermaid preprocessing', {
                ...mermaidStats,
                rescued: rescueStats.injected
            });
        }

        const pres = Array.from(body.querySelectorAll('pre'));
        this.log('normalizeContentHtml: found PRE elements in source HTML', { count: pres.length });

        for (const pre of pres) {
            if (!body.contains(pre)) continue;

            const language = this.detectLanguageForPre(pre);

            const existingCodeElement = pre.querySelector('code');
            let codeText = (existingCodeElement?.textContent ?? pre.textContent ?? '');
            const candidateInnerText = (existingCodeElement?.innerText ?? pre.innerText ?? '');
            if (candidateInnerText && !codeText.includes('\n') && candidateInnerText.includes('\n')) {
                codeText = candidateInnerText;
            }

            codeText = codeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            codeText = codeText.replace(/\u00A0/g, ' ');
            codeText = codeText.replace(/\n+$/g, '');

            while (pre.firstChild) {
                pre.removeChild(pre.firstChild);
            }
            const code = doc.createElement('code');
            if (language) {
                code.setAttribute('data-lang', language);
                code.setAttribute('class', `language-${language}`);
            }
            code.textContent = codeText;
            pre.appendChild(code);
        }

        const result = body.innerHTML;
        const firstPreMatch = result.match(/<pre[^>]*>[\s\S]{0,300}/);
        this.log('normalizeContentHtml: first <pre> snippet after normalization', {
            snippet: firstPreMatch ? firstPreMatch[0] : 'NO <pre> FOUND IN OUTPUT'
        });

        return result;
    }

    detectLanguageForPre(pre) {
        const codeElement = pre.querySelector('code');
        if (codeElement) {
            return this.detectLanguage(codeElement);
        }

        const dataLang = pre.getAttribute('data-lang') || pre.getAttribute('data-language');
        if (dataLang) return dataLang;

        const preClass = pre.className || '';
        const match = preClass.match(/language-(\w+)/) || preClass.match(/lang-(\w+)/);
        if (match) return match[1];

        return '';
    }

    cleanupMarkdown(markdown) {
        return markdown.replace(/\n{4,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
    }

    computeFence(code) {
        const matches = code.match(/`+/g) || [];
        const max = matches.reduce((acc, m) => Math.max(acc, m.length), 0);
        return '`'.repeat(Math.max(3, max + 1));
    }

    detectLanguage(codeElement) {
        let lang = codeElement.getAttribute('data-lang');
        if (lang) return lang;

        lang = codeElement.getAttribute('data-language');
        if (lang) return lang;

        const className = codeElement.className || '';
        let match = className.match(/language-(\w+)/);
        if (match) return match[1];

        match = className.match(/lang-(\w+)/);
        if (match) return match[1];

        const parentPre = codeElement.closest('pre');
        if (parentPre) {
            lang = parentPre.getAttribute('data-lang') || parentPre.getAttribute('data-language');
            if (lang) return lang;

            const preClass = parentPre.className || '';
            match = preClass.match(/language-(\w+)/) || preClass.match(/lang-(\w+)/);
            if (match) return match[1];
        }

        return '';
    }

    /**
     * @param {{element: Element, kind: string, wordCount?: number}} content
     */
    extractMetadata(content) {
        const doc = document;

        const def = this.defuddleResult;

        const titleFromMeta = this.getMeta(['og:title', 'twitter:title']);
        const sourceFromMeta = this.getMeta(['og:site_name', 'twitter:site', 'application-name']);
        const descriptionFromMeta = this.getMeta(['og:description', 'twitter:description', 'description']);
        const authorFromMeta = this.getMeta(['author', 'article:author', 'twitter:creator']);

        const metadata = {
            title: def?.title || titleFromMeta || doc.title || 'Untitled',
            url: window.location.href,
            domain: def?.domain || window.location.hostname.replace('www.', ''),
            source: sourceFromMeta || def?.siteName || def?.site || def?.publication || def?.domain || window.location.hostname.replace('www.', ''),
            description: def?.description || descriptionFromMeta,
            author: def?.author || authorFromMeta,
            publishedDate: def?.published || this.getMeta(['article:published_time']),
            tags: this.extractTags(),
            wordCount: 0,
            readingTime: 0
        };

        // Count what we actually ship — the selection, not the live document
        // with all of its chrome. Defuddle's own count describes exactly the
        // selection we ship (and counts CJK per character, better than a
        // whitespace split); when we fell back to the page body we count the
        // body ourselves.
        const element = content?.element || doc.body;
        const text = (element?.textContent || '') || '';
        metadata.wordCount = Number.isFinite(content?.wordCount)
            ? content.wordCount
            : (text.trim() ? text.trim().split(/\s+/).length : 0);
        metadata.readingTime = Math.ceil(metadata.wordCount / 200);

        if (this.metadataOverrides) {
            for (const [key, value] of Object.entries(this.metadataOverrides)) {
                if (value == null) continue;
                if (key === 'tags' && Array.isArray(value)) {
                    metadata.tags = value.slice(0, 10);
                    continue;
                }
                metadata[key] = value;
            }
        }

        return metadata;
    }

    getMeta(names) {
        for (const name of names) {
            const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
            if (el && el.content) return el.content.trim();
        }
        return null;
    }

    extractTags() {
        const tags = new Set();
        const keywords = document.querySelector('meta[name="keywords"]');
        if (keywords && keywords.content) {
            keywords.content.split(',').forEach((t) => tags.add(t.trim()));
        }

        document.querySelectorAll('.tags a, a[rel="tag"]').forEach((el) => {
            tags.add(el.textContent.trim());
        });

        return Array.from(tags).slice(0, 10);
    }

    sendToBackground(markdown, metadata) {
        return browser.runtime.sendMessage({
            type: 'DOWNLOAD_MARKDOWN',
            data: { markdown, metadata, options: this.options }
        });
    }

    prioritizeRule(name) {
        const rulesArray = this.turndown.rules.array;
        const index = rulesArray.findIndex((rule) => rule.key === name);
        if (index > 0) {
            const [rule] = rulesArray.splice(index, 1);
            rulesArray.unshift(rule);
        }
    }

    log(...args) {
        if (this.debug) {
            console.log('[PageToMD]', ...args);
        }
    }
}

if (typeof window !== 'undefined' && !globalThis.__vitest_worker__) {
    window.markdownConverter = new AdvancedMarkdownConverter();
}
