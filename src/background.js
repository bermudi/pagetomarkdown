import browser from 'webextension-polyfill';

class MarkdownDownloader {
    constructor() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        const onClicked = browser.action?.onClicked ?? browser.browserAction?.onClicked;
        if (onClicked) {
            onClicked.addListener(this.handleIconClick.bind(this));
        }

        browser.runtime.onMessage.addListener(this.handleMessage.bind(this));
    }

    async handleIconClick(tab) {
        await browser.tabs
            .sendMessage(tab.id, {
                action: 'trigger_conversion'
            })
            .catch((err) => {
                console.error('Could not send message to content script. Try reloading the page.', err);
            });
    }

    handleMessage(message) {
        if (message?.type !== 'DOWNLOAD_MARKDOWN') return;

        return this.downloadMarkdown(message.data)
            .then(() => ({ success: true }))
            .catch((error) => {
                console.error('Download failed:', error);
                return { success: false, error: error?.message ?? String(error) };
            });
    }

    async downloadMarkdown({ markdown, metadata }) {
        const filename = this.generateFilename(metadata);
        const frontmatter = this.generateFrontmatter(metadata);
        const title = metadata?.title ? String(metadata.title).trim() : '';
        const markdownStart = (markdown ?? '').replace(/^\s+/, '');
        const startsWithHeading = /^#{1,6}\s+\S/.test(markdownStart);
        const titleBlock = title && !startsWithHeading ? `# ${title}\n\n` : '';
        const content = frontmatter + titleBlock + (markdown ?? '');

        try {
            const blob = new Blob([content], {
                type: 'text/markdown;charset=utf-8'
            });
            const url = URL.createObjectURL(blob);

            await browser.downloads.download({
                url,
                filename,
                saveAs: false,
                conflictAction: 'uniquify'
            });

            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (error) {
            throw new Error(`Download failed: ${error?.message ?? String(error)}`);
        }
    }

    generateFilename(metadata) {
        const title = metadata?.title || 'untitled';
        const domain = metadata?.domain || 'web-clipper';

        const sanitizedTitle = title
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 100);

        return `${sanitizedTitle} - ${domain}.md`;
    }

    generateFrontmatter(metadata) {
        const frontmatter = {
            title: metadata?.title,
            author: metadata?.author,
            source: metadata?.source,
            url: metadata?.url,
            date_saved: new Date().toISOString(),
            word_count: metadata?.wordCount,
            reading_time: `${metadata?.readingTime} min`
        };

        if (metadata?.publishedDate) frontmatter.date_published = metadata.publishedDate;
        if (metadata?.description) frontmatter.description = metadata.description;
        if (metadata?.tags && metadata.tags.length > 0) frontmatter.tags = metadata.tags;

        const yamlContent = Object.entries(frontmatter)
            .map(([key, value]) => {
                if (value === undefined || value === null || value === '') return null;
                if (Array.isArray(value)) {
                    return `${key}:\n${value.map((v) => `  - "${v}"`).join('\n')}`;
                }

                const safeValue = String(value).replace(/"/g, '\\"');
                return `${key}: "${safeValue}"`;
            })
            .filter(Boolean)
            .join('\n');

        return `---\n${yamlContent}\n---\n\n`;
    }
}

new MarkdownDownloader();
