#!/usr/bin/env node
// PreToolUse(file writes): in an installation oikos itself is read-only. `oikos/` there is the
// core checkout — through a symlink, shared by every installation on the machine, or a submodule
// updated with a plain pull — so an edit made through it changes every installation at once and
// turns each update into a merge. oikos is developed in the core repository: a session started
// there is not in any installation, and this guard lets it be.
//
// What counts is where a path really is: `oikos/skills/x.md` and the core's absolute path are the
// same file. node_modules stays free (npm owns it). Best effort against accidents: shell commands
// writing files are not looked into here (git-guard judges them, mount-shell.mjs).
//
// The same holds for every mount (docs/design/mounts.md): an installation writes only into itself,
// so a file tool does not change a path inside a mount — a wiki mount included — and the message
// says where to open a session instead. Reads stay open. Mounts come from config(), read per call,
// together with the roots `sync` recorded in `.local/sync.json`: a mount removed from the configuration
// stays closed until `sync --prune` has taken its wiring away (plain sync keeps it), and an unreadable
// configuration closes nothing less. The files the protection depends on are closed too, as far as they
// matter (mounts-lock.mjs): the host settings files change only in their `permissions` key (the user-level ones
// wherever the path is), and `.mcp.json`, the user's shell startup files and `~/.claude.json` are not changed at all.
//
// The boundary between installations (ADR 0007 D05, boundary.mjs): a search tool (Grep, Glob) whose
// scope is a folder above the installation is denied — it would reach every installation beside this
// one — and so is a read, a search or a listing of a path of another installation, unless that
// installation is registered as a mount without `use` (one definition, foreignInstallation); a write
// into another installation is denied whether it is registered or not. A check that throws denies the
// call: the dispatcher fails open, and a failure must not open a boundary.
//
// What a path is, as the guard reads it (host.mjs `pathForms`, paths.mjs `realForms`): every spelling a host may
// open — trimmed, `~` expanded, Qwen's escapes undone — and, for each, both real paths a `..` after a link
// can mean (the kernel's, and the host's, which collapses `..` as text first); the call is denied when any of
// them is. A path starting `~name` is denied unjudged, the user's own `~name` too: no host's expansion of it
// can be told from here (`isUserHome`). The guarded roots are
// every key of `mounts:` — a problem entry and a file that does not parse included (D01) — and the folder
// the write guard keeps its record in (`oikos-hooks/` under the temp folder) is closed to the edit tools.
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { decide } from './common.mjs';
import { isEdit, isRead, isSearch, searchScopes, fileTargets, unjudgeablePath } from './host.mjs';
import { CORE_ROOT, hookInstallation, idOf, realForms, realOf } from '../common/paths.mjs';
import { mountsEditProblem, userGuards } from './mounts-lock.mjs';
import {
  aboveInstallation, boundaryOf, failedCheckReason, foreignInstallation, foreignReadReason, foreignWriteReason, guardedMounts, hardLinked, hardLinkReason,
  inside, mountHolding, otherInstallation, scopeReason,
} from './boundary.mjs';

export { guardedMounts };

/**
 * The reason for a call a guard cannot judge because `OIKOS_HOME` leads to no installation and the host's
 * project folder is none either: with no installation the guard cannot tell the core, a mount or the files
 * it leans on from any other path, so it denies the write rather than let it through unchecked (a
 * session in the core repository is not this case).
 * @param {string} guard the guard's name, as in its messages
 * @param {string} what the call, as a message names it
 * @param {string} problem why there is no installation (paths.mjs `locateInstallation`)
 */
export const brokenHomeReason = (guard, what, problem) => `oikos ${guard}: ${what}, and the installation cannot be found — ${problem}. `
  + 'Without it the guard cannot tell the core, a mount or a file the guards lean on from any other path, so the write is denied. '
  + 'The user fixes or unsets OIKOS_HOME (or starts the session in the installation) and restarts it; reads stay open.';

/**
 * The path relative to the core when it is inside the core, else null. Judged as ADR 0007 D02 says:
 * the real path, component by component, and — when the spelling differs (a case variant on a file
 * system that folds case) — by the identity of the folders above it.
 */
export function insideCore(path, cwd) {
  return coreRelative(realOf(path, cwd || process.cwd()));
}

/** {@link insideCore} for the real path `real`. */
function coreRelative(real) {
  const core = realpathSync(CORE_ROOT);
  const rel = relative(core, real).replace(/\\/g, '/');
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  const coreId = idOf(core);
  const names = [];
  for (let dir = real; coreId !== null; dir = dirname(dir)) {
    if (idOf(dir) === coreId) return names.join('/');
    names.unshift(basename(dir));
    if (dirname(dir) === dir) break;
  }
  return null;
}

/**
 * Why a search or a read of `named` — a path as the call names it, `real` as it really is — is denied by the
 * boundary (ADR 0007 D05), or null: a search scope above this installation would reach every installation
 * beside it, and a path of another installation is closed unless it is registered as a mount (one
 * definition of that, {@link foreignInstallation}).
 */
function readDenial(payload, named, real, boundary, searching) {
  const what = `\`${payload.tool_name}\``;
  if (searching && aboveInstallation(real, boundary)) return scopeReason(what, `\`${named}\``, real);
  const other = foreignInstallation(real, boundary);
  return other ? foreignReadReason(what, `\`${named}\``, real, other) : null;
}

/** Why a search tool's call is denied — a scope above this installation, or in an unregistered installation — or null; each scope {@link searchScopes} names is judged. */
function searchDenial(payload, cwd, boundary) {
  for (const { named, real } of searchScopes(payload, cwd)) {
    const denial = readDenial(payload, named, real, boundary, true);
    if (denial) return denial;
  }
  return null;
}

