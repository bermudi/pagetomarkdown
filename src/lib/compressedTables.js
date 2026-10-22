/**
 * Repair for tables that a documentation generator compressed into a code
 * block.
 *
 * DeepWiki (and generators that share its markdown pipeline) render a table
 * as a fenced block holding a compressed markdown table:
 *
 *     ## My Table
 *     | col1 | col2 ||| --- | --- ||| a | b ||| c | d |
 *
 * Rows are separated by `||`, cells by `|`. Shipped as-is the reader gets a
 * wall of pipes; repaired into a real table it reads like one.
 *
 * The detection is deliberately strict — uniform cell count, a separator row
 * in the second position, at least two columns — so that ordinary code
 * containing `||` is left alone.
 */

const SEPARATOR_CELL = /^:?-{2,}:?$/;

/**
 * @param {string} text
 * @returns {{heading: {level: number, text: string} | null, header: string[], rows: string[][]} | null}
 */
export function parseCompressedTable(text) {
    if (!text || !text.includes('||')) return null;

    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return null;

    let heading = null;
    let body = lines;
    const headingMatch = lines[0].match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
        heading = { level: headingMatch[1].length, text: headingMatch[2].trim() };
        body = lines.slice(1);
    }

    const chunks = body
        .join('\n')
        .split('||')
        .map((chunk) => chunk.replace(/\n/g, ' ').trim())
        .filter(Boolean);
    if (chunks.length < 2) return null;

    const rows = chunks.map((chunk) => {
        let cell = chunk.trim();
        if (cell.startsWith('|')) cell = cell.slice(1);
        if (cell.endsWith('|')) cell = cell.slice(0, -1);
        return cell.split('|').map((value) => value.trim());
    });

    const width = rows[0].length;
    if (width < 2) return null;
    if (!rows.every((row) => row.length === width)) return null;

    const separator = rows[1];
    if (!separator || !separator.every((cell) => SEPARATOR_CELL.test(cell))) return null;

    return { heading, header: rows[0], rows: rows.slice(2) };
}

/**
 * Build the DOM for a parsed compressed table.
 *
 * @param {Document} doc
 * @param {{heading: object | null, header: string[], rows: string[][]}} table
 */
export function buildTableElement(doc, table) {
    const fragment = doc.createDocumentFragment();

    if (table.heading) {
        const heading = doc.createElement(`h${Math.min(table.heading.level, 6)}`);
        heading.textContent = table.heading.text;
        fragment.appendChild(heading);
    }

    const element = doc.createElement('table');

    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const cell of table.header) {
        const th = doc.createElement('th');
        th.textContent = cell;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    element.appendChild(thead);

    const tbody = doc.createElement('tbody');
    for (const row of table.rows) {
        const tr = doc.createElement('tr');
        for (const cell of row) {
            const td = doc.createElement('td');
            td.textContent = cell;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    element.appendChild(tbody);

    fragment.appendChild(element);
    return fragment;
}
