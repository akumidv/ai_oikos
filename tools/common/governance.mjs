// Repository governance read the same way on every code host: the totals of merged pull or merge
// requests (how many, how long from open to merge, how many were approved, how many their author
// merged) and the rules of a CODEOWNERS file. A host's tool reads its own records and hands them
// here as plain merge records or text.

const HOUR_MS = 3_600_000;

/**
 * The rules of a CODEOWNERS file: its lines without blanks, comments and GitLab's section headers
 * (`[Section]`, `^[Section][2] @owner`).
 *
 * @param {string} text the file
 * @returns {string[]} the rule lines, trimmed
 */
export function codeownersRules(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !/^\^?\[/.test(l));
}

/**
 * A merged pull or merge request as the totals read it.
 *
 * @typedef {object} MergeRecord
 * @property {string} createdAt when it was opened, ISO 8601
 * @property {string} mergedAt when it was merged, ISO 8601
 * @property {string|null} author the author's login
 * @property {string|null} mergedBy the login of who merged it
 * @property {string[]|null} approvers who approved it; null when the host did not say (no access)
 */

/**
 * The totals of merge records.
 *
 * @typedef {object} MergeTotals
 * @property {number} count the records
 * @property {number|null} medianHours median hours from open to merge; null without records
 * @property {number|null} meanHours mean hours from open to merge; null without records
 * @property {number|null} approvedShare share (0..1) with at least one approval, of those whose
 *   approvals are known; null when none is known
 * @property {number} approvalsKnown how many records carry their approvals
 * @property {number|null} selfMergedShare share (0..1) merged by their own author; null without records
 */

/** Hours from `createdAt` to `mergedAt` of a merge record. */
export const openHours = (record) => (Date.parse(record.mergedAt) - Date.parse(record.createdAt)) / HOUR_MS;

/** The median of a non-empty list of numbers. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The totals of `records`.
 *
 * @param {MergeRecord[]} records merged pull or merge requests
 * @returns {MergeTotals}
 */
export function mergeTotals(records) {
  const count = records.length;
  if (!count) return { count, medianHours: null, meanHours: null, approvedShare: null, approvalsKnown: 0, selfMergedShare: null };
  const hours = records.map(openHours);
  const known = records.filter((r) => Array.isArray(r.approvers));
  const self = records.filter((r) => r.author && r.author === r.mergedBy).length;
  return {
    count,
    medianHours: median(hours),
    meanHours: hours.reduce((a, b) => a + b, 0) / count,
    approvedShare: known.length ? known.filter((r) => r.approvers.length > 0).length / known.length : null,
    approvalsKnown: known.length,
    selfMergedShare: self / count,
  };
}

const percent = (share) => (share === null ? '?' : `${Math.round(share * 100)}%`);
const hoursText = (h) => (h === null ? '?' : `${h.toFixed(1)}h`);

/**
 * The totals as one line, e.g. `12 merged · open→merge median 5.2h, mean 20.1h · approved 75% · self-merged 8%`.
 *
 * @param {MergeTotals} totals from `mergeTotals`
 * @returns {string}
 */
export function totalsLine(totals) {
  const approvals = totals.approvalsKnown < totals.count ? ` (of ${totals.approvalsKnown} with known approvals)` : '';
  return `${totals.count} merged · open→merge median ${hoursText(totals.medianHours)}, mean ${hoursText(totals.meanHours)}`
    + ` · approved ${percent(totals.approvedShare)}${approvals} · self-merged ${percent(totals.selfMergedShare)}`;
}

/**
 * One merge record as a line: `#12  2026-10-01 → 2026-10-02 (26.5h)  @ada merged by @bob  approved: carol (3 reviews)  Title`.
 *
 * @param {MergeRecord & { number: number|string, title: string, reviews?: number|null, notes?: number|null }} record
 * @returns {string}
 */
export function mergeLine(record) {
  const approved = record.approvers === null ? 'approvals ?' : record.approvers.length ? `approved: ${record.approvers.join(', ')}` : 'no approval';
  const extra = [
    record.reviews !== undefined && record.reviews !== null ? `${record.reviews} review(s)` : null,
    record.notes !== undefined && record.notes !== null ? `${record.notes} note(s)` : null,
  ].filter(Boolean);
  return `${String(record.number).padStart(6)}  ${record.createdAt.slice(0, 10)} → ${record.mergedAt.slice(0, 10)} (${hoursText(openHours(record))})`
    + `  @${record.author || '?'} merged by @${record.mergedBy || '?'}  ${approved}${extra.length ? ` (${extra.join(', ')})` : ''}  ${record.title}`;
}

/**
 * Whether `value` is a calendar date written YYYY-MM-DD (a `--since`).
 *
 * @param {string} value what was given
 * @returns {boolean}
 */
export function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}