/** Why a file tool's read of a path is denied — it is in an installation not registered as a mount, by any real path it may reach ({@link realForms}) — or null. */
function fileReadDenial(payload, cwd, boundary) {
  for (const path of fileTargets(payload)) {
    for (const real of realForms(path, cwd, boundary.links)) {
      const denial = readDenial(payload, path, real, boundary, false);
      if (denial) return denial;
    }
  }
  return null;
}

/** The reason for a path that starts with another user's home (`~name`), which no guard can judge, `what` naming it. */
const unjudgeableReason = (payload, named) => `oikos package guard: \`${payload.tool_name}\` names ${named}, a path in another user's home, which no guard can judge `
  + '(the host decides what it expands to), so the call is denied. Name the path by its absolute path.';

/** Why a file tool's call is denied, or null. */
function denialOf(payload, install, cwd, user) {
  const unjudgeable = unjudgeablePath(payload);
  if (unjudgeable !== undefined) return unjudgeableReason(payload, unjudgeable);
  const boundary = boundaryOf(install);
  if (isSearch(payload)) return searchDenial(payload, cwd, boundary);
  if (isEdit(payload)) return editDenial(payload, cwd, { install, boundary, user });
  return isRead(payload) ? fileReadDenial(payload, cwd, boundary) : null;
}

/** The guard: a check that throws denies the call, since a failure must not open the boundary (a hook that fails open lets the call through unchecked). */
export function run(payload) {
  const { root: install, problem, brokenHome } = hookInstallation(); // none in the core repository itself: development
  if (!install) {
    if (brokenHome && isEdit(payload)) decide(payload, 'deny', brokenHomeReason('package guard', `\`${payload.tool_name}\` writes a file`, problem));
    return;
  }
  let reason;
  try {
    reason = denialOf(payload, install, payload.cwd || install, userGuards(homedir(), process.env)); // the home and the environment are read here, once
  } catch (error) {
    reason = failedCheckReason('package guard', 'boundary check', `\`${payload.tool_name}\` of ${fileTargets(payload).join(', ') || 'no path'}`, error);
  }
  if (reason) decide(payload, 'deny', reason);
}

/** The reason for a write into the core: `rel` is the path in it. */
const coreReason = (rel) => `oikos package guard: oikos/${rel} belongs to oikos itself, which is read-only in an installation `
  + '— `oikos/` is the core checkout every installation on this machine shares, and a local edit turns every update '
  + 'into a merge. The organization\'s settings go to `oikos.yaml`, `resources/` or `AGENTS.md` here, personal ones to '
  + '`.local/`, notes to the vault; a change useful to everyone is proposed to the user and made in the oikos core '
  + `repository (${realpathSync(CORE_ROOT)}), in a session started there (DEVELOPMENT.md).`;

/**
 * The folder where the write guard keeps, per session, which guarded writes were shown and the user had
 * the word for (common.mjs `STATE_DIR`): a file tool that could write there could forge the record.
 */
const stateFolder = () => realOf(join(tmpdir(), 'oikos-hooks'));

/** Why a file tool's write to the real path `real` (named `path`) is denied by the state folder, the mounts, the other installations or a second name — or null. */
function realEditDenial(payload, path, real, boundary) {
  const state = stateFolder();
  if (inside(real, state, idOf(state), boundary)) {
    return `oikos package guard: ${path} is in the hook state folder (${state}), where the write guard records which guarded writes were shown and confirmed — `
      + 'an assistant that could write there could forge a dry run and run a guarded write without one. A file tool does not change it.';
  }
  const mount = mountHolding(real, boundary);
  if (mount) {
    return `oikos package guard: ${path} is inside the mount \`${mount.path}\` — an installation writes only into itself, `
      + `so a mount is changed in a session opened there: open a session in \`${mount.path}\` to change it. Reading it is open.`;
  }
  const other = otherInstallation(real, boundary);
  if (other) return foreignWriteReason(`\`${payload.tool_name}\``, path, real, other);
  return hardLinked(real) ? hardLinkReason(`\`${payload.tool_name}\``, path) : null;
}

/**
 * Why a file tool's write to `path` is denied — inside the core, a file the guards lean on, the hook state
 * folder, a mount, another installation, a file with a second name — or null. `scope` holds the installation's
 * root, its boundary and what the user's home and environment give (`user`: the user-level settings files of the
 * hosts and the user-level files closed to every edit, {@link userGuards}). The path is judged as every
 * real path it may reach ({@link realForms}), and denied when any of them is.
 */
function pathEditDenial(payload, path, cwd, { install, boundary, user }) {
  const reals = realForms(path, cwd, boundary.links);
  for (const real of reals) {
    const rel = coreRelative(real);
    if (rel !== null && !/^node_modules(\/|$)/.test(rel)) return coreReason(rel);
  }
  const unlock = mountsEditProblem(payload.tool_input || {}, path, cwd, install, user);
  if (unlock) return unlock;
  for (const real of reals) {
    const denial = realEditDenial(payload, path, real, boundary);
    if (denial) return denial;
  }
  return null;
}

/** Why a file tool's write is denied — inside the core, in a mount, in another installation, in the files the guards lean on, to a file that has a second name — or null. */
function editDenial(payload, cwd, scope) {
  for (const path of fileTargets(payload)) {
    const denial = pathEditDenial(payload, path, cwd, scope);
    if (denial) return denial;
  }
  return null;
}
