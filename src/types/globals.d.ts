export {};

declare global {
    /**
     * Set by vitest in the worker thread. The extension scripts use it to
     * avoid installing themselves (and their listeners) inside the test
     * environment.
     */
    var __vitest_worker__: boolean | undefined;

    interface Window {
        /** happy-dom's test helper for pointing the document at a URL. */
        happyDOM?: { setURL(url: string): void };
    }
}
