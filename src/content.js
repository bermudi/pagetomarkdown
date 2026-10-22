import browser from 'webextension-polyfill';
import Defuddle from 'defuddle';
import { extractClaudeConversation } from './lib/claudeExtractor';
import { buildTableElement, parseCompressedTable } from './lib/compressedTables';
import {
    applyMermaidToDoc,
    createMermaidContext,
    rescueMissingDiagrams
} from './lib/mermaid';
import { extractRedditThread } from './lib/redditExtractor';
import { pruneNoiseElements } from './lib/noise';
import { detectLanguageForPre } from './lib/codeBlocks';
import { extractMetadata } from './lib/metadata';
import { createTurndownService } from './lib/turndownRules';
import { extractPoeConversation } from './lib/poeExtractor';
import { preserveActiveTabs } from './lib/tabState';
import { tryExtractYouTubeTranscript } from './lib/youtubeTranscript';

export class AdvancedMarkdownConverter {
    constructor() {
        this.turndown = null;
        this.debug = false;
        // Metadata only. The *content* never lives here — it is returned by
        // extractMainContent() as a single object.
        this.defuddleResult = null;
        this.options = { stripLinks: false, stripImages: false };
        this.metadataOverrides = null;

        this.turndown = createTurndownService({
            getOptions: () => this.options,
            log: (...args) => this.log(...args)
        });
        this.setupListeners();
    }

    setupListeners() {
        browser.runtime.onMessage.addListener((message) => {
            if (message?.action === 'trigger_conversion') {
                void this.processPage(message?.options);
            }
        });
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
        const prunedNoise = pruneNoiseElements(originalBodyClone, (...args) => this.log(...args));
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
        pruneNoiseElements(body, (...args) => this.log(...args));

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

            // Some generators compress a markdown table into a code block.
            // Repair it into a real table instead of shipping pipes.
            const compressed = parseCompressedTable(pre.textContent || '');
            if (compressed) {
                pre.replaceWith(buildTableElement(doc, compressed));
                continue;
            }

            const language = detectLanguageForPre(pre);

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

    cleanupMarkdown(markdown) {
        return markdown.replace(/\n{4,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
    }

    extractMetadata(content) {
        return extractMetadata({
            content,
            defuddleResult: this.defuddleResult,
            overrides: this.metadataOverrides
        });
    }

    sendToBackground(markdown, metadata) {
        return browser.runtime.sendMessage({
            type: 'DOWNLOAD_MARKDOWN',
            data: { markdown, metadata, options: this.options }
        });
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
