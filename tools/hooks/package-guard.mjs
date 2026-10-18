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
import { realpathSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { decide } from './common.mjs';
import { isEdit, fileTargets } from './host.mjs';
import { CORE_ROOT, installRoot, realOf } from '../common/paths.mjs';

/** The path relative to the core when it is inside the core, else null. */
export function insideCore(path, cwd) {
  const rel = relative(realpathSync(CORE_ROOT), realOf(resolve(cwd || process.cwd(), path))).replace(/\\/g, '/');
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
}

export function run(payload) {
  if (!isEdit(payload)) return;
  const install = installRoot();
  if (!install) return; // the core repository itself: development
  for (const path of fileTargets(payload)) {
    const rel = insideCore(path, payload.cwd || install);
    if (rel === null || /^node_modules(\/|$)/.test(rel)) continue;
    decide(payload, 'deny', `oikos package guard: oikos/${rel} belongs to oikos itself, which is read-only in an installation `
      + '— `oikos/` is the core checkout every installation on this machine shares, and a local edit turns every update '
      + 'into a merge. The organization\'s settings go to `oikos.yaml`, `resources/` or `AGENTS.md` here, personal ones to '
      + '`.local/`, notes to the vault; a change useful to everyone is proposed to the user and made in the oikos core '
      + `repository (${realpathSync(CORE_ROOT)}), in a session started there (DEVELOPMENT.md).`);
    return;
  }
}
