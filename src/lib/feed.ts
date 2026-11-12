/**
 * Infinite-feed trim (issue #28).
 *
 * Some news sites stream the *next* articles below the one you opened
 * (newrepublic.com and friends), keeping every loaded post as a sibling
 * `<article>`. Defuddle scores the wrapper that contains them all, so a
 * save concatenates whole unrelated articles.
 *
 * Feed posts identify themselves: each one's share-intent links embed its
 * own URL. Exactly one article's share links point at the page you are on
 * — the one you are reading. Articles that self-identify with a different
 * URL are feed fill and are dropped. Articles without share links
 * (related-content cards) and ambiguous or unmatched pages are left alone,
 * so multi-article pages that defuddle handles well keep working.
 */

import { SHARE_HREF_PATTERN } from './noise.js';

export interface FeedTrimResult {
    /** <article> elements found in the page body. */
    articles: number;
    /** Feed articles removed. */
    removed: number;
}

/** Extract absolute http(s) URLs embedded in a share-intent href. */
function embeddedUrls(href: string): string[] {
    // Share intents embed the article URL both raw ("?text=Title https://…")
    // and percent-encoded ("?url=https%3A%2F%2F…"). Try both spellings.
    const candidates = [href];
    try {
        candidates.push(decodeURIComponent(href));
    } catch {
        // Malformed escapes — the raw href still holds the raw spelling.
    }

    const urls: string[] = [];
    for (const candidate of candidates) {
        for (const match of candidate.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
            // Prose can glue trailing punctuation onto a bare URL.
            urls.push(match[0].replace(/[.,;:!?]+$/, ''));
        }
    }
    return urls;
}

/** Compare URLs by origin + path, ignoring protocol-relative and slash noise. */
function normalizeUrl(raw: string, base: string): string | null {
    try {
        const url = new URL(raw, base);
        return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
        return null;
    }
}

/**
 * Collect the article URLs a post's share links advertise as "share me".
 * An article sharing only its own URL yields exactly one entry.
 */
function collectSelfUrls(article: Element, base: string): Set<string> {
    const urls = new Set<string>();
    for (const link of Array.from(article.querySelectorAll('a[href]'))) {
        const href = link.getAttribute('href') || '';
        if (!SHARE_HREF_PATTERN.test(href)) continue;
        for (const raw of embeddedUrls(href)) {
            const normalized = normalizeUrl(raw, base);
            if (normalized) urls.add(normalized);
        }
    }
    return urls;
}

export function trimFeedArticles(
    root: Element | null,
    pageUrl: string,
    log: (...args: unknown[]) => void = () => {}
): FeedTrimResult {
    const result: FeedTrimResult = { articles: 0, removed: 0 };
    if (!root) return result;

    const page = normalizeUrl(pageUrl, pageUrl);
    if (!page) return result;

    const articles = Array.from(root.querySelectorAll('article'));
    result.articles = articles.length;
    if (articles.length < 2) return result;

    const selfUrls = articles.map((article) => collectSelfUrls(article, pageUrl));

    // The article being read shares the page's own URL. A wrapper that
    // contains it (newrepublic nests posts inside an outer <article>)
    // counts as part of it, so only the innermost matches decide; a page
    // whose every card shares the listing URL (a feed index) has several.
    const isMatch = articles.map((_, i) => selfUrls[i].has(page));
    const innermostMatches = articles.filter(
        (article, i) =>
            isMatch[i] &&
            !articles.some((other, j) => isMatch[j] && other !== article && article.contains(other))
    );
    if (innermostMatches.length !== 1) {
        // No self-shared article, or several siblings each sharing the page
        // URL: not a recognisable single-article feed, keep everything.
        return result;
    }
    const match = innermostMatches[0];

    const toRemove = articles.filter(
        (article, i) => article !== match && !article.contains(match) && selfUrls[i].size > 0
    );
    for (const article of toRemove) {
        article.remove();
        result.removed += 1;
    }

    if (result.removed > 0) {
        log('trimFeedArticles removed infinite-feed articles', result);
    }
    return result;
}
