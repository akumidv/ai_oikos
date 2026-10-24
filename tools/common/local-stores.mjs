// The move of an installation's stores in `.local/` from their places before ADR 0002 to their
// dot-named ones (D02, D03): the Google sign-in from `.local/google/` to `.local/.secrets/google/`,
// the shared browser's profile and launch.json from `.local/browser/` to `.local/.browser/`.
// `oikos sync` runs it (and `setup init` through sync). A store moves only when its old place
// exists and its new one does not; the browser's only while this installation's Chrome is stopped,
// since a running Chrome writes into its profile. Until a store is moved the tools use it where it
// is (paths.mjs localStorePath), and the secret guard keeps both names closed.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOCAL_STORES } from './paths.mjs';

/**
 * @typedef {object} StoreMove
 * @property {string} store a key of LOCAL_STORES
 * @property {string} from the legacy place, relative to the installation (`.local/google`)
 * @property {string} to the place, relative to the installation (`.local/.secrets/google`)
 * @property {'moved'|'out of date'|'running'|'both'|'failed'} state `moved` now; `out of date`
 *   under a check, which moves nothing; `running` — the browser's Chrome runs, so it was left;
 *   `both` — the new place exists too, so the old one was left for the user to look at; `failed` —
 *   the move threw, the store stays where it was
 * @property {string} [error] for `failed`: the error's code and message
 */

/**
 * Move the stores of the installation at `root` that are still at their legacy places. With
 * `check` nothing moves and each such store is reported `out of date`. `browserRunning` says
 * whether this installation's Chrome runs (browser/cli.mjs chromeRunning); it is asked only when
 * the browser store is to be moved, and without it the browser store is never moved.
 *
 * @param {string} root the installation's folder
 * @param {{ check?: boolean, browserRunning?: () => Promise<boolean> }} [options]
 * @returns {Promise<StoreMove[]>} one entry per store left at its legacy place before the call
 */
export async function moveLocalStores(root, { check = false, browserRunning = async () => true } = {}) {
  const moves = [];
  for (const [store, { parts, legacy }] of Object.entries(LOCAL_STORES)) {
    const from = join(root, '.local', ...legacy);
    const to = join(root, '.local', ...parts);
    if (!existsSync(from)) continue;
    const entry = { store, from: join('.local', ...legacy), to: join('.local', ...parts) };
    if (existsSync(to)) moves.push({ ...entry, state: 'both' });
    else if (check) moves.push({ ...entry, state: 'out of date' });
    else if (store === 'browser' && (await Promise.resolve().then(browserRunning).catch(() => true))) moves.push({ ...entry, state: 'running' });
    else {
      // One store that cannot move (a permission, a file in the way) does not stop the others.
      try {
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        renameSync(from, to);
        moves.push({ ...entry, state: 'moved' });
      } catch (e) {
        moves.push({ ...entry, state: 'failed', error: `${e.code ? `${e.code}: ` : ''}${e.message}` });
      }
    }
  }
  return moves;
}
