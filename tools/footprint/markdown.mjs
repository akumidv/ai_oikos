// The markdown pieces the report and its fact sections share.

/**
 * A markdown table; a `|` inside a cell is escaped and a missing value is an empty cell.
 *
 * @param {string[]} header the column names
 * @param {unknown[][]} rows one array of cells per row
 * @returns {string[]} the table's lines
 */
export const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
];

/**
 * A count of lines, short: 950, 1.2k, 15k.
 *
 * @param {number} n
 * @returns {string}
 */
export const short = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * Lines added and deleted, a zero shown as `+0` / `−0` (an empty cell would read as not known).
 *
 * @param {[number, number]} lines `[added, deleted]`
 * @returns {string}
 */
export const plusMinusTight = ([added, deleted]) => `+${short(added)} −${short(deleted)}`;
