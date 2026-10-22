/**
 * Page metadata for the YAML frontmatter.
 *
 * Everything here describes the page, not the extraction — except the word
 * count, which must describe what we actually ship.
 */

function getMeta(doc, names) {
    for (const name of names) {
        const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        if (el && el.content) return el.content.trim();
    }
    return null;
}

function extractTags(doc) {
    const tags = new Set();
    const keywords = doc.querySelector('meta[name="keywords"]');
    if (keywords && keywords.content) {
        keywords.content.split(',').forEach((t) => tags.add(t.trim()));
    }

    doc.querySelectorAll('.tags a, a[rel="tag"]').forEach((el) => {
        tags.add(el.textContent.trim());
    });

    return Array.from(tags).slice(0, 10);
}

/**
 * @param {object} options
 * @param {{element: Element, kind: string, wordCount?: number}} options.content
 * @param {object|null} [options.defuddleResult] defuddle's metadata for the page
 * @param {object|null} [options.overrides] extractor-provided overrides
 * @param {Document} [options.doc]
 * @param {Location} [options.location]
 */
export function extractMetadata({
    content,
    defuddleResult = null,
    overrides = null,
    doc = typeof document !== 'undefined' ? document : null,
    location = typeof window !== 'undefined' ? window.location : null
} = {}) {
    const def = defuddleResult;

    const titleFromMeta = getMeta(doc, ['og:title', 'twitter:title']);
    const sourceFromMeta = getMeta(doc, ['og:site_name', 'twitter:site', 'application-name']);
    const descriptionFromMeta = getMeta(doc, ['og:description', 'twitter:description', 'description']);
    const authorFromMeta = getMeta(doc, ['author', 'article:author', 'twitter:creator']);
    const hostname = location?.hostname || '';

    const metadata = {
        title: def?.title || titleFromMeta || doc?.title || 'Untitled',
        url: location?.href || '',
        domain: def?.domain || hostname.replace('www.', ''),
        source:
            sourceFromMeta ||
            def?.siteName ||
            def?.site ||
            def?.publication ||
            def?.domain ||
            hostname.replace('www.', ''),
        description: def?.description || descriptionFromMeta,
        author: def?.author || authorFromMeta,
        publishedDate: def?.published || getMeta(doc, ['article:published_time']),
        tags: extractTags(doc),
        wordCount: 0,
        readingTime: 0
    };

    // Count what we actually ship — the selection, not the live document
    // with all of its chrome. Defuddle's own count describes exactly the
    // selection we ship (and counts CJK per character, better than a
    // whitespace split); when we fell back to the page body we count the
    // body ourselves.
    const element = content?.element || doc?.body;
    const text = (element?.textContent || '') || '';
    metadata.wordCount = Number.isFinite(content?.wordCount)
        ? content.wordCount
        : text.trim()
          ? text.trim().split(/\s+/).length
          : 0;
    metadata.readingTime = Math.ceil(metadata.wordCount / 200);

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            if (value == null) continue;
            if (key === 'tags' && Array.isArray(value)) {
                metadata.tags = value.slice(0, 10);
                continue;
            }
            metadata[key] = value;
        }
    }

    return metadata;
}
