// What the transcript adapters share (claude.mjs, qwen.mjs, codex.mjs): a JSON-lines file read line by
// line, so a transcript of tens of megabytes is never held whole, and the names a tool call is
// recognised by in the shared record form. Host-specific knowledge stays in each adapter.
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * The entries of a folder, or none when it cannot be read: the error goes to `onError` and the crawl
 * goes on (a folder removed or locked while the machine is read must not stop the other hosts).
 *
 * @param {string} dir the folder
 * @param {(error: Error) => void} onError told of a folder that could not be read
 * @param {boolean} [missingOk] a folder that does not exist is not an error
 * @returns {import('node:fs').Dirent[]}
 */
export function entriesOf(dir, onError, missingOk = false) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (!(missingOk && e.code === 'ENOENT')) onError(e);
    return [];
  }
}

/** The kind a sub-agent call has in a normalized record's `tools`. */
export const DELEGATION = 'delegation';
/** The kind a structured question to the user has in a normalized record's `tools`. */
export const CHOICE_DIALOG = 'choice dialog';

/**
 * The JSON objects of a JSON-lines file, in order, with their line numbers. A line that is not
 * JSON (or not an object) is counted in `stats.unreadable` and left out.
 *
 * @param {string} file the transcript's path
 * @param {{ unreadable: number }} stats counters of the host being read
 * @returns {AsyncGenerator<{ value: object, line: number }>}
 */
export async function* jsonLines(file, stats) {
  const reader = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of reader) {
      line += 1;
      if (!text.trim()) continue;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        stats.unreadable += 1;
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) yield { value, line };
      else stats.unreadable += 1;
    }
  } finally {
    reader.close();
  }
}

/**
 * The text of the last of `texts` that is not blank.
 *
 * @param {string[]} texts text blocks in order
 * @returns {string|undefined} undefined when every block is blank
 */
export const lastText = (texts) => texts.findLast((t) => typeof t === 'string' && t.trim());
