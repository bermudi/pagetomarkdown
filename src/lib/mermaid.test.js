import { describe, it, expect } from 'vitest';

import {
    applyMermaidToDoc,
    collectMermaidSources,
    createMermaidContext,
    extractMermaidRenderedLabels,
    extractMermaidSourceFromSvg,
    isMermaidGarbageText,
    matchMermaidSourceByText,
    rescueMissingDiagrams,
    sourceExplainsLabels
} from './mermaid.js';

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

describe('collectMermaidSources', () => {
    it('finds plain fences', () => {
        const sources = collectMermaidSources('<p>```mermaid\ngraph TD; A-->B\n```</p>');
        expect(sources).toEqual(['graph TD; A-->B']);
    });

    it('decodes escaped payloads', () => {
        const html = '<script>self.__next_f.push(["1","content:\\n```mermaid\\ngraph TD\\n  A-->B\\n```\\n"])</script>';
        expect(collectMermaidSources(html)).toEqual(['graph TD\n  A-->B']);
    });

    it('ignores html without fences', () => {
        expect(collectMermaidSources('<p>no diagrams here</p>')).toEqual([]);
        expect(collectMermaidSources('')).toEqual([]);
    });
});

describe('isMermaidGarbageText', () => {
    it('detects a dissolved diagram', () => {
        expect(
            isMermaidGarbageText('#mermaid-ab12{font-family:ui-sans-serif;}@keyframes edge-animation-frame{from{}}')
        ).toBe(true);
    });

    it('detects the css-plus-keyframes shape', () => {
        expect(isMermaidGarbageText('#mermaid-1 .edgePath{stroke:#666} @keyframes x{from{}}')).toBe(true);
    });

    it('leaves ordinary code alone', () => {
        expect(isMermaidGarbageText('const x = { stroke: 1 }; console.log(x);')).toBe(false);
        expect(isMermaidGarbageText('')).toBe(false);
    });
});

describe('extractMermaidRenderedLabels', () => {
    it('returns the label tail after the css', () => {
        const text = '#mermaid-x{color:red}RuntimeCoreClientAppServerProcess';
        expect(extractMermaidRenderedLabels(text)).toBe('Runtime Core Client App Server Process');
    });

    it('returns an empty string without text', () => {
        expect(extractMermaidRenderedLabels('')).toBe('');
    });
});

describe('matchMermaidSourceByText', () => {
    const loader = 'graph TD\n  Loader["Loader"] --> Renderer["Renderer"]';
    const other = 'graph LR\n  Database["Database"] --> Cache["Cache"]';

    it('picks the source whose labels survive rendering', () => {
        expect(matchMermaidSourceByText('LoaderRenderer', [other, loader])).toBe(loader);
    });

    it('does not match an unrelated diagram', () => {
        expect(matchMermaidSourceByText('TotallyDifferent', [other, loader])).toBe('');
    });

    it('skips consumed sources', () => {
        const consumed = new Set([loader]);
        expect(matchMermaidSourceByText('LoaderRenderer', [other, loader], consumed)).toBe('');
    });

    it('needs at least two matching tokens', () => {
        expect(matchMermaidSourceByText('Loader', [loader])).toBe('');
    });
});

describe('sourceExplainsLabels', () => {
    it('recognizes a diagram that is already in the output', () => {
        const loader = 'graph TD\n  Loader["Loader"] --> Renderer["Renderer"]';
        expect(sourceExplainsLabels(loader, 'LoaderRenderer')).toBe(true);
        expect(sourceExplainsLabels(loader, 'SomethingElse')).toBe(false);
    });
});

describe('extractMermaidSourceFromSvg', () => {
    it('reads an explicit data-source attribute', () => {
        const doc = parse('<svg id="mermaid-1" data-source="graph TD; A-->B"></svg>');
        expect(extractMermaidSourceFromSvg(doc.querySelector('svg'))).toBe('graph TD; A-->B');
    });

    it('reads a nearby mermaid code block', () => {
        const doc = parse(
            '<div class="diagram"><pre><code class="language-mermaid">graph TD; X--&gt;Y</code></pre><svg id="mermaid-2"></svg></div>'
        );
        expect(extractMermaidSourceFromSvg(doc.querySelector('svg'))).toBe('graph TD; X-->Y');
    });

    it('returns an empty string when there is no source', () => {
        const doc = parse('<svg id="mermaid-3"></svg>');
        expect(extractMermaidSourceFromSvg(doc.querySelector('svg'))).toBe('');
    });
});

