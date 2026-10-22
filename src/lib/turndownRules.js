/**
 * The turndown service: markdown output rules.
 *
 * The service is created once and configured with the options of the
 * current conversion — the rules read them when they run, not when they are
 * registered, so a single service serves both the "keep links" and the
 * "plain text" mode.
 */

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

import { computeFence, detectLanguage } from './codeBlocks.js';

/**
 * @param {object} options
 * @param {() => {stripLinks: boolean, stripImages: boolean}} options.getOptions
 * @param {(...args: unknown[]) => void} [options.log]
 * @returns {TurndownService}
 */
export function createTurndownService({ getOptions, log = () => {} }) {
    const turndown = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        fence: '```',
        preformattedCode: true,
        emDelimiter: '*',
        strongDelimiter: '**',
        linkStyle: 'inlined'
    });

    if (gfm) {
        turndown.use(gfm);
    }

    addCustomRules(turndown, { getOptions, log });

    return turndown;
}

function addCustomRules(turndown, { getOptions, log }) {
    turndown.addRule('stripLinks', {
        filter: (node) => getOptions().stripLinks && node.nodeName === 'A',
        replacement: (content) => content
    });

    turndown.addRule('stripImages', {
        filter: (node) => getOptions().stripImages && node.nodeName === 'IMG',
        replacement: (_content, node) => {
            const alt = (node.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
            if (!alt) return '';
            return `(Image: ${alt})`;
        }
    });

    turndown.addRule('preformattedCode', {
        filter: (node) => {
            const match = node.nodeName === 'PRE';
            if (match) {
                log('preformattedCode: filter matched PRE node');
            }
            return match;
        },
        replacement: (_content, node) => {
            log('preformattedCode: replacement called');
            const codeElement = node.querySelector('code');
            const language = codeElement ? detectLanguage(codeElement) : '';
            const code = (codeElement?.textContent ?? node.textContent ?? '').trim();

            if (!code) {
                log('preformattedCode: empty code block skipped');
                return '';
            }

            const fence = computeFence(code);
            const langSuffix = language ? language : '';
            const result = `\n\n${fence}${langSuffix}\n${code}\n${fence}\n\n`;
            log('preformattedCode: returning fenced block', { codeLen: code.length, lang: langSuffix });

            return result;
        }
    });

    prioritizeRule(turndown, 'preformattedCode');

    turndown.addRule('inlineCode', {
        filter: (node) => node.nodeName === 'CODE' && (!node.parentNode || node.parentNode.nodeName !== 'PRE'),
        replacement: (_content, node) => {
            const code = node.textContent || '';
            if (!code) return '';
            if (code.includes('`')) {
                return '``' + code + '``';
            }
            return '`' + code + '`';
        }
    });

    turndown.addRule('cleanHeadings', {
        filter: (node) => /^H[1-6]$/.test(node.nodeName),
        replacement: (_content, node) => {
            const level = Number.parseInt(node.nodeName.substring(1), 10);
            const hashes = '#'.repeat(level);
            const text = node.textContent.trim();
            return `\n\n${hashes} ${text}\n\n`;
        }
    });

    turndown.addRule('headingLinks', {
        filter: (node) => {
            if (/^H[1-6]$/.test(node.nodeName)) {
                const anchors = Array.from(node.querySelectorAll(':scope > a'));
                if (anchors.length === 1) return true;

                const nonWhitespaceChildren = Array.from(node.childNodes).filter(
                    (n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent.trim())
                );
                if (nonWhitespaceChildren.length === 1 && nonWhitespaceChildren[0].nodeName === 'A') {
                    return true;
                }
            }
            return false;
        },
        replacement: (_content, node) => {
            const level = Number.parseInt(node.nodeName.substring(1), 10);
            const hashes = '#'.repeat(level);
            const text = node.textContent.trim();
            return `\n\n${hashes} ${text}\n\n`;
        }
    });

    turndown.addRule('linkedHeadings', {
        filter: (node) => node.nodeName === 'A' && !!node.querySelector('h1, h2, h3, h4, h5, h6'),
        replacement: (_content, node) => {
            const heading = node.querySelector('h1, h2, h3, h4, h5, h6');
            const level = heading ? Number.parseInt(heading.nodeName.substring(1), 10) : 1;
            const hashes = '#'.repeat(level);
            const text = (heading ? heading.textContent : node.textContent || '').trim();
            return `\n\n${hashes} ${text}\n\n`;
        }
    });

    prioritizeRule(turndown, 'cleanHeadings');
    prioritizeRule(turndown, 'headingLinks');
    prioritizeRule(turndown, 'linkedHeadings');

    turndown.addRule('figure', {
        filter: 'figure',
        replacement: (content, node) => {
            const img = node.querySelector('img');
            const caption = node.querySelector('figcaption');

            let markdown = '';
            if (img) {
                const alt = img.getAttribute('alt') || '';
                const src = img.getAttribute('src') || '';
                if (getOptions().stripImages) {
                    const safeAlt = String(alt).trim().replace(/\s+/g, ' ');
                    if (safeAlt) {
                        markdown += `(Image: ${safeAlt})\n`;
                    }
                } else {
                    markdown += `![${alt}](${src})\n`;
                }
            }
            if (caption) {
                markdown += `*${caption.textContent.trim()}*\n`;
            }

            // Include any other converted content (e.g., code blocks inside figure)
            if (content && content.trim()) {
                markdown += content.trim() + '\n';
            }

            return markdown + '\n';
        }
    });

    turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'footer', 'nav']);

    prioritizeRule(turndown, 'stripLinks');
    prioritizeRule(turndown, 'stripImages');
}

/**
 * Move a rule to the front of the list — turndown evaluates rules in order.
 */
function prioritizeRule(turndown, name) {
    const rulesArray = turndown.rules.array;
    const index = rulesArray.findIndex((rule) => rule.key === name);
    if (index > 0) {
        const [rule] = rulesArray.splice(index, 1);
        rulesArray.unshift(rule);
    }
}
