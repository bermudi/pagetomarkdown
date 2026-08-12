import { describe, it, expect, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: { local: { get: async () => ({}) } },
    runtime: { onMessage: { addListener: () => {} } },
    browserAction: { onClicked: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } },
    tabs: { sendMessage: async () => {} },
    downloads: { download: async () => {} },
  },
}));

import { MarkdownDownloader } from './background.js';

describe('MarkdownDownloader', () => {
  const downloader = new MarkdownDownloader();

  describe('generateFilename', () => {
    it('sanitizes unsafe characters and limits to 100 chars', () => {
      const longTitle = 'a'.repeat(150) + ' <bad>:"/\\|?*';
      const filename = downloader.generateFilename({ title: longTitle, domain: 'example.com' });
      expect(filename.endsWith(' - example.com.md')).toBe(true);
      const titlePart = filename.replace(' - example.com.md', '');
      expect(titlePart.length).toBeLessThanOrEqual(100);
      expect(titlePart).not.toMatch(/[<>:"/\\|?*]/);
    });

    it('handles trailing dots and spaces via trim', () => {
      const filename = downloader.generateFilename({ title: 'Hello World.  ', domain: 'example.com' });
      expect(filename).toBe('Hello World. - example.com.md');
      expect(filename).not.toContain('  -');
    });

    it('collapses whitespace', () => {
      const filename = downloader.generateFilename({ title: 'Hello   \n\t  World', domain: 'test.org' });
      expect(filename).toBe('Hello World - test.org.md');
    });

    it('falls back to untitled', () => {
      const filename = downloader.generateFilename({ domain: 'example.com' });
      expect(filename).toBe('untitled - example.com.md');
    });

    it('handles 100-char boundary exactly', () => {
      const title100 = 'a'.repeat(100);
      const filename = downloader.generateFilename({ title: title100, domain: 'example.com' });
      const titlePart = filename.replace(' - example.com.md', '');
      expect(titlePart.length).toBe(100);
      const title101 = 'a'.repeat(101);
      const filename2 = downloader.generateFilename({ title: title101, domain: 'example.com' });
      const titlePart2 = filename2.replace(' - example.com.md', '');
      expect(titlePart2.length).toBe(100);
    });
  });

  describe('generateFrontmatter', () => {
    it('escapes quotes in title and description', () => {
      const fm = downloader.generateFrontmatter(
        {
          title: 'He said \"hello\"',
          description: 'Desc with \"quotes\" and \\ backslash',
          url: 'https://example.com/',
          domain: 'example.com',
          wordCount: 100,
          readingTime: 1,
          tags: ['a', 'b'],
        },
        {}
      );
      expect(fm).toContain('He said');
      expect(fm).toContain('hello');
      expect(fm).toContain('\\"');
      expect(fm.startsWith('---\n')).toBe(true);
      expect(fm).toContain('\n---\n\n');
    });

    it('handles backslashes and newlines', () => {
      const fm = downloader.generateFrontmatter(
        {
          title: 'Path\\to\\file',
          description: 'Line1\nLine2',
          url: 'https://example.com/',
          domain: 'example.com',
          wordCount: 10,
          readingTime: 1,
        },
        {}
      );
      expect(fm).toContain('Path\\to\\file');
      expect(fm).toContain('Line1');
      expect(fm).toContain('Line2');
    });

    it('omits empty values and includes tags as list', () => {
      const fm = downloader.generateFrontmatter(
        {
          title: 'Test',
          url: 'https://example.com/',
          domain: 'example.com',
          wordCount: 50,
          readingTime: 1,
          tags: ['reddit', 'r/test'],
        },
        {}
      );
      expect(fm).toContain('tags:\n  - \"reddit\"\n  - \"r/test\"');
      expect(fm).not.toContain('author:');
      expect(fm).not.toContain('description:');
    });

    it('strips word_count etc in llm mode', () => {
      const fm = downloader.generateFrontmatter(
        {
          title: 'Test',
          url: 'https://example.com/',
          domain: 'example.com',
          wordCount: 100,
          readingTime: 1,
          description: 'Desc',
          tags: ['a'],
        },
        { stripLinks: true }
      );
      expect(fm).not.toContain('word_count');
      expect(fm).not.toContain('reading_time');
      expect(fm).not.toContain('description');
      expect(fm).not.toContain('tags:');
      expect(fm).toContain('title: \"Test\"');
    });

    it('includes date_saved as ISO string', () => {
      const fm = downloader.generateFrontmatter(
        { title: 'T', url: 'https://example.com/', domain: 'example.com' },
        {}
      );
      expect(fm).toMatch(/date_saved: \"\d{4}-\d{2}-\d{2}T/);
    });
  });
});