describe('applyMermaidToDoc', () => {
    it('turns a rendered svg into a fenced block', () => {
        const doc = parse('<div><svg id="mermaid-1" data-source="graph TD; A-->B"></svg></div>');
        const stats = applyMermaidToDoc(doc, createMermaidContext(''));
        expect(stats.svgReplaced).toBe(1);
        expect(doc.body.innerHTML).toContain('language-mermaid');
        expect(doc.body.innerHTML).toContain('graph TD; A--&gt;B');
    });

    it('recovers a dissolved diagram from the page pool', () => {
        const garbage = '#mermaid-ab12{font-family:ui-sans-serif;}@keyframes edge-animation-frame{from{}}LoaderRenderer';
        const doc = parse(`<pre><code>${garbage}</code></pre>`);
        const ctx = createMermaidContext('```mermaid\ngraph TD\n  Loader["Loader"] --> Renderer["Renderer"]\n```');
        const stats = applyMermaidToDoc(doc, ctx);
        expect(stats.garbageRecovered).toBe(1);
        expect(doc.body.innerHTML).toContain('language-mermaid');
        expect(doc.body.textContent).not.toContain('edge-animation-frame');
    });

    it('falls back to a label blockquote when no source matches', () => {
        const garbage = '#mermaid-ab12{font-family:ui-sans-serif;}@keyframes edge-animation-frame{from{}}RuntimeCoreClientApp';
        const doc = parse(`<pre><code>${garbage}</code></pre>`);
        const stats = applyMermaidToDoc(doc, createMermaidContext(''));
        expect(stats.garbagePlaceholders).toBe(1);
        expect(doc.body.textContent).toContain('Diagram:');
        expect(doc.body.textContent).toContain('Runtime Core');
        expect(doc.body.textContent).not.toContain('edge-animation-frame');
    });

    it('leaves ordinary code blocks alone', () => {
        const doc = parse('<pre><code>const x = 1;</code></pre>');
        const stats = applyMermaidToDoc(doc, createMermaidContext(''));
        expect(stats.garbageRecovered).toBe(0);
        expect(stats.garbagePlaceholders).toBe(0);
        expect(doc.body.textContent).toContain('const x = 1;');
    });

    it('embeds a source-less svg as an image', () => {
        const doc = parse('<div><svg id="mermaid-9"><text>hello</text></svg></div>');
        const stats = applyMermaidToDoc(doc, createMermaidContext(''));
        expect(stats.svgEmbedded).toBe(1);
        expect(doc.body.querySelector('svg')).toBeNull();
        expect(doc.body.querySelector('img')).not.toBeNull();
    });
});

describe('rescueMissingDiagrams', () => {
    it('injects a diagram the extractor dropped, after the matching heading', () => {
        const liveDoc = parse(
            '<h2>Architecture</h2><p>text</p><svg id="mermaid-live" data-source="graph TD; A--&gt;B"></svg>'
        );
        const selectionDoc = parse('<h2>Architecture</h2><p>text</p>');
        const ctx = createMermaidContext('');

        const stats = rescueMissingDiagrams({ liveDoc, selectionDoc, ctx });
        expect(stats.injected).toBe(1);

        const html = selectionDoc.body.innerHTML;
        expect(html).toContain('language-mermaid');
        // placed after the heading it belongs to, not at the top of the file
        expect(html.indexOf('language-mermaid')).toBeGreaterThan(html.indexOf('Architecture'));
    });

    it('does not inject a diagram that is already represented', () => {
        const liveDoc = parse('<svg id="mermaid-live" data-source="graph TD; A--&gt;B"></svg>');
        const selectionDoc = parse('<pre><code>graph TD; A--&gt;B</code></pre>');
        const ctx = createMermaidContext('');
        ctx.used.add('graph TD; A-->B');
        ctx.consumed.add('graph TD; A-->B');

        const stats = rescueMissingDiagrams({ liveDoc, selectionDoc, ctx });
        expect(stats.injected).toBe(0);
        expect(selectionDoc.body.innerHTML).not.toContain('language-mermaid');
    });

    it('appends when no heading matches', () => {
        const liveDoc = parse('<svg id="mermaid-live" data-source="graph TD; A--&gt;B"></svg>');
        const selectionDoc = parse('<p>no headings here</p>');
        const ctx = createMermaidContext('');

        const stats = rescueMissingDiagrams({ liveDoc, selectionDoc, ctx });
        expect(stats.injected).toBe(1);
        expect(selectionDoc.body.innerHTML.trim().endsWith('</pre>')).toBe(true);
    });

    it('ignores pages without diagrams', () => {
        const liveDoc = parse('<p>nothing here</p>');
        const selectionDoc = parse('<p>nothing here</p>');
        const stats = rescueMissingDiagrams({ liveDoc, selectionDoc, ctx: createMermaidContext('') });
        expect(stats.injected).toBe(0);
    });
});
