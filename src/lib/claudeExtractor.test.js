import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { extractClaudeConversation, isClaudeConversationPage } from './claudeExtractor.js';

function createDocument(html, url) {
    const window = new Window();
    window.document.body.innerHTML = html;
    window.location.href = url;
    return window.document;
}

const chatUrl = 'https://claude.ai/chat/3f6ffb5d-b4db-4c83-9976-d17f65be31ef';

const sampleHtml = `
    <div data-testid="chat-title-split"><button aria-label="Prompt structure for better AI requests, rename chat"><span>Prompt structure for better AI requests</span></button></div>
    <aside>Sidebar noise: Chats and tasks, Some other chat</aside>
    <div data-testid="transcript-list">
        <div data-testid="transcript-row" data-perf-row="human" data-index="0">
            <div role="article" tabindex="0" aria-label="Message 1 of 2" data-turn-key="aaa">
                <h2 data-find-omitted="" class="sr-only select-none">You said: what do you think of my prompt</h2>
                <div data-cds="UserMessage">
                    <div class="cds-user-message-body">
                        <div data-testid="user-message">
                            <p>what do you think of my prompt to improve prompts xD</p>
                            <div><div><pre class="code-block__code"><code>Help me turn the following prompt into a good prompt. A good prompt has:

- Goal
  The outcome wanted and the reason behind it.

Fill gaps with explicit, labeled assumptions instead of asking.

Prompt:</code></pre></div></div>
                        </div>
                    </div>
                    <button aria-expanded="false">Show more</button>
                </div>
                <div data-cds="MessageActions" role="toolbar"><time datetime="2026-10-15T18:35:32.733Z">17 minutes ago</time><button aria-label="Retry">Retry</button><button aria-label="Copy">Copy</button></div>
            </div>
        </div>
        <div data-testid="transcript-row" data-perf-row="assistant" data-index="1">
            <div role="article" tabindex="-1" aria-label="Message 2 of 2" data-turn-key="bbb">
                <h2 data-find-omitted="" class="sr-only select-none">Claude responded: Honestly, it's good.</h2>
                <div data-cds="TurnStatus"><p>Thought for 12s</p><p>Reviewing a meta-prompt</p><button aria-expanded="true">Collapse</button></div>
                <div data-cds="AssistantMessage" data-testid="assistant-message">
                    <div data-perf-reply-text=""><p>Honestly, it's good. The best parts are the specifics.</p>
                    <ul><li>It contradicts itself on questions.</li></ul>
                    <div><div><pre class="code-block__code"><code>Rewrite the prompt inside &lt;prompt&gt; so another model can execute it well.</code></pre></div></div></div>
                </div>
                <div data-cds="MessageActions" role="toolbar"><button aria-label="Copy">Copy</button><button aria-label="Good response">Good</button><time datetime="2026-10-15T18:35:51.216Z">17 minutes ago</time></div>
            </div>
        </div>
    </div>
    <div>Write a message…</div>
`;

describe('claudeExtractor', () => {
    it('identifies Claude conversation pages', () => {
        expect(isClaudeConversationPage(createDocument(sampleHtml, chatUrl))).toBe(true);
        expect(
            isClaudeConversationPage(
                createDocument(sampleHtml, 'https://claude.com/chat/abc123')
            )
        ).toBe(true);
        expect(isClaudeConversationPage(createDocument(sampleHtml, 'https://claude.ai/new'))).toBe(
            false
        );
        expect(
            isClaudeConversationPage(createDocument(sampleHtml, 'https://example.com/chat/abc'))
        ).toBe(false);
    });

    it('extracts the full conversation in order with speaker roles', () => {
        const doc = createDocument(sampleHtml, chatUrl);
        const result = extractClaudeConversation(doc);
        expect(result).not.toBeNull();

        const sections = Array.from(
            result.article.querySelectorAll('section[data-speaker-role]')
        );
        expect(sections.map((s) => s.getAttribute('data-speaker-role'))).toEqual([
            'user',
            'assistant'
        ]);
        expect(sections.map((s) => s.querySelector('h3')?.textContent)).toEqual([
            'You',
            'Claude'
        ]);

        const text = result.article.textContent || '';
        // User message intact to the last line (was previously truncated)
        expect(text).toContain('what do you think of my prompt');
        expect(text).toContain('Help me turn the following prompt');
        expect(text).toContain('Prompt:');
        // Assistant message present (was previously dropped entirely)
        expect(text).toContain("Honestly, it's good");
        expect(text).toContain('It contradicts itself on questions');
        expect(text).toContain('Rewrite the prompt inside <prompt>');
    });

    it('strips UI chrome, thinking summaries, and page noise', () => {
        const doc = createDocument(sampleHtml, chatUrl);
        const result = extractClaudeConversation(doc);
        const text = result.article.textContent || '';

        expect(result.article.querySelector('button, [role="toolbar"], time')).toBeNull();
        expect(text).not.toContain('Show more');
        expect(text).not.toContain('Retry');
        expect(text).not.toContain('Thought for 12s');
        expect(text).not.toContain('Reviewing a meta-prompt');
        expect(text).not.toContain('You said:');
        expect(text).not.toContain('Claude responded:');
        // Sidebar and composer are outside the transcript and must not leak in
        expect(text).not.toContain('Sidebar noise');
        expect(text).not.toContain('Write a message');

        // Timestamps are preserved once, as message metadata
        const metas = result.article.querySelectorAll('p[data-message-meta="timestamp"]');
        expect(metas.length).toBe(2);
        expect(metas[0].textContent).toContain('2026-10-15');
    });

    it('provides title metadata from the chat header', () => {
        const doc = createDocument(sampleHtml, chatUrl);
        const result = extractClaudeConversation(doc);
        expect(result.metadataOverrides.title).toBe(
            'Prompt structure for better AI requests'
        );
        expect(result.metadataOverrides.tags).toContain('claude');
    });

    it('returns null when there is no transcript', () => {
        expect(
            extractClaudeConversation(createDocument('<div></div>', chatUrl))
        ).toBeNull();
        expect(
            extractClaudeConversation(createDocument(sampleHtml, 'https://example.com/chat/abc'))
        ).toBeNull();
    });
});
