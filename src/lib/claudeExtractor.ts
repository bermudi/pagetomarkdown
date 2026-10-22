const CLAUDE_HOST_PATTERN = /(^|\.)claude\.ai$|(^|\.)claude\.com$/i;

function getLocation(doc: Document): Location | null {
    const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    return win?.location ?? null;
}

export interface ClaudeConversation {
    article: HTMLElement;
    metadataOverrides: Record<string, unknown>;
}

export function isClaudeConversationPage(doc: Document = document): boolean {
    const location = getLocation(doc);
    if (!location) return false;
    const host = location.hostname || '';
    const path = location.pathname || '';
    if (!CLAUDE_HOST_PATTERN.test(host)) return false;
    if (!/\/chat\//.test(path)) return false;
    return !!doc.querySelector(
        '[data-testid="transcript-list"] [data-testid="transcript-row"], [data-cds="UserMessage"], [data-cds="AssistantMessage"]'
    );
}

export function extractClaudeConversation(doc: Document = document): ClaudeConversation | null {
    if (!isClaudeConversationPage(doc)) {
        return null;
    }

    try {
        const rows = Array.from(doc.querySelectorAll('[data-testid="transcript-row"]'));
        if (!rows.length) return null;

        const article = doc.createElement('article');
        article.setAttribute('data-pagetomd-generated', 'claude-conversation');
        article.classList.add('pagetomd-claude-conversation');

        const titleText = extractClaudeTitle(doc);
        const title = doc.createElement('h1');
        title.textContent = titleText;
        article.appendChild(title);

        let addedMessages = 0;
        for (const row of rows) {
            const section = buildClaudeMessageSection(doc, row);
            if (!section) continue;
            article.appendChild(section);
            addedMessages += 1;
        }

        if (addedMessages === 0) return null;

        const firstUserText =
            article.querySelector('section[data-speaker-role="user"]')?.textContent?.trim() || '';
        const metadataOverrides = {
            title: titleText,
            author: null,
            description: firstUserText.slice(0, 280) || null,
            tags: ['claude']
        };

        return { article, metadataOverrides };
    } catch (error) {
        console.warn('[PageToMD] Failed to extract Claude conversation', error);
        return null;
    }
}

function buildClaudeMessageSection(doc: Document, row: Element): Element | null {
    const role = detectClaudeRole(row);
    const contentNode = findClaudeContentNode(row, role);
    if (!contentNode) return null;

    const section = doc.createElement('section');
    section.setAttribute('data-speaker-role', role);
    const speakerName = role === 'user' ? 'You' : role === 'assistant' ? 'Claude' : 'Message';
    section.setAttribute('data-speaker', speakerName);

    const heading = doc.createElement('h3');
    heading.textContent = speakerName;
    section.appendChild(heading);

    const clonedContent = contentNode.cloneNode(true) as Element;
    stripClaudeUiElements(clonedContent);
    if (!clonedContent.textContent?.trim() && !clonedContent.querySelector('img, pre, code')) {
        return null;
    }
    section.appendChild(clonedContent);

    const timestamp = extractClaudeTimestamp(row);
    if (timestamp) {
        const meta = doc.createElement('p');
        meta.textContent = timestamp;
        meta.setAttribute('data-message-meta', 'timestamp');
        section.appendChild(meta);
    }

    return section;
}

function detectClaudeRole(row: Element): string {
    const perf = row.getAttribute?.('data-perf-row');
    if (perf === 'human') return 'user';
    if (perf === 'assistant') return 'assistant';
    if (row.querySelector?.('[data-cds="UserMessage"], [data-testid="user-message"]')) return 'user';
    if (row.querySelector?.('[data-cds="AssistantMessage"], [data-testid="assistant-message"]')) {
        return 'assistant';
    }
    const heading = row.querySelector?.('h2[data-find-omitted], h2.sr-only');
    const text = heading?.textContent || '';
    if (/^\s*you said\b/i.test(text)) return 'user';
    if (/claude\s+(responded|said)\b/i.test(text)) return 'assistant';
    return 'unknown';
}

function findClaudeContentNode(row: Element, role: string): Element | null {
    if (role === 'user') {
        return (
            row.querySelector?.('[data-testid="user-message"]') ??
            row.querySelector?.('[data-cds="UserMessage"]')
        );
    }
    if (role === 'assistant') {
        return (
            row.querySelector?.('[data-testid="assistant-message"]') ??
            row.querySelector?.('[data-cds="AssistantMessage"]')
        );
    }
    return row.querySelector?.('div[role="article"]') ?? row;
}

function stripClaudeUiElements(node: Element): void {
    if (!node.querySelectorAll) return;
    // Thinking summaries are process metadata, not conversation content.
    node.querySelectorAll('[data-cds="TurnStatus"]').forEach((el) => el.remove());
    node.querySelectorAll('button, [role="toolbar"], [data-cds="MessageActions"], time').forEach((el) =>
        el.remove()
    );
    // Screen-reader duplicate labels ("You said: …", "Claude responded: …");
    // the section headings already carry the speaker.
    node.querySelectorAll('.sr-only').forEach((el) => el.remove());
}

function extractClaudeTimestamp(row: Element): string {
    const time = row.querySelector?.('time[datetime]');
    const datetime = time?.getAttribute?.('datetime');
    if (datetime) return datetime;
    return time?.textContent?.trim() || '';
}

function extractClaudeTitle(doc: Document): string {
    const labeled = doc.querySelector?.('[data-testid="chat-title-split"] [aria-label]');
    const label = labeled?.getAttribute?.('aria-label') || '';
    const rename = label.match(/^(.*?),\s*rename chat\s*$/i);
    if (rename?.[1]?.trim()) return rename[1].trim();
    const raw = doc.title || '';
    const cleaned = raw.replace(/\s*[-–—|]\s*Claude\s*$/i, '').trim();
    return cleaned || 'Claude Conversation';
}
