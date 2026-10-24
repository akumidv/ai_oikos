// One wait on a rate limit: a per-item read of a source (a Jira issue's changelog, a GitLab merge
// request and its diff) that the site answers with 429 is asked once more after the wait the site
// names in retry-after, as the github source does for its queries; a second 429 in a row fails the
// read.
import { HttpError } from '../../common/http.mjs';

/** The wait after a 429 that names no retry-after. */
export const RATE_LIMIT_PAUSE_MS = 60_000;

const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * The wait a 429 asks for: its retry-after in seconds, else `fallbackMs`.
 *
 * @param {HttpError} error the 429
 * @param {number} fallbackMs the wait when the answer names none
 * @returns {number} ms
 */
function waitOf(error, fallbackMs) {
  const retryAfter = error.headers?.get?.('retry-after');
  return retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : fallbackMs;
}

/**
 * `read()`, asked once more after a wait when the site answers 429.
 *
 * @template T
 * @param {() => Promise<T>} read the request
 * @param {{ pauseMs?: number, waits?: number[] }} [options] `pauseMs` the wait when the 429 names
 *   none; each wait (ms) is pushed to `waits`, for the source's notes
 * @returns {Promise<T>} what `read` answered
 * @throws {HttpError} a second 429 in a row, or any other failure of `read`
 */
export async function readWithRateLimit(read, { pauseMs = RATE_LIMIT_PAUSE_MS, waits = [] } = {}) {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 429)) throw e;
    const wait = waitOf(e, pauseMs);
    waits.push(wait);
    await pause(wait);
    return read();
  }
}

/**
 * The note on the waits of `waits`, or none.
 *
 * @param {number[]} waits ms, from `readWithRateLimit`
 * @param {string} site the site's name
 * @returns {string[]} one note, or none
 */
export function rateLimitNotes(waits, site) {
  if (!waits.length) return [];
  const seconds = Math.round(waits.reduce((sum, ms) => sum + ms, 0) / 1000);
  return [`${site}'s rate limit was met ${waits.length} time(s): waited ${seconds} s in all`];
}
