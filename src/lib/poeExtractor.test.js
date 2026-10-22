import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { extractPoeConversation, isPoeConversationPage } from './poeExtractor.js';

function createDocument(html, url) {
    const window = new Window();
    window.document.body.innerHTML = html;
    window.location.href = url;
    return window.document;
}

const sampleHtml = `
    <div id="message-abc123" class="ChatMessage_chatMessage__xkgHx">
        <div class="ChatMessage_messageWrapper__4Ugd6 ChatMessage_rightSideMessageWrapper__r0roB">
            <div class="Message_messageTextContainer__w64Sc">
                <p>How do I center a div?</p>
            </div>
        </div>
    </div>
    <div id="message-def456" class="ChatMessage_chatMessage__xkgHx">
        <div class="ChatMessage_messageWrapper__4Ugd6">
            <div class="BotHeader_title__cURS_">helper-bot</div>
            <div class="Markdown_markdownContainer__Tz3HQ">
                <p>Use flexbox with <code>justify-content: center</code>.</p>
            </div>
            <div class="Message_messageMetadataText__FxY5_">Parameters</div>
            <div class="Message_messageMetadataText__FxY5_">2 minutes ago</div>
            <button class="ChatMessageOverflowButton_overflowButtonWrapper__gzb2s">More</button>
        </div>
    </div>
`;

describe('poeExtractor', () => {
    const poeUrl = 'https://poe.com/chat/abc123';

    it('recognizes Poe conversation pages', () => {
        const doc = createDocument(sampleHtml, poeUrl);
        expect(isPoeConversationPage(doc)).toBe(true);
    });

    it('ignores other sites', () => {
        const doc = createDocument(sampleHtml, 'https://example.com/chat/abc123');
        expect(isPoeConversationPage(doc)).toBe(false);
        expect(extractPoeConversation(doc)).toBeNull();
    });

    it('ignores Poe pages without a conversation', () => {
        const doc = createDocument('<div id="nothing">hi</div>', poeUrl);
        expect(isPoeConversationPage(doc)).toBe(false);
        expect(extractPoeConversation(doc)).toBeNull();
    });

    it('extracts every message with its role and speaker', () => {
        const doc = createDocument(sampleHtml, poeUrl);
        const result = extractPoeConversation(doc);
        expect(result).not.toBeNull();

        const { article } = result;
        const sections = article.querySelectorAll('section[data-speaker-role]');
        expect(sections.length).toBe(2);

        expect(sections[0].getAttribute('data-speaker-role')).toBe('user');
        expect(sections[0].getAttribute('data-speaker')).toBe('You');
        expect(sections[0].textContent).toContain('How do I center a div?');

        expect(sections[1].getAttribute('data-speaker-role')).toBe('assistant');
        expect(sections[1].getAttribute('data-speaker')).toBe('helper-bot');
        expect(sections[1].textContent).toContain('Use flexbox');
        // the "Parameters" label is metadata noise, the timestamp is not
        expect(sections[1].textContent).not.toContain('Parameters');
        expect(sections[1].textContent).toContain('2 minutes ago');
    });

    it('strips overflow buttons from the message body', () => {
        const doc = createDocument(sampleHtml, poeUrl);
        const { article } = extractPoeConversation(doc);
        expect(article.textContent).not.toContain('More');
    });

    it('exposes metadata overrides for the frontmatter', () => {
        const doc = createDocument(sampleHtml, poeUrl);
        doc.title = 'centering a div';
        const { metadataOverrides } = extractPoeConversation(doc);
        expect(metadataOverrides.title).toBe('centering a div');
        expect(metadataOverrides.author).toBe('helper-bot');
        expect(metadataOverrides.source).toBe('poe.com');
    });
});
