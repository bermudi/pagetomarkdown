import browser from 'webextension-polyfill';
import Defuddle from 'defuddle';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

class AdvancedMarkdownConverter {
    constructor() {
        this.turndown = null;
        this.debug = false;
        this.defuddleResult = null;
        this.defuddleHtml = null;
        this.codeBlocks = [];

        this.initializeConverter();
        this.setupListeners();
    }

    setupListeners() {
        browser.runtime.onMessage.addListener((message) => {
            if (message?.action === 'trigger_conversion') {
                void this.processPage();
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
                    markdown += `![${alt}](${src})\n`;
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
    }

    async processPage() {
        console.log('Starting conversion...');

        try {
            const content = this.extractMainContent();
            const metadata = this.extractMetadata();
            const markdown = this.convertToMarkdown(content);

            await this.sendToBackground(markdown, metadata);
            console.log('Conversion sent to background.');
        } catch (error) {
            console.error('Processing failed:', error);
            alert('Failed to convert page: ' + (error?.message ?? String(error)));
        }
    }

    extractMainContent() {
        try {
            this.log('Defuddle: parsing document');
            const defuddle = new Defuddle(document, { url: window.location.href });
            const result = defuddle.parse();
            this.defuddleResult = result;
            this.defuddleHtml = result?.content ?? null;

            if (result?.content) {
                const parsedDoc = new DOMParser().parseFromString(result.content, 'text/html');
                return parsedDoc.body || parsedDoc.documentElement;
            }
        } catch (error) {
            console.warn('Defuddle failed, falling back to manual extraction:', error);
        }

        console.log('Using body fallback');
        return document.body.cloneNode(true);
    }

    convertToMarkdown(contentElement) {
        if (!this.turndown) throw new Error('Turndown not initialized');

        const firstPre = contentElement.querySelector('pre');
        this.log('Turndown: starting conversion', {
            preCount: contentElement.querySelectorAll('pre').length,
            codeCount: contentElement.querySelectorAll('code').length,
            firstPreSnippet: firstPre ? (firstPre.textContent || '').trim().slice(0, 140) : null
        });

        const sourceHtml = this.defuddleHtml || contentElement.innerHTML || '';
        this.log('convertToMarkdown: sourceHtml length', {
            length: sourceHtml.length,
            usingDefuddleHtml: !!this.defuddleHtml,
            hasPreTag: sourceHtml.includes('<pre')
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

        const pres = Array.from(body.querySelectorAll('pre'));
        this.log('normalizeContentHtml: found PRE elements in source HTML', { count: pres.length });

        for (const pre of pres) {
            const language = this.detectLanguageForPre(pre);

            let codeText = pre.textContent || '';
            codeText = codeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            codeText = codeText.replace(/\u00A0/g, ' ');
            codeText = codeText.replace(/\n+$/g, '');

            pre.innerHTML = '';
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

    captureAndReplaceCodeBlocks(contentElement) {
        this.codeBlocks = [];

        const clone = contentElement.cloneNode(true);
        const pres = Array.from(clone.querySelectorAll('pre'));

        pres.forEach((pre, index) => {
            const codeElement = pre.querySelector('code');
            const language = codeElement ? this.detectLanguage(codeElement) : '';
            const code = (codeElement?.textContent ?? pre.textContent ?? '').trim();
            if (!code) return;

            const placeholder = `PAGETOMDCODEBLOCK${index}`;
            this.codeBlocks.push({ placeholder, language, code });

            const p = clone.ownerDocument.createElement('p');
            p.textContent = placeholder;
            pre.replaceWith(p);
        });

        return clone;
    }

    restoreCodeBlocks(markdown) {
        if (!this.codeBlocks.length) return markdown;

        let result = markdown;
        let replacedTotal = 0;

        for (const block of this.codeBlocks) {
            const fence = this.computeFence(block.code);
            const langSuffix = block.language ? block.language : '';
            const fenced = `\n\n${fence}${langSuffix}\n${block.code}\n${fence}\n\n`;

            const placeholderRe = new RegExp(`\\b${block.placeholder}\\b`, 'g');
            const occurrences = (result.match(placeholderRe) || []).length;
            if (occurrences === 0) {
                this.log('restoreCodeBlocks: placeholder not found', { placeholder: block.placeholder });
                continue;
            }

            replacedTotal += occurrences;
            result = result.replace(placeholderRe, fenced);
        }

        this.log('restoreCodeBlocks: applied', { blocks: this.codeBlocks.length, replacedTotal });
        return result;
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

    extractMetadata() {
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

        const text = doc.body.textContent || '';
        metadata.wordCount = def?.wordCount ?? text.trim().split(/\s+/).length;
        metadata.readingTime = Math.ceil(metadata.wordCount / 200);

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
            data: { markdown, metadata }
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

window.markdownConverter = new AdvancedMarkdownConverter();
