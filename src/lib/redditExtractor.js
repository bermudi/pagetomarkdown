const REDDIT_HOST_PATTERN = /(^|\.)reddit\.com$/i;

function getLocation(doc) {
    const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    return win?.location ?? null;
}

export function isRedditThreadPage(doc = document) {
    const location = getLocation(doc);
    if (!location) return false;
    const host = location.hostname || '';
    const path = location.pathname || '';
    if (!REDDIT_HOST_PATTERN.test(host)) return false;
    return /\/comments\//.test(path);
}

export function extractRedditThread(doc = document) {
    if (!isRedditThreadPage(doc)) {
        return null;
    }

    try {
        const article = doc.createElement('article');
        article.setAttribute('data-pagetomd-generated', 'reddit-thread');
        article.classList.add('pagetomd-reddit-thread');

        const header = doc.createElement('header');
        const title = doc.createElement('h1');
        const titleText = (doc.querySelector('a.title')?.textContent || doc.title || 'Reddit Thread').trim();
        title.textContent = titleText;
        header.appendChild(title);

        const postThing = doc.querySelector('#siteTable .thing.link') || doc.querySelector('.linklisting .thing.link');
        const postEntry = postThing?.querySelector('.entry');
        const postBody = postEntry?.querySelector('.usertext-body .md') || postEntry?.querySelector('.expando .md');

        const author = postEntry?.querySelector('.author')?.textContent?.trim() || null;
        const subreddit = doc.querySelector('#header-bottom-left .pagename a')?.textContent?.trim() ||
            (doc.querySelector('.redditname a')?.textContent?.trim() || null);
        const score = postEntry?.querySelector('.score')?.textContent?.trim() || null;
        const flair = postEntry?.querySelector('.linkflairlabel')?.textContent?.trim() || null;
        const timeEl = postEntry?.querySelector('time');
        const timeText = timeEl?.getAttribute('title') || timeEl?.textContent?.trim() || null;

        const metaParts = [];
        if (author) metaParts.push(`u/${author}`);
        if (subreddit) metaParts.push(`r/${subreddit}`);
        if (score) metaParts.push(score);
        if (flair) metaParts.push(flair);
        if (timeText) metaParts.push(timeText);

        if (metaParts.length) {
            const meta = doc.createElement('p');
            meta.setAttribute('data-reddit-meta', 'post');
            meta.textContent = metaParts.join(' • ');
            header.appendChild(meta);
        }

        article.appendChild(header);

        if (postBody) {
            const bodySection = doc.createElement('section');
            bodySection.classList.add('reddit-post-body');
            bodySection.appendChild(postBody.cloneNode(true));
            article.appendChild(bodySection);
        }

        const commentsRoot = doc.querySelector('.commentarea .sitetable');
        const commentsList = buildRedditCommentsList(doc, commentsRoot, 0);
        if (commentsList) {
            const commentsSection = doc.createElement('section');
            commentsSection.classList.add('reddit-comments');
            const h2 = doc.createElement('h2');
            h2.textContent = 'Comments';
            commentsSection.appendChild(h2);
            commentsSection.appendChild(commentsList);
            article.appendChild(commentsSection);
        }

        const descriptionSource = postBody?.textContent?.trim() || '';
        const description = descriptionSource.slice(0, 280) || null;
        const tags = ['reddit'];
        if (subreddit) tags.push(`r/${subreddit}`);

        const metadataOverrides = {
            title: titleText,
            author: author ? `u/${author}` : null,
            description,
            tags
        };

        return { article, metadataOverrides };
    } catch (error) {
        console.warn('[PageToMD] Failed to extract Reddit thread', error);
        return null;
    }
}

function buildRedditCommentsList(doc, sitetable, depth) {
    if (!sitetable) return null;

    const commentNodes = Array.from(sitetable.children).filter((node) =>
        node?.classList?.contains('comment')
    );

    if (!commentNodes.length) {
        return null;
    }

    const list = doc.createElement('ol');
    list.setAttribute('data-comment-depth', String(depth));

    for (const node of commentNodes) {
        if (node.classList.contains('deleted') && !node.querySelector('.entry')) {
            continue;
        }

        const entry = node.querySelector(':scope > .entry');
        if (!entry) continue;
        if (entry.classList.contains('morechildren')) continue;

        const bodySource = entry.querySelector('.usertext-body .md') || entry.querySelector('.usertext-body');
        const bodyClone = bodySource ? bodySource.cloneNode(true) : null;

        const author = entry.querySelector('.author')?.textContent?.trim() || '[deleted]';
        const score = entry.querySelector('.score')?.textContent?.trim() ||
            entry.querySelector('.score-hidden')?.textContent?.trim() || null;
        const timeEl = entry.querySelector('time');
        const timeText = timeEl?.getAttribute('title') || timeEl?.textContent?.trim() || null;

        const commentMeta = doc.createElement('p');
        commentMeta.setAttribute('data-reddit-meta', 'comment');
        const metaParts = [`u/${author}`];
        if (score) metaParts.push(score);
        if (timeText) metaParts.push(timeText);
        commentMeta.textContent = metaParts.join(' • ');

        const item = doc.createElement('li');
        item.appendChild(commentMeta);

        if (bodyClone) {
            item.appendChild(bodyClone);
        } else {
            const placeholder = doc.createElement('p');
            placeholder.textContent = '[comment body unavailable]';
            item.appendChild(placeholder);
        }

        const childTable = node.querySelector(':scope > .child > .sitetable');
        const replies = buildRedditCommentsList(doc, childTable, depth + 1);
        if (replies) {
            item.appendChild(replies);
        }

        list.appendChild(item);
    }

    if (!list.children.length) {
        return null;
    }

    return list;
}
