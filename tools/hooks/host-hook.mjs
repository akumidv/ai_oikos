#!/usr/bin/env node
// The single entry point of every oikos hook, for every agent host:
//
//   node "$<PROJECT_DIR>/tools/hooks/host-hook.mjs" <guard>
//
// The host fires it from its own settings file (`.claude/settings.json`, `.qwen/settings.json`,
// generated from tools/hooks/wiring.mjs by tools/sync), passes the event payload on stdin,
// and reads the decision back on stdout. One entry point instead of one per guard: a wired
// command then names only the guard, so adding a guard does not add a second spelling of the
// same path, and a misspelled name is visible here rather than as a hook that never ran.
//
// Fail open, like the guards themselves: a hook that cannot load must not freeze the session.
// The user sees what failed and the action goes through unchecked.
import { readPayload, print } from './common.mjs';
import { WIRING } from './wiring.mjs';

// The guards are those the table wires into a host; a name missing from it cannot be wired, and a
// wired name missing here fails open loudly on the first call instead of never running.
const GUARDS = new Set(WIRING.map((w) => w.guard));

const name = process.argv[2];
try {
  if (!GUARDS.has(name)) throw new Error(`unknown guard "${name}" (wired: ${[...GUARDS].join(', ')})`);
  const guard = await import(`./${name}.mjs`);
  if (typeof guard.run !== 'function') throw new Error(`./${name}.mjs exports no run(payload)`);
  await guard.run(readPayload());
} catch (e) {
  print({ systemMessage: `oikos hook ${name || '(unnamed)'} failed (${e.message}); the action was not checked` });
}
process.exit(0);
