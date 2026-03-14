import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { extractRedditThread, isRedditThreadPage } from './redditExtractor.js';

function createDocument(html, url) {
    const window = new Window();
    window.document.body.innerHTML = html;
    window.location.href = url;
    return window.document;
}

describe('redditExtractor', () => {
    const redditUrl = 'https://old.reddit.com/r/explainlikeimfive/comments/1rskdh6/thread/';
    const sampleHtml = `
        <div id="siteTable">
            <div class="thing link">
                <div class="entry">
                    <p class="title">
                        <a class="title" href="/r/explainlikeimfive">ELI5 title</a>
                    </p>
                    <span class="linkflairlabel">Engineering</span>
                    <p class="tagline">
                        <a class="author may-blank">bermudi86</a>
                        <span class="score">552 points</span>
                        <time title="Fri Mar 13 11:07:56 2026 UTC">9 hours ago</time>
                    </p>
                    <div class="usertext-body">
                        <div class="md">
                            <p>Post body text</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div id="header-bottom-left">
            <span class="pagename"><a>explainlikeimfive</a></span>
        </div>
        <div class="commentarea">
            <div class="sitetable">
                <div class="comment">
                    <div class="entry">
                        <p class="tagline">
                            <a class="author">commenter1</a>
                            <span class="score">[score hidden]</span>
                            <time title="Fri Mar 13 12:00:00 2026 UTC">8 hours ago</time>
                        </p>
                        <div class="usertext-body">
                            <div class="md"><p>First comment</p></div>
                        </div>
                    </div>
                    <div class="child">
                        <div class="sitetable">
                            <div class="comment">
                                <div class="entry">
                                    <p class="tagline">
                                        <a class="author">reply_user</a>
                                        <span class="score">42 points</span>
                                        <time>7 hours ago</time>
                                    </p>
                                    <div class="usertext-body">
                                        <div class="md"><p>Nested reply</p></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    it('identifies reddit comment pages', () => {
        const doc = createDocument('<div></div>', redditUrl);
        expect(isRedditThreadPage(doc)).toBe(true);

        const nonThreadDoc = createDocument('<div></div>', 'https://example.com/post');
        expect(isRedditThreadPage(nonThreadDoc)).toBe(false);
    });

    it('extracts article content, metadata, and comments', () => {
        const doc = createDocument(sampleHtml, redditUrl);
        const result = extractRedditThread(doc);
        expect(result).not.toBeNull();

        const { article, metadataOverrides } = result;
        const heading = article.querySelector('h1');
        expect(heading?.textContent).toContain('ELI5 title');

        const postMeta = article.querySelector('[data-reddit-meta="post"]');
        expect(postMeta?.textContent).toContain('u/bermudi86');
        expect(postMeta?.textContent).toContain('r/explainlikeimfive');

        const commentSection = article.querySelector('.reddit-comments');
        expect(commentSection).not.toBeNull();
        const comments = commentSection.querySelectorAll('ol[data-comment-depth] > li');
        expect(comments.length).toBeGreaterThan(0);
        const nestedList = commentSection.querySelector('ol[data-comment-depth="1"]');
        expect(nestedList).not.toBeNull();
        expect(nestedList?.textContent).toContain('Nested reply');

        expect(metadataOverrides).toMatchObject({
            title: 'ELI5 title',
            author: 'u/bermudi86'
        });
        expect(metadataOverrides?.tags).toEqual(['reddit', 'r/explainlikeimfive']);
        expect(metadataOverrides?.description).toContain('Post body text');
    });

    it('returns null on non-reddit hosts', () => {
        const doc = createDocument(sampleHtml, 'https://example.com/post');
        expect(extractRedditThread(doc)).toBeNull();
    });
});
