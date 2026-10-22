import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

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
import { computeFence, detectLanguage } from './lib/codeBlocks';
import { pruneNoiseElements } from './lib/noise';

describe('AdvancedMarkdownConverter - core pipeline', () => {
  let converter: AdvancedMarkdownConverter;

  beforeAll(() => {
    // Ensure DOM globals are available (vitest happy-dom provides them, but double-check)
    // Instantiate converter once
    converter = new AdvancedMarkdownConverter();
    converter.debug = false;
  });

  describe('computeFence', () => {
    it('uses triple backticks by default', () => {
      expect(computeFence('hello')).toBe('```');
    });
    it('extends fence when code contains backticks', () => {
      expect(computeFence('code with ``` inside')).toBe('````');
      expect(computeFence('``')).toBe('```');
      expect(computeFence('````')).toBe('`````');
    });
  });

  describe('detectLanguage', () => {
    it('detects via data-lang', () => {
      const code = document.createElement('code');
      code.setAttribute('data-lang', 'python');
      expect(detectLanguage(code)).toBe('python');
    });
    it('detects via class language-*', () => {
      const code = document.createElement('code');
      code.className = 'language-js hljs';
      expect(detectLanguage(code)).toBe('js');
    });
    it('detects via parent pre data-lang', () => {
      const pre = document.createElement('pre');
      pre.setAttribute('data-lang', 'rust');
      const code = document.createElement('code');
      pre.appendChild(code);
      document.body.appendChild(pre);
      expect(detectLanguage(code)).toBe('rust');
      pre.remove();
    });
    it('returns empty when no hint', () => {
      const code = document.createElement('code');
      expect(detectLanguage(code)).toBe('');
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

  describe('mermaid rendered-garbage recovery (deepwiki-style)', () => {
    // DeepWiki renders ```mermaid blocks inside <pre> wrappers; defuddle
    // dissolves the resulting <svg> into scoped-CSS + glued label text.
    const garbagePre =
      '#mermaid-ab12{font-family:ui-sans-serif;fill:#333;}' +
      '@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}' +
      '#mermaid-ab12 .edgePath .path{stroke:#666;}' +
      'RuntimeCoreClientAppServerProcess';

    const withBodyHtml = (html: string, fn: () => void) => {
      Object.defineProperty(document.body, 'innerHTML', {
        value: html,
        configurable: true,
        writable: true
      });
      try {
        fn();
      } finally {
        delete (document.body as { innerHTML?: string }).innerHTML;
      }
    };

    it('replaces mangled mermaid pre with fenced source from page payload', () => {
      // Next.js RSC payload: escaped markdown inside a <script> push call
      const rsc =
        '<script>self.__next_f.push(["x","content:\\n```mermaid\\n' +
        'graph TB\\n  Client[\\"ClientApp\\"] --> Server[\\"ServerProcess\\"]\\n  Server --> Runtime[\\"RuntimeCore\\"]\\n' +
        '```\\n"])</script>';
      const html = `<h3>Architecture</h3><pre><code>${garbagePre}</code></pre>`;
      withBodyHtml(rsc, () => {
        const normalized = converter.normalizeContentHtml(html);
        const md = converter.turndown.turndown(normalized);
        expect(md).toContain('```mermaid');
        expect(md).toContain('Client["ClientApp"]');
        expect(md).toContain('Server["ServerProcess"]');
        expect(md).not.toContain('edge-animation-frame');
      });
    });

    it('emits a label blockquote when no source matches', () => {
      const html = `<pre><code>${garbagePre}</code></pre>`;
      withBodyHtml('<p>no payloads here</p>', () => {
        const normalized = converter.normalizeContentHtml(html);
        const md = converter.turndown.turndown(normalized);
        expect(md).not.toContain('edge-animation-frame');
        expect(md).not.toContain('```');
        expect(md).toContain('**Diagram:**');
        expect(md).toContain('Runtime Core');
        expect(md).toContain('Server Process');
      });
    });

    it('leaves ordinary code blocks untouched', () => {
      const html = `<pre><code>const x = { stroke: 1 }; console.log(x);</code></pre>`;
      const normalized = converter.normalizeContentHtml(html);
      const md = converter.turndown.turndown(normalized);
      expect(md).toContain('```');
      expect(md).toContain('console.log(x)');
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
    const fragment = (html: string) => {
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
        const counts = pruneNoiseElements(body);
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
          <span class="katex"><span class="katex-html" aria-hidden="true">x²<span class="wrapper"><span aria-hidden="true">+y²</span></span></span></span>
          <mjx-container aria-hidden="true"><mjx-row>x</mjx-row></mjx-container>
          <div aria-hidden="true">decorative icon</div>
        `);
        pruneNoiseElements(body);
        expect(body.textContent).toContain('x²');
        expect(body.textContent).toContain('+y²');
        expect(body.textContent).toContain('x');
        expect(body.textContent).not.toContain('decorative icon');
      });

      it('keeps an aria-hidden subtree holding most of the page text (modal-open pages)', () => {
        const body = fragment(`
          <div id="page-wrapper" aria-hidden="true">
            <p>${'Real article text. '.repeat(30)}</p>
          </div>
          <div id="modal" role="dialog"><button>Close</button></div>
        `);
        pruneNoiseElements(body);
        expect(body.textContent).toContain('Real article text.');
      });

      it('ignores display:none inside url() in inline styles', () => {
        const body = fragment(`
          <div style="background:url('data:image/svg+xml;display:none,xyz')">visible</div>
          <div style="display:none">gone</div>
        `);
        pruneNoiseElements(body);
        expect(body.textContent).toContain('visible');
        expect(body.textContent).not.toContain('gone');
      });
    });

    describe('tracker pixels and share widgets (issue #24)', () => {
      it('removes analytics/tracking pixel images', () => {
        const body = fragment(`
          <p>real article text</p>
          <img src="//analytics.supplyframe.com/trackingservlet/impression?action=pageImpression" id="hdTrack" class="trackImg">
          <img src="https://stats.wp.com/g.gif?x=1" alt="">
          <img src="https://example.com/pixel.gif" width="1" height="1">
          <img src="https://example.com/beacon" style="width:1px;height:1px">
          <img src="https://example.com/real-photo.jpg" alt="Actual content">
        `);
        const counts = pruneNoiseElements(body);
        expect(counts.trackers).toBe(4);
        expect(body.innerHTML).toContain('real-photo.jpg');
        expect(body.innerHTML).not.toContain('trackingservlet');
        expect(body.innerHTML).not.toContain('stats.wp.com');
        expect(body.innerHTML).not.toContain('pixel.gif');
      });

      it('removes share widgets, share-endpoint links, and emptied wrappers', () => {
        const body = fragment(`
          <ul class="sharing">
            <li><a href="https://www.facebook.com/sharer/sharer.php?u=x"><i><img src="/img/share_face.png"></i></a></li>
            <li><a href="https://twitter.com/intent/tweet?text=t"><i><img src="/img/share_twitter.png"></i></a></li>
            <li><a href="mailto:?subject=t&amp;body=u"><img src="/img/share_mail.png"></a></li>
          </ul>
          <div class="share-dialog-content">
            <form id="share-menu"><label>Title:</label><input value="x"><button>Copy</button></form>
          </div>
          <p>Keep this <a href="https://example.com/real-link">real link</a>.</p>
          <ul><li><a href="https://news.ycombinator.com/submitlink?u=x&t=t">Share on HN</a></li></ul>
        `);
        const counts = pruneNoiseElements(body);
        // ul.sharing, .share-dialog-content and #share-menu go as whole
        // widgets first; only the bare <ul><li><a> HN item remains for the
        // link pass.
        expect(counts.shareLinks).toBe(1);
        expect(counts.shareWidgets).toBe(3);
        expect(body.querySelector('a')).not.toBeNull();
        expect(body.innerHTML).toContain('real-link');
        expect(body.innerHTML).not.toContain('sharer.php');
        expect(body.innerHTML).not.toContain('intent/tweet');
        expect(body.innerHTML).not.toContain('share-menu');
      });

      it('leaves no stray bullets or empty links in markdown output', () => {
        const body = fragment(`
          <p>article body</p>
          <ul class="sharing">
            <li><a href="https://www.facebook.com/sharer/sharer.php?u=x"><img src="/i/f.png"></a></li>
            <li><a href="https://reddit.com/submit?url=u"><img src="/i/r.png"></a></li>
          </ul>
        `);
        pruneNoiseElements(body);
        const md = converter.turndown.turndown(body.innerHTML);
        expect(md).toContain('article body');
        expect(md).not.toMatch(/sharer|reddit\.com\/submit/);
        expect(md).not.toMatch(/^\s*-\s*$/m);
        expect(md).not.toMatch(/(?<!!)\[\]\(/);
      });

      it('keeps a mailto link with a real recipient', () => {
        const body = fragment(`
          <p>Contact <a href="mailto:author@example.com">the author</a>.</p>
        `);
        pruneNoiseElements(body);
        expect(body.innerHTML).toContain('mailto:author@example.com');
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

    describe('extractMetadata', () => {
      it('counts words from the shipped content, not the live document', () => {
        const contentElement = fragment(`<main><p>one two three four five</p></main>`);
        const metadata = converter.extractMetadata({ element: contentElement, kind: 'defuddle' });
        expect(metadata.wordCount).toBe(5);
        expect(metadata.readingTime).toBe(1);
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
          const text = result.element.textContent || '';
          expect(text).toContain('Assistant reply');
          expect(text).not.toContain('Skip to main content');
          expect(text).not.toContain('draggable item');
          expect(text).not.toContain('invisible junk');
          // The shipped HTML must describe the same content as the element.
          expect(result.html).toContain('Assistant reply');
        } finally {
          document.body.innerHTML = originalBody;
        }
      });
    });

    describe('extractMainContent integration (claude.ai conversation)', () => {
      it('extracts the full conversation, not just the first message', () => {
        const originalBody = document.body.innerHTML;
        const originalTitle = document.title;
        const originalUrl = window.location.href;
        try {
          window.happyDOM?.setURL(
            'https://claude.ai/chat/3f6ffb5d-b4db-4c83-9976-d17f65be31ef'
          );
          document.title = 'Prompt structure for better AI requests - Claude';
          document.body.innerHTML = `
            <aside>Sidebar noise: Chats and tasks</aside>
            <div data-testid="transcript-list">
              <div data-testid="transcript-row" data-perf-row="human">
                <div role="article" aria-label="Message 1 of 2">
                  <h2 data-find-omitted="" class="sr-only">You said: what do you think</h2>
                  <div data-cds="UserMessage"><div data-testid="user-message"><p>what do you think of my prompt</p><pre><code>Help me turn the following prompt into a good prompt.\n\nPrompt:</code></pre></div></div>
                  <div data-cds="MessageActions" role="toolbar"><button>Show more</button></div>
                </div>
              </div>
              <div data-testid="transcript-row" data-perf-row="assistant">
                <div role="article" aria-label="Message 2 of 2">
                  <h2 data-find-omitted="" class="sr-only">Claude responded: Honestly, it's good.</h2>
                  <div data-cds="TurnStatus"><p>Thought for 12s</p></div>
                  <div data-cds="AssistantMessage" data-testid="assistant-message"><p>Honestly, it's good. The best parts are the specifics.</p><pre><code>Rewrite the prompt inside &lt;prompt&gt;.</code></pre></div>
                  <div data-cds="MessageActions" role="toolbar"><button>Copy</button></div>
                </div>
              </div>
            </div>
            <div>Write a message…</div>
          `;
          const result = converter.extractMainContent();
          const text = result.element.textContent || '';
          expect(text).toContain('what do you think of my prompt');
          expect(text).toContain('Prompt:');
          expect(text).toContain("Honestly, it's good");
          expect(text).toContain('Rewrite the prompt inside <prompt>');
          expect(text).not.toContain('Show more');
          expect(text).not.toContain('Thought for 12s');
          expect(text).not.toContain('Sidebar noise');
          expect(text).not.toContain('Write a message');
          expect(result.element.querySelectorAll('section[data-speaker-role]').length).toBe(2);
        } finally {
          window.happyDOM?.setURL(originalUrl);
          document.body.innerHTML = originalBody;
          document.title = originalTitle;
        }
      });
    });

    // Regression: the pipeline used to keep the selected content in one
    // place (extractMainContent) and the HTML to convert in another
    // (this.defuddleHtml). When the selection had lost a rendered diagram,
    // the converter swapped in the *whole live page* — shipping nav bars,
    // sidebars and footers — while the frontmatter still described the
    // small selection. One content object, one truth.
    describe('single source of truth (regression)', () => {
      const originalBody = document.body.innerHTML;

      afterEach(() => {
        document.body.innerHTML = originalBody;
      });

      it('never ships the whole page when the selection lost a diagram', () => {
        document.body.innerHTML = `
          <div class="sidebar">SIDEBAR NOISE</div>
          <header class="site-header">HEADER CHROME</header>
          <main><p>The article paragraph that the extractor selected.</p></main>
          <div class="diagram"><svg id="mermaid-live" data-source="graph TD; A--&gt;B"></svg></div>
        `;

        const selection = fragment(
          '<main><p>The article paragraph that the extractor selected.</p></main>'
        );
        const markdown = converter.convertToMarkdown({
          element: selection,
          html: selection.innerHTML,
          kind: 'defuddle'
        });

        expect(markdown).not.toContain('SIDEBAR NOISE');
        expect(markdown).not.toContain('HEADER CHROME');
        expect(markdown).toContain('The article paragraph');
        // the dropped diagram is recovered instead of dragging the page in
        expect(markdown).toContain('```mermaid');
        expect(markdown).toContain('graph TD; A-->B');
      });

      it('counts the words it actually ships', () => {
        document.body.innerHTML = `
          <div class="sidebar">chrome chrome chrome chrome chrome chrome</div>
          <main><p>one two three</p></main>
        `;

        const content = converter.extractMainContent();
        const metadata = converter.extractMetadata(content);
        const markdown = converter.convertToMarkdown(content);

        expect(markdown).not.toContain('chrome');
        expect(metadata.wordCount).toBe(3);
        expect(metadata.readingTime).toBe(1);
      });
    });
  });
});
