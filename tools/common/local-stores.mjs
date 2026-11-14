// The move of an installation's stores in `.local/` from their places before ADR 0002 to their
// dot-named ones (D02, D03): the Google sign-in from `.local/google/` to `.local/.secrets/google/`,
// the shared browser's profile and launch.json from `.local/browser/` to `.local/.browser/`.
// `oikos sync` runs it (and `setup init` through sync). A store moves only when its old place
// exists and its new one does not; the browser's only while this installation's Chrome is stopped,
// since a running Chrome writes into its profile. Until a store is moved the tools use it where it
// is (paths.mjs localStorePath), and the secret guard keeps both names closed.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CORE_ROOT, LOCAL_STORES } from './paths.mjs';
import { PROJECT_PROGRAMS } from './programs.mjs';

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

/** Move `from` to `to` (a folder), across file systems too; never overwrites. */
function moveFolder(from, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (e) {
    // The core and the installation on different volumes: copy, then remove.
    if (e.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true });
  }
}

/**
 * The browser store's content as akmon's browser tool names it (ADR 0009): the profile of a Chrome for
 * Testing was `chrome-profile-project` and is `chrome-profile-cft`; a Chrome for Testing that oikos put
 * into its own cache (`<core>/node_modules/.cache/oikos/chrome/<platform>-<build>/`) is looked for by
 * akmon in `.local/.browser/chrome/chrome/<platform>-<build>/`. Both moves keep the user's sign-ins and
 * the downloaded Chrome. They run only while this installation's Chrome is stopped, never overwrite an
 * existing target, and are idempotent. The Chrome is moved only for an installation that uses a Chrome
 * for Testing (its `chrome-profile-cft` is there, renamed now or before): the cache belongs to the core
 * and is shared, so an installation on the system's Chrome leaves it alone. Run it after
 * {@link moveLocalStores}, which brings the store to `.local/.browser/`. Entries are reported as there;
 * the `from` of a Chrome is relative to the core's parent (`oikos/node_modules/…`).
 *
 * @param {string} root the installation's folder
 * @param {{ check?: boolean, browserRunning?: () => Promise<boolean>, cache?: string }} [options]
 *   `cache` is the folder oikos's Chrome for Testing builds are in (for tests)
 * @returns {Promise<StoreMove[]>}
 */
export async function moveBrowserParts(root, { check = false, browserRunning = async () => true, cache = join(PROJECT_PROGRAMS, 'chrome') } = {}) {
  const moves = [];
  let running;
  for (const { from, to, shown: [shownFrom, shownTo] } of browserMoves(root, cache)) {
    const entry = { store: 'browser', from: shownFrom, to: shownTo };
    if (existsSync(to)) {
      moves.push({ ...entry, state: 'both' });
    } else if (check) {
      moves.push({ ...entry, state: 'out of date' });
    } else if (await (running ??= Promise.resolve().then(browserRunning).catch(() => true))) {
      // Asked once, and only when something is to move; a check that cannot be made counts as running.
      moves.push({ ...entry, state: 'running' });
    } else {
      try {
        moveFolder(from, to);
        moves.push({ ...entry, state: 'moved' });
      } catch (e) {
        moves.push({ ...entry, state: 'failed', error: `${e.code ? `${e.code}: ` : ''}${e.message}` });
      }
    }
  }
  return moves;
}

/** What {@link moveBrowserParts} would move for the installation at `root`: `{ from, to, shown: [from, to] }` as labelled in a report. */
function browserMoves(root, cache) {
  const store = join(root, '.local', ...LOCAL_STORES.browser.parts);
  const label = (path) => relative(root, path);
  const profileOld = join(store, 'chrome-profile-project');
  const profileNew = join(store, 'chrome-profile-cft');
  const wanted = [];
  if (existsSync(profileOld)) wanted.push({ from: profileOld, to: profileNew, shown: [label(profileOld), label(profileNew)] });
  // Only an installation that uses a Chrome for Testing takes one out of the shared cache.
  if (!existsSync(profileOld) && !existsSync(profileNew)) return wanted;
  const builds = existsSync(cache) ? readdirSync(cache, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  for (const build of builds) {
    const to = join(store, 'chrome', 'chrome', build);
    wanted.push({ from: join(cache, build), to, shown: [join('oikos', relative(CORE_ROOT, join(cache, build))), label(to)] });
  }
  return wanted;
}
