class AdvancedMarkdownConverter {
    constructor() {
        this.turndown = null;
        this.initializeConverter();
        this.setupListeners();
    }

    setupListeners() {
        browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === "trigger_conversion") {
                this.processPage();
            }
        });
    }

    initializeConverter() {
        if (typeof TurndownService === 'undefined') {
            console.error('TurndownService is not defined! Check manifest libraries.');
            return;
        }

        this.turndown = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            fence: '```',
            emDelimiter: '*',
            strongDelimiter: '**',
            linkStyle: 'inlined'
        });

        // Add GitHub Flavored Markdown (GFM) tables if the plugin is available
        // Note: You need to add turndown-plugin-gfm.js to lib/ and manifest for this to work
        if (typeof turndownPluginGfm !== 'undefined') {
            this.turndown.use(turndownPluginGfm.gfm);
        }

        this.addCustomRules();
    }

    addCustomRules() {
        // Better code blocks
        this.turndown.addRule('codeBlock', {
            filter: ['pre'],
            replacement: (content, node) => {
                const code = node.querySelector('code');
                let language = '';
                if (code) {
                    const className = code.className || '';
                    const match = className.match(/language-(\w+)/);
                    if (match) language = match[1];
                }
                return `\n\`\`\`${language}\n${node.textContent.trim()}\n\`\`\`\n\n`;
            }
        });

        // Handle Figures/Captions
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
                return markdown + '\n';
            }
        });

        // Remove scripts, styles, etc
        this.turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'footer', 'nav']);
    }

    async processPage() {
        console.log("Starting conversion...");
        try {
            const content = this.extractMainContent();
            const metadata = this.extractMetadata();
            const markdown = this.convertToMarkdown(content);

            await this.sendToBackground(markdown, metadata);
            console.log("Conversion sent to background.");

        } catch (error) {
            console.error('Processing failed:', error);
            alert("Failed to convert page: " + error.message);
        }
    }

    extractMainContent() {
        // 1. Try Readability
        if (typeof Readability !== 'undefined') {
            try {
                const documentClone = document.implementation.createHTMLDocument();
                const clonedNode = document.documentElement.cloneNode(true);
                documentClone.documentElement.replaceWith(clonedNode);

                const reader = new Readability(documentClone, {
                    charThreshold: 100,
                    keepClasses: true // Keep classes for code blocks
                });
                const article = reader.parse();

                if (article && article.content) {
                    const parser = new DOMParser();
                    const parsedDoc = parser.parseFromString(article.content, 'text/html');
                    // Prefer body for content; fall back to documentElement if needed
                    return parsedDoc.body || parsedDoc.documentElement;
                }
            } catch (error) {
                console.warn('Readability failed, falling back to manual extraction:', error);
            }
        }

        // 2. Fallback: Copy Body
        console.log("Using body fallback");
        return document.body.cloneNode(true);
    }

    convertToMarkdown(contentElement) {
        if (!this.turndown) throw new Error('Turndown not initialized');

        let markdown = this.turndown.turndown(contentElement.innerHTML);
        return this.cleanupMarkdown(markdown);
    }

    cleanupMarkdown(markdown) {
        return markdown
            .replace(/\n{4,}/g, '\n\n') // Max 2 empty lines
            .replace(/[ \t]+$/gm, '')   // Trim trailing spaces
            .trim();
    }

    extractMetadata() {
        const doc = document;
        const metadata = {
            title: this.getMeta(['og:title', 'twitter:title']) || doc.title || 'Untitled',
            url: window.location.href,
            domain: window.location.hostname.replace('www.', ''),
            description: this.getMeta(['og:description', 'twitter:description', 'description']),
            author: this.getMeta(['author', 'article:author', 'twitter:creator']),
            publishedDate: this.getMeta(['article:published_time']),
            tags: this.extractTags(),
            wordCount: 0,
            readingTime: 0
        };

        // Calculate Reading stats
        const text = doc.body.textContent || '';
        metadata.wordCount = text.trim().split(/\s+/).length;
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
            keywords.content.split(',').forEach(t => tags.add(t.trim()));
        }
        // Try finding WP style tags
        document.querySelectorAll('.tags a, a[rel="tag"]').forEach(el => {
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
}

// Initialize
window.markdownConverter = new AdvancedMarkdownConverter();