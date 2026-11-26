import { getMeta } from './metadata';
import { pruneNoiseElements } from './noise';

const UNWALL_HOST_PATTERN = /(^|\.)unwall\.app$/i;
const MIN_ARTICLE_TEXT_LENGTH = 64;

export interface UnwallArticle {
    article: HTMLElement;
    metadataOverrides: Record<string, unknown>;
}

function getLocation(doc: Document): Location | null {
    const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    return win?.location ?? null;
}

function getFrameDocument(frame: HTMLIFrameElement): Document | null {
    try {
        return frame.contentDocument;
    } catch {
        return null;
    }
}

export function extractUnwallArticle(doc: Document = document): UnwallArticle | null {
    const location = getLocation(doc);
    if (!location || !UNWALL_HOST_PATTERN.test(location.hostname || '')) return null;

    const frame = doc.querySelector<HTMLIFrameElement>('iframe[title="Article content"]');
    if (!frame) return null;

    const frameDoc = getFrameDocument(frame);
    const frameArticle = frameDoc?.querySelector<HTMLElement>('article');
    if (!frameDoc || !frameArticle) return null;

    const article = frameArticle.cloneNode(true) as HTMLElement;
    article.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
    pruneNoiseElements(article);
    if ((article.textContent || '').trim().length < MIN_ARTICLE_TEXT_LENGTH) return null;

    const title =
        getMeta(frameDoc, ['og:title', 'twitter:title']) ||
        frameDoc.title.trim() ||
        doc.title.trim() ||
        'Untitled';

    return {
        article,
        metadataOverrides: {
            title,
            author: getMeta(frameDoc, ['author', 'article:author', 'twitter:creator']),
            description: getMeta(frameDoc, ['og:description', 'twitter:description', 'description']),
            publishedDate: getMeta(frameDoc, ['article:published_time', 'datePublished', 'publishDate']),
            source: getMeta(frameDoc, ['og:site_name', 'application-name'])
        }
    };
}
