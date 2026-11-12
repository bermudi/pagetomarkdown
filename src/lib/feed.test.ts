import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { trimFeedArticles } from './feed.js';

const PAGE_URL = 'https://news.example/post/1/opened-article';

function createDocument(html: string): { doc: Document; window: Window } {
    const window = new Window({ url: PAGE_URL });
    window.document.body.innerHTML = html;
    // happy-dom's Document is not the DOM lib's Document, structurally.
    return { doc: window.document as unknown as Document, window };
}

/**
 * newrepublic.com shape: posts nested inside an outer <article> wrapper,
 * each post carrying share-intent links that embed its own URL — raw in
 * social intents, percent-encoded in reddit/mailto ones.
 */
const FEED_HTML = `
<main>
  <article class="wrapper">
    <div class="post-bodies">
      <article class="post" id="opened">
        <h1>Opened article</h1>
        <a href="https://bsky.app/intent/compose?text=Opened https://news.example/post/1/opened-article">share</a>
        <a href="https://reddit.com/submit?url=https%3A%2F%2Fnews.example%2Fpost%2F1%2Fopened-article">share</a>
        <p>Body of the opened article.</p>
      </article>
      <article class="post" id="feed-1">
        <h2>First feed article</h2>
        <a href="https://reddit.com/submit?url=https%3A%2F%2Fnews.example%2Fpost%2F2%2Ffirst-feed-article">share</a>
        <p>Body of the first feed article.</p>
      </article>
      <article class="post" id="feed-2">
        <h2>Second feed article</h2>
        <a href="https://bsky.app/intent/compose?text=Feed https://news.example/post/3/second-feed-article via @news">share</a>
        <p>Body of the second feed article.</p>
      </article>
    </div>
  </article>
</main>`;

describe('trimFeedArticles', () => {
    it('removes feed posts that self-identify as different articles', () => {
        const { doc } = createDocument(FEED_HTML);

        const result = trimFeedArticles(doc.body, PAGE_URL);

        expect(result).toEqual({ articles: 4, removed: 2 });
        expect(doc.body.textContent).toContain('Opened article');
        expect(doc.body.textContent).toContain('Body of the opened article.');
        expect(doc.body.textContent).not.toContain('feed article');
        // The wrapper containing the kept post survives.
        expect(doc.body.querySelector('article.wrapper')).not.toBeNull();
        expect(doc.body.querySelector('#opened')).not.toBeNull();
    });

    it('keeps the wrapper when it also shares the page URL above the post', () => {
        const { doc } = createDocument(`
<main>
  <article class="wrapper">
    <a href="https://reddit.com/submit?url=https%3A%2F%2Fnews.example%2Fpost%2F1%2Fopened-article">share page</a>
    <article class="post" id="opened">
      <h1>Opened article</h1>
      <a href="https://bsky.app/intent/compose?text=x https://news.example/post/1/opened-article">share</a>
    </article>
    <article class="post" id="feed-1">
      <a href="https://bsky.app/intent/compose?text=x https://news.example/post/9/other">share</a>
    </article>
  </article>
</main>`);

        const result = trimFeedArticles(doc.body, PAGE_URL);

        expect(result.removed).toBe(1);
        expect(doc.body.querySelector('#opened')).not.toBeNull();
        expect(doc.body.querySelector('.wrapper')).not.toBeNull();
        expect(doc.body.querySelector('#feed-1')).toBeNull();
    });

    it('keeps articles without share links (related-content cards)', () => {
        const { doc } = createDocument(`
<main>
  <article>
    <h1>Opened article</h1>
    <a href="https://bsky.app/intent/compose?text=x https://news.example/post/1/opened-article">share</a>
  </article>
  <article><h2>Related card without share links</h2></article>
</main>`);

        const result = trimFeedArticles(doc.body, PAGE_URL);

        expect(result.removed).toBe(0);
        expect(doc.body.textContent).toContain('Related card');
    });

    it('does nothing when no article shares the page URL', () => {
        const { doc } = createDocument(`
<main>
  <article><p>One</p><a href="https://reddit.com/submit?url=https%3A%2F%2Fnews.example%2Fpost%2F2%2Fa">s</a></article>
  <article><p>Two</p><a href="https://reddit.com/submit?url=https%3A%2F%2Fnews.example%2Fpost%2F3%2Fb">s</a></article>
</main>`);

        const result = trimFeedArticles(doc.body, PAGE_URL);

        expect(result.removed).toBe(0);
        expect(doc.body.querySelectorAll('article').length).toBe(2);
    });

    it('does nothing on an index page whose cards all share the listing URL', () => {
        const { doc } = createDocument(`
<main>
  <article><a href="https://bsky.app/intent/compose?text=x https://news.example/latest">s</a><p>One</p></article>
  <article><a href="https://bsky.app/intent/compose?text=x https://news.example/latest">s</a><p>Two</p></article>
</main>`);

        const result = trimFeedArticles(doc.body, 'https://news.example/latest');

        expect(result.removed).toBe(0);
        expect(doc.body.querySelectorAll('article').length).toBe(2);
    });

    it('does nothing for a single article', () => {
        const { doc } = createDocument(
            '<article><h1>Alone</h1><a href="https://bsky.app/intent/compose?text=x https://news.example/post/1/opened-article">s</a></article>'
        );

        const result = trimFeedArticles(doc.body, PAGE_URL);

        expect(result).toEqual({ articles: 1, removed: 0 });
        expect(doc.body.querySelector('article')).not.toBeNull();
    });
});
