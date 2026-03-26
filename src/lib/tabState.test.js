import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { preserveActiveTabs } from './tabState.js';

function createDocument(html) {
    const window = new Window();
    window.document.body.innerHTML = html;
    return window.document;
}

describe('tabState', () => {
    it('preserves only the active tab panel when tabs are aria-linked', () => {
        const doc = createDocument(`
            <section>
                <div role="tablist" data-geist-tabs>
                    <button role="tab" aria-controls="panel-gateway" aria-selected="false">Gateway</button>
                    <button role="tab" aria-controls="panel-provider" aria-selected="true">Provider</button>
                    <button role="tab" aria-controls="panel-custom" aria-selected="false">Custom</button>
                </div>
                <div id="panel-gateway" role="tabpanel"><pre><code>gateway-code</code></pre></div>
                <div id="panel-provider" role="tabpanel"><pre><code>provider-code</code></pre></div>
                <div id="panel-custom" role="tabpanel"><pre><code>custom-code</code></pre></div>
            </section>
        `);

        const result = preserveActiveTabs(doc.body);

        expect(result).toEqual({ tablistsProcessed: 1, panelsRemoved: 2 });
        expect(doc.body.textContent).toContain('provider-code');
        expect(doc.body.textContent).not.toContain('gateway-code');
        expect(doc.body.textContent).not.toContain('custom-code');
        expect(doc.getElementById('panel-provider')).not.toBeNull();
        expect(doc.getElementById('panel-gateway')).toBeNull();
        expect(doc.getElementById('panel-custom')).toBeNull();
    });

    it('does nothing when there is no active tab metadata', () => {
        const doc = createDocument(`
            <section>
                <div role="tablist">
                    <button role="tab">First</button>
                    <button role="tab">Second</button>
                </div>
                <div><pre><code>first-code</code></pre></div>
                <div><pre><code>second-code</code></pre></div>
            </section>
        `);

        const result = preserveActiveTabs(doc.body);

        expect(result).toEqual({ tablistsProcessed: 0, panelsRemoved: 0 });
        expect(doc.body.textContent).toContain('first-code');
        expect(doc.body.textContent).toContain('second-code');
    });
});
