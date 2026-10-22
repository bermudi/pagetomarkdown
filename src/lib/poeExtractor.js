const POE_HOST_PATTERN = /(^|\.)poe\.com$/i;

// Poe ships hashed class names; these are the ones the transcript layout
// depends on. When Poe renames them the extractor simply finds nothing and
// the generic defuddle path takes over.
const MESSAGE_SELECTOR = '[id^="message-"].ChatMessage_chatMessage__xkgHx';

function getLocation(doc) {
    const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    return win?.location ?? null;
}

export function isPoeConversationPage(doc = document) {
    const location = getLocation(doc);
    if (!location) return false;
    if (!POE_HOST_PATTERN.test(location.hostname || '')) return false;
    return !!doc.querySelector(MESSAGE_SELECTOR);
}

/**
 * Extract a Poe conversation into a clean article element.
 *
 * @param {Document} doc
 * @returns {{article: HTMLElement, metadataOverrides: object} | null}
 */
export function extractPoeConversation(doc = document) {
    try {
        if (!isPoeConversationPage(doc)) return null;

        const messageNodes = Array.from(doc.querySelectorAll(MESSAGE_SELECTOR));
        if (!messageNodes.length) return null;

        const article = doc.createElement('article');
        article.setAttribute('data-pagetomd-generated', 'poe-conversation');
        article.classList.add('pagetomd-poe-conversation');

        const title = doc.createElement('h1');
        title.textContent = doc.title || 'Poe Conversation';
        article.appendChild(title);

        let addedMessages = 0;
        let assistantSpeaker = null;
        let firstSpeaker = null;
        for (const node of messageNodes) {
            const section = buildPoeMessageSection(doc, node);
            if (!section) continue;
            article.appendChild(section);
            addedMessages += 1;
            const speaker = section.getAttribute('data-speaker') || null;
            if (!firstSpeaker) firstSpeaker = speaker;
            if (!assistantSpeaker && section.getAttribute('data-speaker-role') === 'assistant') {
                assistantSpeaker = speaker;
            }
        }

        if (addedMessages === 0) return null;

        const metadataOverrides = {
            title: doc.title || 'Poe Conversation',
            author: assistantSpeaker || firstSpeaker,
            source: 'poe.com'
        };

        return { article, metadataOverrides };
    } catch (error) {
        console.warn('[PageToMD] Failed to extract Poe conversation', error);
        return null;
    }
}

function buildPoeMessageSection(doc, messageNode) {
    const wrapper = messageNode.querySelector('.ChatMessage_messageWrapper__4Ugd6');
    const isUser = wrapper?.classList?.contains('ChatMessage_rightSideMessageWrapper__r0roB') ?? false;
    const role = isUser ? 'user' : 'assistant';
    const speakerName = extractPoeSpeakerName(messageNode, role);

    const contentNode =
        messageNode.querySelector('.Message_messageTextContainer__w64Sc') ??
        messageNode.querySelector('.Message_selectableText__SQ8WH') ??
        messageNode.querySelector('.Markdown_markdownContainer__Tz3HQ') ??
        messageNode.querySelector('.Message_messageBubbleWrapper__sEq8z');

    const attachmentsNode = messageNode.querySelector('.Attachments_attachments__x_H2Q');

    if (!contentNode && !attachmentsNode) {
        return null;
    }

    const section = doc.createElement('section');
    section.setAttribute('data-speaker-role', role);
    if (speakerName) {
        section.setAttribute('data-speaker', speakerName);
    }

    const heading = doc.createElement('h3');
    heading.textContent = speakerName || (isUser ? 'You' : 'Assistant');
    section.appendChild(heading);

    if (contentNode) {
        const clonedContent = contentNode.cloneNode(true);
        stripPoeUiElements(clonedContent);
        section.appendChild(clonedContent);
    }

    if (attachmentsNode) {
        section.appendChild(attachmentsNode.cloneNode(true));
    }

    const timestamp = extractPoeMessageTimestamp(messageNode);
    if (timestamp) {
        const meta = doc.createElement('p');
        meta.textContent = timestamp;
        meta.setAttribute('data-message-meta', 'timestamp');
        section.appendChild(meta);
    }

    return section;
}

function extractPoeSpeakerName(messageNode, role) {
    if (role === 'user') {
        return 'You';
    }

    const botHeader = messageNode.querySelector('.BotHeader_title__cURS_');
    const text = botHeader?.textContent?.trim();
    if (text) return text;

    const avatarAlt = messageNode.querySelector('.Avatar_root__rwLF0 img')?.getAttribute('alt');
    if (avatarAlt) return avatarAlt.replace(/^Bot image for\s*/i, '').trim();

    return 'Assistant';
}

function extractPoeMessageTimestamp(messageNode) {
    const metaTexts = Array.from(
        messageNode.querySelectorAll('.Message_messageMetadataText__FxY5_')
    )
        .map((el) => el.textContent?.trim())
        .filter((text) => text && text !== 'Parameters' && text !== '·');

    if (!metaTexts.length) return '';

    const candidate = metaTexts[metaTexts.length - 1];
    if (!candidate) return '';

    return candidate;
}

function stripPoeUiElements(node) {
    node.querySelectorAll('.MessageOverflowActions_overflowActionsWrapper__uC5oj').forEach((el) =>
        el.remove()
    );
    node.querySelectorAll('.ChatMessageOverflowButton_overflowButtonWrapper__gzb2s').forEach((el) =>
        el.remove()
    );
    node.querySelectorAll('button').forEach((el) => el.remove());
}
