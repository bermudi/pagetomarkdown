import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock webextension-polyfill before importing content.js
vi.mock('webextension-polyfill', () => ({
  default: {
    storage: { local: { get: async () => ({ debugLogging: false }) } },
    runtime: { onMessage: { addListener: () => {} } },
    browserAction: { onClicked: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } },
    tabs: { sendMessage: async () => {} },
    downloads: { download: async () => {} },
  },
}));

import { AdvancedMarkdownConverter } from './content.js';

describe('AdvancedMarkdownConverter - core pipeline', () => {
  let converter;

  beforeAll(() => {
    // Ensure DOM globals are available (vitest happy-dom provides them, but double-check)
    // Instantiate converter once
    converter = new AdvancedMarkdownConverter();
    converter.debug = false;
  });

  describe('computeFence', () => {
    it('uses triple backticks by default', () => {
      expect(converter.computeFence('hello')).toBe('```');
    });
    it('extends fence when code contains backticks', () => {
      expect(converter.computeFence('code with ``` inside')).toBe('````');
      expect(converter.computeFence('``')).toBe('```');
      expect(converter.computeFence('````')).toBe('`````');
    });
  });

  describe('detectLanguage', () => {
    it('detects via data-lang', () => {
      const code = document.createElement('code');
      code.setAttribute('data-lang', 'python');
      expect(converter.detectLanguage(code)).toBe('python');
    });
    it('detects via class language-*', () => {
      const code = document.createElement('code');
      code.className = 'language-js hljs';
      expect(converter.detectLanguage(code)).toBe('js');
    });
    it('detects via parent pre data-lang', () => {
      const pre = document.createElement('pre');
      pre.setAttribute('data-lang', 'rust');
      const code = document.createElement('code');
      pre.appendChild(code);
      document.body.appendChild(pre);
      expect(converter.detectLanguage(code)).toBe('rust');
      pre.remove();
    });
    it('returns empty when no hint', () => {
      const code = document.createElement('code');
      expect(converter.detectLanguage(code)).toBe('');
    });
  });

  describe('code block handling via normalizeContentHtml + turndown', () => {
    it('preserves pre/code with language-* through conversion', () => {
      const html = `<pre><code class="language-js">console.log("hi");\nconsole.log("bye");</code></pre>`;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      expect(md).toContain('```js');
      expect(md).toContain('console.log("hi");');
    });

    it('handles pre without code child', () => {
      const html = `<pre>plain pre content\nsecond line</pre>`;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      expect(md).toContain('```');
      expect(md).toContain('plain pre content');
    });

    it('detects language via data-lang on code', () => {
      const html = `<pre><code data-lang="python">print("hello")</code></pre>`;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      expect(md).toContain('```python');
    });

    it('cleans heading with anchor inside', () => {
      const html = `<h2><a href="#install-dependencies">Install Dependencies</a></h2>`;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      // Should be clean heading without link syntax
      expect(md.trim()).toBe('## Install Dependencies');
    });

    it('cleans heading wrapped in link', () => {
      const html = `<a href="#install"><h3>Install Dependencies</h3></a>`;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      expect(md.trim()).toBe('### Install Dependencies');
    });

    it('keeps heading with inline code sensible', () => {
      const html = `<h2>Usage of <code>myFunc</code> helper</h2>`;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      // cleanHeadings uses textContent, so inline code becomes plain text
      // The important part is it doesn't produce markdown link or broken syntax
      expect(md).toContain('## Usage of myFunc helper');
    });
  });

  describe('mermaid SVG preprocessing', () => {
    it('converts svg with data-source to mermaid fence', () => {
      const html = `<div><svg id="mermaid-123" data-source="graph TD; A-->B"></svg></div>`;
      const normalized = converter.normalizeContentHtml(html);
      expect(normalized).toContain('language-mermaid');
      expect(normalized).toContain('graph TD');
      const md = converter.turndown.turndown(normalized);
      expect(md).toContain('```mermaid');
      expect(md).toContain('graph TD');
    });

    it('uses raw mermaid fence from HTML when svg lacks source', () => {
      // Raw HTML contains a mermaid fence as text, which extractMermaidBlocksFromRawHtml picks up
      const html = `<div><svg id="mermaid-456" class="mermaid"></svg></div>\`\`\`mermaid\ngraph TD; X-->Y\n\`\`\``;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      expect(md).toContain('```mermaid');
      expect(md).toContain('graph TD; X-->Y');
    });

    it('falls back to placeholder or data-uri when no source', () => {
      const html = `<div><svg id="mermaid-999" class="mermaid"><g><text>hello</text></g></svg></div>`;
      const normalized = converter.normalizeContentHtml(html);
      // Should have replaced svg with either img or placeholder paragraph
      expect(normalized).not.toContain('<svg');
      const md = converter.turndown.turndown(normalized);
      // Could be image placeholder or omitted notice
      expect(md).toMatch(/Mermaid diagram|mermaid/);
    });

    it('handles svg with flowchart aria role', () => {
      const html = `<svg id="mermaid-flow" aria-roledescription="flowchart" data-source="flowchart TD; A-->B"></svg>`;
      const normalized = converter.normalizeContentHtml(html);
      expect(normalized).toContain('mermaid');
      const md = converter.turndown.turndown(normalized);
      expect(md).toContain('flowchart');
      expect(md).toContain('flowchart');
    });
  });

  describe('defuddle fallback signals', () => {
    it('normalizeContentHtml preserves PRE count', () => {
      const html = `<article><pre><code>one</code></pre><pre><code>two</code></pre></article>`;
      const normalized = converter.normalizeContentHtml(html);
      const doc = new DOMParser().parseFromString(normalized, 'text/html');
      expect(doc.querySelectorAll('pre').length).toBe(2);
    });
  });

  describe('post-defuddle-0.19 fallback guards', () => {
    const fragment = (html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return doc.body;
    };

    describe('pruneNoiseElements', () => {
      it('removes hidden elements, templates, and skip links, keeps visible content', () => {
        const body = fragment(`
          <a href="#main">Skip to main content</a>
          <div id="dnd" style="display: none;">To pick up a draggable item</div>
          <div style="visibility:hidden">ghost</div>
          <div hidden>hidden attr</div>
          <template><p>tpl</p></template>
          <p>keep me</p>
        `);
        const counts = converter.pruneNoiseElements(body);
        expect(body.textContent).toContain('keep me');
        expect(body.textContent).not.toContain('draggable');
        expect(body.textContent).not.toContain('ghost');
        expect(body.textContent).not.toContain('hidden attr');
        expect(body.textContent).not.toContain('tpl');
        expect(body.querySelector('a')).toBeNull();
        expect(counts.skipLinks).toBe(1);
        expect(counts.hidden).toBe(3);
        expect(counts.templates).toBe(1);
      });

      it('keeps math renderers that hide their visual tree with aria-hidden', () => {
        const body = fragment(`
          <span class="katex"><span class="katex-html" aria-hidden="true">x²</span></span>
          <div aria-hidden="true">decorative icon</div>
        `);
        converter.pruneNoiseElements(body);
        expect(body.textContent).toContain('x²');
        expect(body.textContent).not.toContain('decorative icon');
      });
    });

    describe('isSubstantiveExtraction', () => {
      it('accepts a substantive extraction', () => {
        const parsed = fragment(`<p>${'word '.repeat(40)}</p>`);
        const body = fragment(`<p>${'word '.repeat(200)}</p>`);
        expect(converter.isSubstantiveExtraction(parsed, body)).toBe(true);
      });

      it('rejects a thin extraction from a content-rich page', () => {
        const parsed = fragment('<p>Done</p>');
        const body = fragment(`<p>${'word '.repeat(200)}</p>`);
        expect(converter.isSubstantiveExtraction(parsed, body)).toBe(false);
      });

      it('trusts defuddle on a tiny page', () => {
        const parsed = fragment('<p>Done</p>');
        const body = fragment('<p>tiny</p>');
        expect(converter.isSubstantiveExtraction(parsed, body)).toBe(true);
      });
    });

    describe('shouldFallbackToOriginalCodeBlocks', () => {
      const meaningful = '<pre><code>const x = 1234567890abcdef;</code></pre>';

      it('falls back when meaningful code blocks were lost', () => {
        const original = fragment(`<div>${meaningful}${meaningful}</div>`);
        const parsed = fragment('<p>no code here</p>');
        expect(converter.shouldFallbackToOriginalCodeBlocks(original, parsed)).toBe(true);
      });

      it('keeps defuddle when all code survived', () => {
        const original = fragment(`<div>${meaningful}${meaningful}</div>`);
        const parsed = fragment(`<div>${meaningful}${meaningful}</div><p>text</p>`);
        expect(converter.shouldFallbackToOriginalCodeBlocks(original, parsed)).toBe(false);
      });

      it('keeps defuddle when only trivial pre remnants were dropped', () => {
        const original = fragment('<pre><code>hi</code></pre>');
        const parsed = fragment('<p>text</p>');
        expect(converter.shouldFallbackToOriginalCodeBlocks(original, parsed)).toBe(false);
      });
    });

    describe('extractMainContent integration (SPA shell page)', () => {
      it('never ships skip links or hidden live-region text', () => {
        const originalBody = document.body.innerHTML;
        try {
          document.body.innerHTML = `
            <a href="#main-content" aria-label="Skip to main content">Skip to main content</a>
            <main>
              <h1>Conversation</h1>
              <p>User message one about agents and transcripts.</p>
              <p>Assistant reply with a fair amount of prose so defuddle has something to score.</p>
            </main>
            <div style="display: none;">To pick up a draggable item, press the space bar.</div>
            <div hidden>invisible junk</div>
          `;
          const result = converter.extractMainContent();
          const text = result.textContent || '';
          expect(text).toContain('Assistant reply');
          expect(text).not.toContain('Skip to main content');
          expect(text).not.toContain('draggable item');
          expect(text).not.toContain('invisible junk');
        } finally {
          document.body.innerHTML = originalBody;
        }
      });
    });
  });
});
