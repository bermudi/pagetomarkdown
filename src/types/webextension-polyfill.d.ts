// webextension-polyfill ships no type declarations; it exposes the same API
// as the browser global, typed by @types/firefox-webext-browser.
declare module 'webextension-polyfill' {
    const browserPolyfill: typeof browser;
    export default browserPolyfill;
}
