/**
 * Mermaid diagram handling for the markdown pipeline.
 *
 * Mermaid diagrams reach the extension in three different shapes:
 *
 *   1. A live `<svg id="mermaid-…">` (mermaid.js replaced the fenced
 *      source with a rendered SVG). The original source may be recoverable
 *      from a `data-source` attribute, from a nearby `code.language-mermaid`
 *      element, or — most often — from a ` ```mermaid ` fence that still
 *      lives in the page's HTML.
 *   2. A ` ```mermaid ` fence that survived extraction untouched.
 *   3. A *dissolved* diagram: an extractor flattened the SVG into CSS plus
 *      glued label text, leaving `<pre><code>#mermaid-ab12{…}LabelLabel</code></pre>`.
 *      The real source is gone from the DOM but often survives in the page's
 *      own payload (e.g. a Next.js RSC `<script>`).
 *
 * This module owns all of that. It never reaches for the live document on
 * its own — the caller passes it in — so the boundary between "the content
 * we selected" and "the page we are looking at" stays visible at the call
 * site instead of being buried in a helper.
 */

// Mermaid syntax keywords — excluded when tokenizing diagram sources for
// label matching.
export const MERMAID_KEYWORDS = new Set([
    'graph', 'subgraph', 'end', 'flowchart', 'statediagram', 'sequencediagram',
    'classdiagram', 'erdiagram', 'statediagramv', 'gantt', 'mindmap', 'timeline',
    'journey', 'gitgraph', 'classdef', 'style', 'click', 'linkstyle', 'direction',
    'default', 'participant', 'actor', 'note', 'loop', 'alt', 'else', 'opt'
]);

// Minimum overlap for a match to be trusted. Measured on the real DeepWiki
// page: the label score puts the true source at 1.00 against runners-up of
// 0.20–0.33, and the identifier fallback puts it at 0.74–0.92 against
// 0.28–0.33 — the bar sits inside both gaps. Numbers are kept honest in the
// scoreMermaidSourceByText docstring; update the two together.
const MATCH_SCORE_THRESHOLD = 0.5;
const MIN_MATCH_HITS = 2;

/* ------------------------------------------------------------------ */
/*  Source pool                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pull ` ```mermaid ` fences out of raw HTML. The fences may be escaped
 * (`\n` instead of newlines) when they travel inside a JSON/script payload,
 * so the decoded form is what gets returned.
 */
export function collectMermaidSources(html: string): string[] {
    if (!html) return [];

    const results = [];
    const re = /```mermaid(?:\r?\n|\\n)([\s\S]*?)```/g;
    let match;
    while ((match = re.exec(html))) {
        const raw = match[1] || '';
        const decoded = unescapeEmbeddedText(raw).trim();
        if (decoded) results.push(decoded);
    }
    return results;
}

