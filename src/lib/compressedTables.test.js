import { describe, it, expect } from 'vitest';

import { buildTableElement, parseCompressedTable } from './compressedTables.js';

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

describe('parseCompressedTable', () => {
    it('parses a compressed table with a heading', () => {
        const table = parseCompressedTable(
            '## My Table\n| col1 | col2 ||| --- | --- ||| a | b ||| c | d |'
        );
        expect(table).not.toBeNull();
        expect(table.heading).toEqual({ level: 2, text: 'My Table' });
        expect(table.header).toEqual(['col1', 'col2']);
        expect(table.rows).toEqual([['a', 'b'], ['c', 'd']]);
    });

    it('parses a compressed table without a heading', () => {
        const table = parseCompressedTable('| a | b ||| --- | --- ||| 1 | 2 |');
        expect(table.heading).toBeNull();
        expect(table.header).toEqual(['a', 'b']);
        expect(table.rows).toEqual([['1', '2']]);
    });

    it('ignores ordinary code', () => {
        expect(parseCompressedTable('const x = a || b;')).toBeNull();
        expect(parseCompressedTable('npm run build || npm test')).toBeNull();
        expect(parseCompressedTable('a | b\nc | d')).toBeNull();
        expect(parseCompressedTable('')).toBeNull();
    });

    it('ignores rows with an uneven number of cells', () => {
        expect(parseCompressedTable('| a | b ||| --- | --- ||| 1 | 2 | 3 |')).toBeNull();
    });

    it('ignores a table without a separator row', () => {
        expect(parseCompressedTable('| a | b ||| 1 | 2 |')).toBeNull();
    });
});

describe('buildTableElement', () => {
    it('builds a heading and a real table', () => {
        const doc = parse('<body></body>');
        const table = parseCompressedTable('## My Table\n| col1 | col2 ||| --- | --- ||| a | b |');
        const fragment = buildTableElement(doc, table);
        doc.body.appendChild(fragment);

        expect(doc.body.querySelector('h2').textContent).toBe('My Table');
        const rows = doc.body.querySelectorAll('table tr');
        expect(rows.length).toBe(2);
        expect(Array.from(rows[0].querySelectorAll('th')).map((th) => th.textContent)).toEqual(['col1', 'col2']);
        expect(Array.from(rows[1].querySelectorAll('td')).map((td) => td.textContent)).toEqual(['a', 'b']);
    });
});
