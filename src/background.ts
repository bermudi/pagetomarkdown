import browser from 'webextension-polyfill';

import type { PageMetadata } from './lib/metadata';
import type { ConversionOptions } from './lib/turndownRules';
import { isDownloadRequest } from './lib/protocol';

export class MarkdownDownloader {
    constructor() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        const nativeBrowser = globalThis.browser;
        const onClicked =
            nativeBrowser?.browserAction?.onClicked ??
            nativeBrowser?.action?.onClicked ??
            browser.action?.onClicked ??
            browser.browserAction?.onClicked;
        if (onClicked) {
            onClicked.addListener(this.handleIconClick.bind(this));
        }

        const menus = nativeBrowser?.contextMenus ?? browser.contextMenus;
        if (menus?.create && menus?.onClicked) {
            // Non-persistent MV2 background re-runs on every wake while the
            // menu items persist, so duplicate-id failures are harmless.
            const create = (props: Parameters<typeof browser.contextMenus.create>[0]) =>
                Promise.resolve(menus.create(props)).catch(() => {});
            void create({
                id: 'save-page-as-markdown',
                title: 'Save as Markdown',
                contexts: ['all']
            });
            void create({
                id: 'save-page-as-markdown-plain',
                title: 'Save as Markdown (no links)',
                contexts: ['all']
            });
            menus.onClicked.addListener((info, tab) => {
                if (tab?.id == null) return;
                if (info?.menuItemId === 'save-page-as-markdown') {
                    void this.sendConversion(tab, { stripLinks: false, stripImages: false });
                } else if (info?.menuItemId === 'save-page-as-markdown-plain') {
                    void this.sendConversion(tab, { stripLinks: true, stripImages: true });
                }
            });
        }

        browser.runtime.onMessage.addListener(this.handleMessage.bind(this));
    }

    async getDefaultStripLinks() {
        try {
            const result = await browser.storage.local.get('defaultStripLinks');
            return result.defaultStripLinks ?? false;
        } catch {
            return false;
        }
    }

    async handleIconClick(tab: browser.tabs.Tab, onClickData?: browser.browserAction.OnClickData) {
        const modifiers = onClickData?.modifiers ?? [];
        const shiftHeld = Array.isArray(modifiers) && modifiers.includes('Shift');
        const defaultStripLinks = await this.getDefaultStripLinks();
        const stripLinks = shiftHeld ? !defaultStripLinks : defaultStripLinks;

        await this.sendConversion(tab, { stripLinks, stripImages: stripLinks });
    }

    async sendConversion(tab: browser.tabs.Tab, { stripLinks, stripImages }: ConversionOptions) {
        if (tab.id == null) return;
        await browser.tabs
            .sendMessage(tab.id, {
                action: 'trigger_conversion',
                options: { stripLinks, stripImages }
            })
            .catch((err: unknown) => {
                console.error('Could not send message to content script. Try reloading the page.', err);
            });
    }

    handleMessage(message: unknown) {
        if (!isDownloadRequest(message)) return;

        return this.downloadMarkdown(message.data)
            .then(() => ({ success: true }))
            .catch((error) => {
                console.error('Download failed:', error);
                return { success: false, error: error?.message ?? String(error) };
            });
    }

    async downloadMarkdown({ markdown, metadata, options }: {
        markdown: string;
        metadata: Partial<PageMetadata>;
        options: Partial<ConversionOptions>;
    }): Promise<void> {
        const filename = this.generateFilename(metadata);
        const frontmatter = this.generateFrontmatter(metadata, options);
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
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Download failed: ${message}`);
        }
    }

    generateFilename(metadata: Partial<PageMetadata>): string {
        const title = metadata?.title || 'untitled';
        const domain = metadata?.domain || 'web-clipper';

        const sanitizedTitle = title
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 100);

        return `${sanitizedTitle} - ${domain}.md`;
    }

    generateFrontmatter(metadata: Partial<PageMetadata>, options?: Partial<ConversionOptions>): string {
        const llmMode = !!options?.stripLinks;
        const frontmatter: Record<string, unknown> = {
            title: metadata?.title,
            author: metadata?.author,
            source: metadata?.source,
            url: metadata?.url,
            date_saved: new Date().toISOString()
        };

        if (metadata?.publishedDate) frontmatter.date_published = metadata.publishedDate;

        if (!llmMode) {
            frontmatter.word_count = metadata?.wordCount;
            frontmatter.reading_time = `${metadata?.readingTime} min`;
            if (metadata?.description) frontmatter.description = metadata.description;
            if (metadata?.tags && metadata.tags.length > 0) frontmatter.tags = metadata.tags;
        }

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

if (typeof window !== 'undefined' && !globalThis.__vitest_worker__) {
    new MarkdownDownloader();
}