export function unescapeEmbeddedText(text: string): string {
    if (!text) return '';
    let result = String(text);
    result = result.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    result = result.replace(/\\n/g, '\n');
    result = result.replace(/\\r/g, '\r');
    result = result.replace(/\\t/g, '\t');
    result = result.replace(/\\"/g, '"');
    result = result.replace(/\\\\/g, '\\');
    return result;
}

/* ------------------------------------------------------------------ */
/*  Label matching                                                     */
/* ------------------------------------------------------------------ */

/**
 * The labels a mermaid source puts on its nodes — the text a renderer
 * keeps and a dissolved diagram leaves behind.
 *
 * `A["Workbench UI"]`, `A(Label)`, `A{Label}`, `A[["Label"]]`, `A[("Label")]`
 * and edge labels (`A -->|Creates| B`) all count.
 */
const LABEL_PATTERNS = [
    /\[\[\s*"([^"]{2,})"\s*\]\]/g,
    /\[\(\s*"([^"]{2,})"\s*\)\]/g,
    /\{\{\s*"([^"]{2,})"\s*\}\}/g,
    /\[\s*"([^"]{2,})"\s*\]/g,
    /\(\s*"([^"]{2,})"\s*\)/g,
    /\{\s*"([^"]{2,})"\s*\}/g,
    /\[\s*([^]"\n|]{2,})\s*\]/g,
    /\(\s*([^)"\n|]{2,})\s*\)/g,
    /\{\s*([^}"\n|]{2,})\s*\}/g,
    /\|([^|\n]{2,})\|/g
];

export function mermaidSourceLabels(source: string): string[] {
    if (!source) return [];
    const found = new Set<string>();
    for (const pattern of LABEL_PATTERNS) {
        const re = new RegExp(pattern.source, 'g');
        let match;
        while ((match = re.exec(source))) {
            const label = normalizeLabel(match[1]);
            if (label) found.add(label);
        }
    }
    return [...found];
}

// Markup the source may carry around a label ("**bold**") but the renderer
// drops.
function normalizeLabel(label: string): string {
    return (label || '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
}

export function mermaidCandidateTokens(source: string): Set<string> {
    const tokens = new Set<string>();
    const re = /[A-Za-z][A-Za-z0-9_]*(?:[./][A-Za-z0-9_./-]+)*/g;
    let m;
    while ((m = re.exec(source))) {
        const tok = m[0];
        if (tok.length < 3) continue;
        if (MERMAID_KEYWORDS.has(tok.toLowerCase())) continue;
        tokens.add(tok);
    }
    return tokens;
}

/**
 * Score a source by how much of it survives rendering.
 *
 * Two signals:
 *   - **labels** — the node labels a renderer keeps verbatim. This is the
 *     sharp signal: a dissolved diagram *is* its labels, concatenated.
 *   - **identifiers** — every token in the source. Diluted by edge labels,
 *     subgraph ids and node ids that the renderer never shows.
 *
 * Measured on a real DeepWiki page (266 candidate sources, 3 diagrams): the
 * label score picked the right source every time with a score of 1.00
 * against a runner-up of 0.20–0.33, while the identifier score gave
 * 0.74–0.92 against 0.28–0.33. Labels win when a source has them.
 */
export function scoreMermaidSourceByText(
    haystack: string,
    source: string,
    metric: 'label' | 'token' = 'label'
): MermaidScore {
    if (!haystack || !source) return { score: 0, hits: 0 };

    const labels = mermaidSourceLabels(source);
    let labelHits = 0;
    for (const label of labels) {
        if (haystack.includes(label)) labelHits += 1;
    }
    const labelScore = labels.length ? labelHits / labels.length : 0;

    const toks = mermaidCandidateTokens(source);
    let tokenHits = 0;
    for (const t of toks) {
        if (haystack.includes(t)) tokenHits += 1;
    }
    const tokenScore = toks.size ? tokenHits / toks.size : 0;

    const useLabels = metric === 'label' && labels.length >= 2;
    return {
        score: useLabels ? labelScore : tokenScore,
        hits: useLabels ? labelHits : tokenHits,
        labelScore,
        labelHits,
        tokenScore,
        tokenHits
    };
}

/**
 * Pick the source that best explains `haystack`. Returns an empty string
 * when nothing clears the confidence bar.
 *
 * Labels are the primary signal; when no candidate clears the bar on
 * labels (a diagram whose labels are only partly rendered), the identifier
 * score gets a second chance.
 */
export function matchMermaidSourceByText(
    haystack: string,
    candidates: string[],
    consumed?: Set<string>
): string {
    const byLabel = rankMermaidSourcesByText(haystack, candidates, consumed, 'label')[0];
    if (byLabel && byLabel.score >= MATCH_SCORE_THRESHOLD && byLabel.hits >= MIN_MATCH_HITS) {
        return byLabel.source;
    }

    const byToken = rankMermaidSourcesByText(haystack, candidates, consumed, 'token')[0];
    if (byToken && byToken.score >= MATCH_SCORE_THRESHOLD && byToken.hits >= MIN_MATCH_HITS) {
        return byToken.source;
    }

    return '';
}

export function rankMermaidSourcesByText(
    haystack: string,
    candidates: string[],
    consumed?: Set<string>,
    metric: 'label' | 'token' = 'label'
): MermaidRanked[] {
    if (!haystack || !candidates?.length) return [];
    const ranked = [];
    for (const cand of candidates) {
        if (!cand || consumed?.has(cand)) continue;
        const { score, hits } = scoreMermaidSourceByText(haystack, cand, metric);
        if (hits === 0) continue;
        ranked.push({ source: cand, score, hits });
    }
    ranked.sort((a, b) => b.score - a.score || b.hits - a.hits);
    return ranked;
}

/**
 * True when the diagram behind `source` is already represented in the
 * extracted content — i.e. the live page's SVG was dropped by the
 * extractor, but the selection still carries the diagram's labels.
 */
export function sourceExplainsLabels(source: string, haystack: string): boolean {
    const { score, hits } = scoreMermaidSourceByText(haystack, source);
    return score >= MATCH_SCORE_THRESHOLD && hits >= MIN_MATCH_HITS;
}

/* ------------------------------------------------------------------ */
/*  Mangled ("garbage") diagram text                                   */
/* ------------------------------------------------------------------ */

/**
 * Text left behind when a renderer replaces a ```mermaid code block with
 * the rendered SVG and an extractor then flattens the SVG to text: the
 * scoped <style> rules followed by concatenated node labels.
 */
export function isMermaidGarbageText(text: string): boolean {
    if (!text) return false;
    if (/^#\S*mermaid\S*\s*\{/i.test(text)) return true;
    if (text.includes('edge-animation-frame')) return true;
    return (
        text.includes('#mermaid-') &&
        (text.includes('@keyframes') || text.includes('stroke-dasharray'))
    );
}

/**
 * The label tail of a rendered-mermaid text blob: everything after the
 * last CSS '}' is the concatenated node/edge labels.
 */
export function extractMermaidRenderedLabels(text: string): string {
    if (!text) return '';
    const tail = text.slice(text.lastIndexOf('}') + 1);
    const spaced = tail
        .replace(/([a-z0-9)])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
    return spaced;
}

/* ------------------------------------------------------------------ */
/*  SVG helpers                                                        */
/* ------------------------------------------------------------------ */

export function isMermaidSvg(svg: Element | null): boolean {
    if (!svg) return false;
    const id = svg.getAttribute('id') || '';
    const className = svg.getAttribute('class') || '';
    const roleDesc = svg.getAttribute('aria-roledescription') || '';
    return (
        id.startsWith('mermaid-') ||
        /\bmermaid\b/i.test(className) ||
        /\bflowchart\b/i.test(className) ||
        /flowchart/i.test(roleDesc)
    );
}

/**
 * Mermaid renders a diagram it could not parse as an SVG containing the
 * error message. Embedding that as an image ships a picture of an error.
 */
export function isMermaidErrorSvg(svgElement: Element | null): boolean {
    const text = svgElement?.textContent || '';
    return /syntax error|mermaid version|error rendering/i.test(text);
}

export function svgToDataUri(svgElement: Element): string {
    try {
        const serializer = new XMLSerializer();
        let svgText = serializer.serializeToString(svgElement);
        if (!/\sxmlns=/.test(svgText)) {
            svgText = svgText.replace(
                '<svg',
                '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
            );
        }
        svgText = svgText.replace(/>\s+</g, '><').trim();
        const encoded = encodeURIComponent(svgText).replace(/'/g, '%27').replace(/"/g, '%22');
        return `data:image/svg+xml;charset=utf-8,${encoded}`;
    } catch {
        return '';
    }
}

/**
 * `innerText` is not on every element type, and not at all outside a
 * browser; fall back to textContent.
 */
function innerTextOf(element: Element): string | undefined {
    return 'innerText' in element ? (element as HTMLElement).innerText : undefined;
}

export function buildMermaidPre(doc: Document, source: string): HTMLPreElement {
    const pre = doc.createElement('pre');
    pre.setAttribute('data-pagetomd-generated', 'mermaid');
    const code = doc.createElement('code');
    code.setAttribute('data-lang', 'mermaid');
    code.setAttribute('class', 'language-mermaid');
    code.textContent = source;
    pre.appendChild(code);
    return pre;
}

/**
 * Find the mermaid source that belongs to a rendered SVG: an explicit
 * attribute on the SVG or an ancestor, then a nearby `code.language-mermaid`
 * element in the same container, then anywhere in the document.
 */
export function extractMermaidSourceFromSvg(svgElement: Element | null): string {
    if (!svgElement) return '';

    const attrCandidates = ['data-source', 'data-mermaid', 'data-diagram', 'data-graph', 'data-code'];
    for (const attr of attrCandidates) {
        const value = svgElement.getAttribute(attr);
        if (value && /\S/.test(value)) return value.trim();
    }

    for (const attr of attrCandidates) {
        const el = svgElement.closest?.(`[${attr}]`);
        if (!el) continue;
        const value = el.getAttribute(attr);
        if (value && /\S/.test(value)) return value.trim();
    }

    const container = svgElement.closest('figure, div, section, article') || svgElement.parentElement;

    const selectors = [
        'pre code.language-mermaid',
        'code.language-mermaid',
        'pre.mermaid',
        'code.mermaid',
        'pre code[data-lang="mermaid"]',
        'code[data-lang="mermaid"]',
        'div.mermaid',
        'script[type="application/mermaid"]',
        'script[type="text/plain"][data-lang="mermaid"]'
    ];

    if (container) {
        for (const sel of selectors) {
            const el = container.querySelector(sel);
            if (!el) continue;
            if (el === svgElement) continue;
            if (el.closest?.('[data-pagetomd-generated="mermaid"]')) continue;
            const text = (innerTextOf(el) ?? el.textContent ?? '').trim();
            if (text) return text;
        }
    }

    const doc = svgElement.ownerDocument;
    if (doc) {
        for (const sel of selectors) {
            const el = doc.querySelector(sel);
            if (!el) continue;
            if (el.closest?.('[data-pagetomd-generated="mermaid"]')) continue;
            const text = (innerTextOf(el) ?? el.textContent ?? '').trim();
            if (text) return text;
        }
    }

    return '';
}

/**
 * Fallback pairing: when two diagrams of the same kind exist and only one
 * source was recovered, pair them by diagram type (graph/state/sequence)
 * in document order.
 */
export function pickMermaidSourceForSvg(
    svgElement: Element,
    sources: string[],
    startIndex: number
): { source: string; nextIndex: number; used: boolean } {
    const className = (svgElement?.getAttribute?.('class') || '').toLowerCase();
    const roleDesc = (svgElement?.getAttribute?.('aria-roledescription') || '').toLowerCase();

    let expected = 'graph';
    if (className.includes('statediagram') || roleDesc.includes('state')) expected = 'state';
    if (className.includes('sequencediagram') || roleDesc.includes('sequence')) expected = 'sequence';
    if (className.includes('flowchart') || roleDesc.includes('flowchart')) expected = 'graph';

    const matchesType = (src: string) => {
        const first = (src || '').split(/\r?\n/).map((l: string) => l.trim()).find(Boolean) || '';
        const lower = first.toLowerCase();
        if (expected === 'state') return lower.startsWith('statediagram');
        if (expected === 'sequence') return lower.startsWith('sequencediagram');
        return lower.startsWith('graph') || lower.startsWith('flowchart');
    };

    for (let i = startIndex; i < sources.length; i += 1) {
        const candidate = sources[i] || '';
        if (!candidate) continue;
        if (!matchesType(candidate)) continue;
        return { source: candidate, nextIndex: i + 1, used: true };
    }

    const fallback = sources[startIndex] || '';
    if (!fallback) return { source: '', nextIndex: startIndex, used: false };
    return { source: fallback, nextIndex: startIndex + 1, used: true };
}

/* ------------------------------------------------------------------ */
/*  Extraction context                                                 */
/* ------------------------------------------------------------------ */

export interface MermaidContext {
    sources: string[];
    consumed: Set<string>;
    used: Set<string>;
}

export interface MermaidRanked extends MermaidScore {
    source: string;
}

export interface MermaidScore {
    score: number;
    hits: number;
    labelScore?: number;
    labelHits?: number;
    tokenScore?: number;
    tokenHits?: number;
}

export interface MermaidStats {
    svgSeen: number;
    svgReplaced: number;
    svgEmbedded: number;
    svgPlaceholder: number;
    garbageRecovered: number;
    garbagePlaceholders: number;
    sourcesUsed: number;
}

/**
 * @param {string} pageHtml raw HTML of the page (may embed script payloads)
 * @returns {MermaidContext}
 */
export function createMermaidContext(pageHtml: string): MermaidContext {
    return {
        // The selection HTML and the page payload overlap, so a fence that
        // survived extraction arrives twice. pickMermaidSourceForSvg walks
        // this list by index; a duplicate would hand the same source to a
        // second SVG and strand the real one.
        sources: [...new Set(collectMermaidSources(pageHtml))],
        consumed: new Set(),
        used: new Set()
    };
}

/* ------------------------------------------------------------------ */
/*  Applying mermaid handling to extracted content                      */
/* ------------------------------------------------------------------ */

/**
 * Convert every mermaid representation inside `doc` (a parsed document
 * holding the *selected* content) into a fenced ` ```mermaid ` block.
 *
 * @param {Document} doc parsed document whose body holds the selection
 * @param {MermaidContext} ctx
 * @returns {object} stats
 */
export function applyMermaidToDoc(doc: Document, ctx: MermaidContext): MermaidStats {
    const stats = {
        svgSeen: 0,
        svgReplaced: 0,
        svgEmbedded: 0,
        svgPlaceholder: 0,
        garbageRecovered: 0,
        garbagePlaceholders: 0,
        sourcesUsed: 0
    };

    const body = doc.body || doc.documentElement;
    if (!body) return stats;

    /* --- rendered SVGs ------------------------------------------- */
    let sourceCursor = 0;
    for (const svg of Array.from(body.querySelectorAll('svg'))) {
        if (!isMermaidSvg(svg)) continue;
        stats.svgSeen += 1;

        let source = extractMermaidSourceFromSvg(svg);

        if (!source) {
            source = matchMermaidSourceByText(svg.textContent || '', ctx.sources, ctx.consumed);
        }

        if (!source && sourceCursor < ctx.sources.length) {
            const pick = pickMermaidSourceForSvg(svg, ctx.sources, sourceCursor);
            source = pick.source;
            sourceCursor = pick.nextIndex;
        }

        if (!source) {
            if (isMermaidErrorSvg(svg)) {
                // The page's renderer could not parse the diagram — say so
                // instead of embedding a picture of an error message.
                const note = doc.createElement('p');
                note.textContent = '[Mermaid diagram omitted: the page could not render it]';
                svg.replaceWith(note);
                stats.svgPlaceholder += 1;
                continue;
            }
            const dataUri = svgToDataUri(svg);
            if (dataUri) {
                const img = doc.createElement('img');
                img.setAttribute('alt', 'Mermaid diagram');
                img.setAttribute('src', dataUri);
                svg.replaceWith(img);
                stats.svgEmbedded += 1;
            } else {
                const placeholder = doc.createElement('p');
                placeholder.textContent = '[Mermaid diagram omitted: source not found in page HTML]';
                svg.replaceWith(placeholder);
                stats.svgPlaceholder += 1;
            }
            continue;
        }

        ctx.consumed.add(source);
        ctx.used.add(source);
        stats.sourcesUsed += 1;
        svg.replaceWith(buildMermaidPre(doc, source));
        stats.svgReplaced += 1;
    }

    /* --- dissolved diagrams (CSS blob + glued labels) ------------- */
    for (const pre of Array.from(body.querySelectorAll('pre'))) {
        if (!body.contains(pre)) continue;

        const preText = (pre.textContent || '').trim();
        if (!preText || !isMermaidGarbageText(preText)) continue;

        const source = matchMermaidSourceByText(preText, ctx.sources, ctx.consumed);
        if (source) {
            ctx.consumed.add(source);
            ctx.used.add(source);
            stats.sourcesUsed += 1;
            stats.garbageRecovered += 1;
            pre.replaceWith(buildMermaidPre(doc, source));
        } else {
            const placeholder = doc.createElement('blockquote');
            const p = doc.createElement('p');
            const strong = doc.createElement('strong');
            strong.textContent = 'Diagram:';
            p.appendChild(strong);
            const labels = extractMermaidRenderedLabels(preText);
            p.appendChild(
                doc.createTextNode(labels ? ` ${labels}` : ' mermaid diagram (rendered source unavailable)')
            );
            placeholder.appendChild(p);
            pre.replaceWith(placeholder);
            stats.garbagePlaceholders += 1;
        }
    }

    return stats;
}

/* ------------------------------------------------------------------ */
/*  Rescuing diagrams the extractor dropped                            */
/* ------------------------------------------------------------------ */

/**
 * The extractor sometimes selects a container that does not contain a
 * diagram the page rendered. Instead of throwing the whole page away to
 * get it back, recover the diagram's source and place it into the
 * selection — after the heading it sat under on the live page, or at the
 * end of the selection when no heading matches.
 *
 * @param {object} options
 * @param {Document} options.liveDoc the live page document
 * @param {Document} options.selectionDoc parsed document holding the selection
 * @param {MermaidContext} options.ctx
 * @returns {object} stats
 */
export function rescueMissingDiagrams({
    liveDoc,
    selectionDoc,
    ctx
}: {
    liveDoc: Document | null;
    selectionDoc: Document;
    ctx: MermaidContext;
}): { inspected: number; injected: number } {
    const stats = { inspected: 0, injected: 0 };
    if (!liveDoc || !selectionDoc) return stats;

    const selectionBody = selectionDoc.body || selectionDoc.documentElement;
    if (!selectionBody) return stats;

    for (const svg of Array.from(liveDoc.querySelectorAll('svg'))) {
        if (!isMermaidSvg(svg)) continue;
        stats.inspected += 1;

        const labels = svg.textContent || '';

        // Already in the output? Either the selection kept the SVG (and the
        // source was consumed) or the selection carries a dissolved copy of
        // the same diagram (the recovered source explains its labels).
        if (ctx.used.has(extractMermaidSourceFromSvg(svg))) continue;
        let represented = false;
        for (const source of ctx.used) {
            if (sourceExplainsLabels(source, labels)) {
                represented = true;
                break;
            }
        }
        if (represented) continue;

        const source =
            extractMermaidSourceFromSvg(svg) ||
            matchMermaidSourceByText(labels, ctx.sources, ctx.consumed);
        if (!source) continue;

        ctx.consumed.add(source);
        ctx.used.add(source);
        stats.injected += 1;

        const pre = buildMermaidPre(selectionDoc, source);
        const anchor = findAnchorHeading(svg);
        const headingText = anchor ? normalizeHeadingText(anchor.textContent || '') : '';
        const target = headingText
            ? findHeadingInSelection(selectionBody, headingText)
            : null;

        if (target) {
            target.insertAdjacentElement('afterend', pre);
        } else {
            selectionBody.appendChild(pre);
        }
    }

    return stats;
}

function normalizeHeadingText(text: string): string {
    return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The nearest heading above `element` in the live page.
 */
function findAnchorHeading(element: Element): Element | null {
    let node: Element | null = element;
    while (node && node.nodeType === 1) {
        let sibling = node.previousElementSibling;
        while (sibling) {
            if (sibling.matches?.('h1, h2, h3, h4, h5, h6')) return sibling;
            const nested = sibling.querySelector?.('h1, h2, h3, h4, h5, h6');
            if (nested) return nested;
            sibling = sibling.previousElementSibling;
        }
        node = node.parentElement;
    }
    return null;
}

function findHeadingInSelection(body: Element, normalizedText: string): Element | null {
    for (const heading of Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
        if (normalizeHeadingText(heading.textContent || '') === normalizedText) return heading;
    }
    return null;
}
