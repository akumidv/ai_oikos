#!/usr/bin/env node
// PreToolUse(file writes): in an installation oikos itself is read-only. `oikos/` there is the
// core checkout — through a symlink, shared by every installation on the machine, or a submodule
// updated with a plain pull — so an edit made through it changes every installation at once and
// turns each update into a merge. oikos is developed in the core repository: a session started
// there is not in any installation, and this guard lets it be.
//
// What counts is where a path really is: `oikos/skills/x.md` and the core's absolute path are the
// same file. node_modules stays free (npm owns it). Best effort against accidents: shell commands
// writing files are not looked into.
//
// The same holds for every mount (docs/design/mounts.md): an installation writes only into itself,
// so a file tool does not change a path inside a mount — a wiki mount included — and the message
// says where to open a session instead. Reads stay open. Mounts come from config(), read per call,
// together with the roots `sync` recorded in `.local/sync.json`: a mount removed from the configuration
// stays closed until sync has taken its wiring away, and an unreadable configuration closes nothing less.
// The files that declare the mounts are closed too, as far as they declare them (mounts-lock.mjs).
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { decide } from './common.mjs';
import { isEdit, fileTargets } from './host.mjs';
import { CORE_ROOT, installRoot, realOf } from '../common/paths.mjs';
import { config } from '../common/config.mjs';
import { mountOf } from '../common/mounts.mjs';
import { mountsEditProblem } from './mounts-lock.mjs';

/** The path relative to the core when it is inside the core, else null. */
export function insideCore(path, cwd) {
  const rel = relative(realpathSync(CORE_ROOT), realOf(resolve(cwd || process.cwd(), path))).replace(/\\/g, '/');
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
}

/** The mounts a file tool may not write into: the configured ones, and the roots recorded in `.local/sync.json` that no configured mount has. */
export function guardedMounts(install) {
  let mounts = [];
  try {
    mounts = config().mounts;
  } catch { /* an unreadable configuration: the recorded roots still guard */ }
  let recorded = {};
  try {
    recorded = JSON.parse(readFileSync(resolve(install, '.local', 'sync.json'), 'utf8')).mounts ?? {};
  } catch { /* no record, or one that does not read */ }
  const roots = typeof recorded === 'object' && recorded !== null ? Object.keys(recorded) : [];
  return [...mounts, ...roots.filter((root) => !mounts.some((m) => m.root === root)).map((root) => ({ path: root, root }))];
}

export function run(payload) {
  if (!isEdit(payload)) return;
  const install = installRoot();
  if (!install) return; // the core repository itself: development
  const cwd = payload.cwd || install;
  const mounts = guardedMounts(install);
  for (const path of fileTargets(payload)) {
    const rel = insideCore(path, cwd);
    if (rel !== null && !/^node_modules(\/|$)/.test(rel)) {
      decide(payload, 'deny', `oikos package guard: oikos/${rel} belongs to oikos itself, which is read-only in an installation `
        + '— `oikos/` is the core checkout every installation on this machine shares, and a local edit turns every update '
        + 'into a merge. The organization\'s settings go to `oikos.yaml`, `resources/` or `AGENTS.md` here, personal ones to '
        + '`.local/`, notes to the vault; a change useful to everyone is proposed to the user and made in the oikos core '
        + `repository (${realpathSync(CORE_ROOT)}), in a session started there (DEVELOPMENT.md).`);
      return;
    }
    const unlock = mountsEditProblem(payload.tool_input || {}, path, cwd, install);
    if (unlock) {
      decide(payload, 'deny', unlock);
      return;
    }
    const mount = mountOf(mounts, realOf(resolve(cwd, path)));
    if (mount) {
      decide(payload, 'deny', `oikos package guard: ${path} is inside the mount \`${mount.path}\` — an installation writes only into itself, `
        + `so a mount is changed in a session opened there: open a session in \`${mount.path}\` to change it. Reading it is open.`);
      return;
    }
  }
}
