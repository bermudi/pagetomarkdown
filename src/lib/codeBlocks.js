/**
 * Code block helpers: language detection and fence computation.
 */

/**
 * The language of a `pre`/`code` element, looked up in the places sites
 * put it: `data-lang`, `data-language`, `language-*`, `lang-*`, on the
 * element itself or on its `pre` parent.
 */
export function detectLanguageForPre(pre) {
    const codeElement = pre.querySelector('code');
    if (codeElement) {
        return detectLanguage(codeElement);
    }

    const dataLang = pre.getAttribute('data-lang') || pre.getAttribute('data-language');
    if (dataLang) return dataLang;

    const preClass = pre.className || '';
    const match = preClass.match(/language-(\w+)/) || preClass.match(/lang-(\w+)/);
    if (match) return match[1];

    return '';
}

/**
 * The language of a `code` element — or of the `pre` that wraps it.
 */
export function detectLanguage(codeElement) {
    let lang = codeElement.getAttribute('data-lang');
    if (lang) return lang;

    lang = codeElement.getAttribute('data-language');
    if (lang) return lang;

    const className = codeElement.className || '';
    let match = className.match(/language-(\w+)/);
    if (match) return match[1];

    match = className.match(/lang-(\w+)/);
    if (match) return match[1];

    const parentPre = codeElement.closest('pre');
    if (parentPre) {
        lang = parentPre.getAttribute('data-lang') || parentPre.getAttribute('data-language');
        if (lang) return lang;

        const preClass = parentPre.className || '';
        match = preClass.match(/language-(\w+)/) || preClass.match(/lang-(\w+)/);
        if (match) return match[1];
    }

    return '';
}

/**
 * A fence long enough to hold the code it wraps.
 */
export function computeFence(code) {
    const matches = code.match(/`+/g) || [];
    const max = matches.reduce((acc, m) => Math.max(acc, m.length), 0);
    return '`'.repeat(Math.max(3, max + 1));
}
