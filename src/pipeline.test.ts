import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: { local: { get: async () => ({ debugLogging: false }) } },
    runtime: { onMessage: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } },
    browserAction: { onClicked: { addListener: () => {} } },
    tabs: { sendMessage: async () => {} },
    downloads: { download: async () => {} },
  },
}));

import { AdvancedMarkdownConverter } from './content.js';

const FIXTURE_DIR = resolve('tests/fixtures/pipeline');
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

const readFixture = (name: string) => readFileSync(resolve(FIXTURE_DIR, name), 'utf8');

/**
 * Golden-file harness for the core conversion pipeline.
 *
 * `mode: 'page'` runs the whole pipeline (defuddle selection → markdown).
 * `mode: 'content'` treats the fixture as the already-selected content and
 * only exercises normalization + conversion — needed for real pages whose
 * element defuddle picks depends on layout metrics that happy-dom does
 * not have.
 */
function runFixture(converter: AdvancedMarkdownConverter, { file, url, mode }: {
    file: string;
    url: string;
    mode: 'page' | 'content';
}): string {
  const html = readFixture(file);
  window.happyDOM?.setURL(url);
  document.body.innerHTML = html;

  if (mode === 'content') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const element = doc.body;
    return converter.convertToMarkdown({
      element,
      html: element.innerHTML || '',
      kind: 'fixture'
    });
  }

  const content = converter.extractMainContent();
  return converter.convertToMarkdown(content);
}

function expectGolden(name: string, actual: string): void {
  const goldenPath = resolve(FIXTURE_DIR, `${name}.expected.md`);
  if (UPDATE_GOLDEN) {
    writeFileSync(goldenPath, actual.endsWith('\n') ? actual : `${actual}\n`);
    return;
  }
  const expected = readFixture(`${name}.expected.md`);
  expect(actual.trim()).toBe(expected.trim());
}

describe('core conversion pipeline (golden files)', () => {
  let converter: AdvancedMarkdownConverter;

  beforeAll(() => {
    converter = new AdvancedMarkdownConverter();
    converter.debug = false;
  });

  it('converts a real documentation article', () => {
    const markdown = runFixture(converter, {
      file: 'mermaid-docs.html',
      url: 'https://mermaid.js.org/intro/',
      mode: 'content'
    });
    expectGolden('mermaid-docs', markdown);
  });

  it('converts a page with navigation chrome and a diagram', () => {
    const markdown = runFixture(converter, {
      file: 'docs-shell.html',
      url: 'https://example.com/docs/overview',
      mode: 'page'
    });
    expectGolden('docs-shell', markdown);
  });

  // Real DeepWiki page (deepwiki.com/microsoft/vscode), captured from a live
  // browser. Defuddle dissolves the rendered diagram into CSS + glued labels,
  // so the source has to be recovered from the page payload.
  it('converts a DeepWiki page and recovers its diagram', () => {
    const markdown = runFixture(converter, {
      file: 'deepwiki.html',
      url: 'https://deepwiki.com/microsoft/vscode',
      mode: 'content'
    });
    expect(markdown).toContain('```mermaid');
    expect(markdown).toContain('CodeMain["CodeMain"]');
    expect(markdown).not.toContain('edge-animation-frame');
    expect(markdown).not.toContain('@keyframes');
    expectGolden('deepwiki', markdown);
  });
});
