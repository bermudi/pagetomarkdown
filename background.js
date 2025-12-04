class MarkdownDownloader {
    constructor() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        browser.browserAction.onClicked.addListener(this.handleIconClick.bind(this));
        browser.runtime.onMessage.addListener(this.handleMessage.bind(this));
    }

    async handleIconClick(tab) {
        // Trigger the process within the content script
        browser.tabs.sendMessage(tab.id, {
            action: "trigger_conversion"
        }).catch(err => {
            console.error('Could not send message to content script. Try reloading the page.', err);
        });
    }

    async handleMessage(message, sender, sendResponse) {
        if (message.type === 'DOWNLOAD_MARKDOWN') {
            try {
                await this.downloadMarkdown(message.data);
                sendResponse({
                    success: true
                });
            } catch (error) {
                console.error('Download failed:', error);
                sendResponse({
                    success: false,
                    error: error.message
                });
            }
        }
    }

    async downloadMarkdown({ markdown, metadata }) {
        const filename = this.generateFilename(metadata);
        const frontmatter = this.generateFrontmatter(metadata);
        // Combine Frontmatter + Main Content
        const content = frontmatter + markdown;

        try {
            const blob = new Blob([content], {
                type: 'text/markdown;charset=utf-8'
            });
            const url = URL.createObjectURL(blob);

            await browser.downloads.download({
                url: url,
                filename: filename,
                saveAs: false,
                conflictAction: 'uniquify'
            });

            // Cleanup
            setTimeout(() => URL.revokeObjectURL(url), 10000);

        } catch (error) {
            throw new Error(`Download failed: ${error.message}`);
        }
    }

    generateFilename(metadata) {
        const title = metadata.title || 'untitled';
        const domain = metadata.domain || 'web-clipper';

        // Sanitize filename to be OS safe
        const sanitizedTitle = title
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // Remove invalid chars
            .replace(/\s+/g, ' ') // Collapse whitespace
            .trim()
            .substring(0, 100); // Limit length

        return `${sanitizedTitle} - ${domain}.md`;
    }

    generateFrontmatter(metadata) {
        const frontmatter = {
            title: metadata.title,
            url: metadata.url,
            domain: metadata.domain,
            date_saved: new Date().toISOString(),
            word_count: metadata.wordCount,
            reading_time: `${metadata.readingTime} min`
        };

        if (metadata.author) frontmatter.author = metadata.author;
        if (metadata.publishedDate) frontmatter.date_published = metadata.publishedDate;
        if (metadata.description) frontmatter.description = metadata.description;
        if (metadata.tags && metadata.tags.length > 0) frontmatter.tags = metadata.tags;

        // Convert object to YAML string
        const yamlContent = Object.entries(frontmatter)
            .map(([key, value]) => {
                if (Array.isArray(value)) {
                    return `${key}:\n${value.map(v => `  - "${v}"`).join('\n')}`;
                }
                // Escape double quotes in values
                const safeValue = String(value).replace(/"/g, '\\"');
                return `${key}: "${safeValue}"`;
            })
            .join('\n');

        return `---\n${yamlContent}\n---\n\n`;
    }
}

// Initialize
new MarkdownDownloader();