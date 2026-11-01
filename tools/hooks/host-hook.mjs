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
// Two processes, so that no failure of a guard reaches the host as "allowed" (owner decision
// D-HOOK-LOAD-FAILURE):
//
//   - this one, the dispatcher, imports node builtins only and nothing of oikos, so there is no file
//     of ours whose syntax error, missing dependency or top-level throw can stop it. It reads the
//     payload, runs the guard in a child process (`--run`), waits for it at most DEADLINE_MS, and
//     prints exactly one answer: the child's, or — when the guard could not load, threw, died or did
//     not answer in time — that of the fallback rules below;
//   - the child loads wiring.mjs, common.mjs, paths.mjs and the guard, and runs it as before. A child
//     rather than a thread: it is killed with its whole process group, which a thread blocked in a
//     synchronous call (a git that hangs, a CPU loop in a parser) cannot be, and the guards stay
//     unchanged, free to read stdin and exit.
//
// DEADLINE_MS stays well under the `timeout` the settings give each hook (HOOK_TIMEOUT_SECONDS in
// tools/hooks/wiring.mjs): past the host's timeout the host lets the action through, and the dispatcher
// must have answered before that. Nothing in the environment moves the deadline, the guard folder or
// the fallback — a settings file's `env` reaches this process, and none of it may switch a check off.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** How long the guard may take before the fallback decides; wiring.mjs HOOK_TIMEOUT_SECONDS is 30 s. */
const DEADLINE_MS = 20_000;
const RUN_FLAG = '--run';
/** The exit code of the child that tells the dispatcher "the guard failed", its message on stderr. */
const FAILED = 70;
const GUARD_NAME = /^[a-z][a-z-]*$/;
const OUTPUT_LIMIT = 1_000_000;

// -- the fallback rules ---------------------------------------------------------------------------------
// What decides a PreToolUse call when the guard cannot. Plain text rules over the raw command, written
// without any oikos code: coarse on purpose (a false deny costs a retry in another form, a missed one a
// push or a write). The spellings of the tools are those of tools/hooks/host.mjs, kept here by hand
// because the dispatcher imports nothing; tests/host-hook.test.mjs runs every one of them.
const SHELL_TOOLS = new Set(['Bash', 'run_shell_command']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'replace', 'edit', 'notebook_edit']);
const ESCALATION = /(?<![\w.-])(?:sudo|sudoedit|doas|pkexec|run0|su)(?![\w.-])/;
/** The git subcommands that only read: a copy of GIT_READS in tools/hooks/git-guard.mjs, kept by hand (the dispatcher imports nothing). */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'describe', 'show-ref', 'shortlog']);
/** The global options of git that take their value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path']);
const GIT_WORD = /(?<![\w.-])git(?![\w.-])/g;
/** Any variable expansion (`$X`, `${X}`) anywhere in the command: it can spell the program in any position (`{ $G x; }`, `if $G`, `time $G`, `xargs $G`), so the fallback is coarse and a false denial there is accepted. */
const VARIABLE_PROGRAM = /\$[A-Za-z_{]/;
/** An `--output` option (`--output=f`, `--output f`): a read that writes the file it names. */
const OUTPUT_OPTION = /(?<![\w-])--output(?![\w-])/;
/** A `$'…'` string with an escape in it: it can spell any word (`$'g\x69t'`). */
const ESCAPED_STRING = /\$'[^']*\\/;
const HARMLESS_TARGET = /^\/dev\/(?:null|stdout|stderr)$/;

/** The first target of a redirection (`>`, `>>`, `&>`) in the command that is not /dev/null, stdout or stderr, or null; `2>&1` copies a stream and is none. */
function redirectedInto(command) {
  for (const found of command.matchAll(/>>?(&?)\|?\s*([^\s;&|)]*)/g)) {
    const target = found[2].replace(/['"]/g, '');
    if (found[1] === '&' && /^(?:\d+|-)$/.test(target)) continue;
    if (!HARMLESS_TARGET.test(target)) return target || '(a target the rules cannot read)';
  }
  return null;
}

/** The command with its quotes (`'`, `"`, the `$'` prefix) and backslashes removed, so that `g\it`, `"g"it` and `co""mmit` read as the words they spell. */
const unquoted = (command) => command.replace(/\$'/g, '').replace(/['"\\]/g, '');

/** The subcommand of the git call whose words are `rest`, past git's global options; null when there is none. */
function gitSubcommand(rest) {
  const words = rest.split(/[;&|\n]/)[0].trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    if (GIT_VALUE_OPTIONS.has(words[i])) i += 1;
    else if (!words[i].startsWith('-')) return words[i];
  }
  return null;
}

/** The first git call in `command` (quotes already removed) whose subcommand is not a read, as that subcommand, or null. */
function gitNonRead(command) {
  for (const found of command.matchAll(GIT_WORD)) {
    const sub = gitSubcommand(command.slice(found.index + found[0].length));
    if (sub !== null && !GIT_READS.has(sub)) return sub.slice(0, 30);
  }
  return null;
}

/** Why the fallback rules deny the shell command `raw` (whose check did finish or failed in another way), or null. */
function commandDenial(raw) {
  const command = unquoted(raw);
  if (ESCALATION.test(command)) return 'the command escalates privileges (sudo, doas, su, pkexec, run0); the agent never does';
  if (ESCAPED_STRING.test(raw)) return 'the command spells a word with an escape inside $\'…\', which the rules cannot read';
  if (VARIABLE_PROGRAM.test(command)) return 'the command runs a program named by a variable, which the rules cannot read';
  if (OUTPUT_OPTION.test(command)) return 'the command passes `--output`, which makes a read write the file it names';
  const gitSub = gitNonRead(command);
  if (gitSub !== null) return `the command runs git \`${gitSub}\`, which is not a read; the owner runs those`;
  const target = redirectedInto(raw);
  return target === null ? null : `the command redirects output into \`${target}\``;
}

/**
 * Why the fallback rules deny a PreToolUse call, or null. A call whose check did not finish (`unfinished`:
 * it ran out of time, or the guard's process was ended by a signal the dispatcher did not send) is denied
 * outright for a shell command and for a write: a command built to make the check slow or to kill it is
 * not one to let through on a guess.
 */
function fallbackDenial(payload, unfinished) {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const raw = payload.tool_input?.command;
  if (WRITE_TOOLS.has(tool)) return `\`${tool}\` writes a file, and no file write is allowed without the check`;
  if (!SHELL_TOOLS.has(tool) || typeof raw !== 'string') return null;
  if (unfinished) return 'a shell command is not run when its check did not finish; split it into smaller commands';
  return commandDenial(raw);
}

// -- the dispatcher -------------------------------------------------------------------------------------
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 300);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  try {
    const data = JSON.parse(raw || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Kills the child and everything it started (its process group), or at least the child. */
function killTree(child) {
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Runs the guard `name` in a child process with `raw` on its stdin.
 * @returns {Promise<{ok: boolean, stdout: string, failure?: string, timedOut?: boolean, signaled?: boolean}>} `ok` when the guard
 *   ended with exit code 0 — its whole stdout is then its answer; otherwise `failure` says what happened
 */
function runGuard(name, raw) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let exitedClean = false;
    let settled = false;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), RUN_FLAG, name], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok) killTree(child);
      resolve({ stdout, ...result });
    };
    const timer = setTimeout(() => {
      if (exitedClean) settle({ ok: true });
      else settle({ ok: false, timedOut: true, failure: `did not answer within ${DEADLINE_MS / 1000} s` });
    }, DEADLINE_MS);
    const keep = (text, chunk) => (text.length < OUTPUT_LIMIT ? text + chunk : text);
    child.stdout.on('data', (chunk) => { stdout = keep(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = keep(stderr, chunk); });
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
    child.on('error', (error) => settle({ ok: false, failure: `could not be started (${error.message})` }));
    child.on('exit', (code) => { exitedClean = code === 0; });
    child.on('close', (code, signal) => {
      if (code === 0) return settle({ ok: true });
      const detail = oneLine(stderr.trim().split('\n').pop() ?? '');
      // a signal here is one the dispatcher did not send (its own kill settles first): something killed the guard
      settle({ ok: false, signaled: signal !== null, failure: code === FAILED && detail ? detail : `ended with ${signal ?? `exit code ${code}`}${detail ? ` (${detail})` : ''}` });
    });
  });
}

/** The line of the guard's stdout that denies, if it printed one before it failed: a decision already made stands. */
function printedDenial(stdout) {
  return stdout.split('\n').find((line) => /"permissionDecision":"deny"/.test(line)) ?? null;
}

/** The answer when the guard did not run to its end: its own denial, else what the fallback rules say. */
function failureAnswer(name, payload, outcome) {
  const printed = printedDenial(outcome.stdout);
  if (printed) return printed;
  const what = `oikos hook ${name || '(unnamed)'} failed (${outcome.failure})`;
  const denial = payload.hook_event_name === 'PreToolUse' ? fallbackDenial(payload, outcome.timedOut === true || outcome.signaled === true) : null;
  if (denial) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${what}; the fallback rules decided: ${denial}. Nothing else is checked until the hook works again — tell the user.`,
      },
    });
  }
  return JSON.stringify({ systemMessage: `${what}; only the fallback rules checked the action, and it was allowed` });
}

async function dispatch(name) {
  const raw = readStdin();
  const payload = parsePayload(raw);
  const outcome = GUARD_NAME.test(name ?? '')
    ? await runGuard(name, raw)
    : { ok: false, stdout: '', failure: `unknown guard "${name ?? ''}"` };
  if (outcome.ok) {
    if (outcome.stdout) process.stdout.write(outcome.stdout);
  } else {
    process.stdout.write(`${failureAnswer(name, payload, outcome)}\n`);
  }
  process.exit(0);
}

// -- the child: the guard itself ------------------------------------------------------------------------
async function runChild(name) {
  try {
    const { WIRING } = await import('./wiring.mjs');
    // The guards are those the table wires into a host; a name missing from it cannot be wired, and a
    // wired name missing here fails on the first call instead of never running.
    const guards = new Set(WIRING.map((w) => w.guard));
    if (!guards.has(name)) throw new Error(`unknown guard "${name}" (wired: ${[...guards].join(', ')})`);
    // The installation of a hook is the host's project folder, not what `OIKOS_HOME` says (paths.mjs
    // `hookInstallation`): the variable may come from a settings file's `env`. Everything the guards read
    // through the installation's root (the configuration, the settings) is pinned to that one.
    const { hookInstallation } = await import('../common/paths.mjs');
    const { root } = hookInstallation();
    if (root) process.env.OIKOS_HOME = root;
    const { readPayload } = await import('./common.mjs');
    const guard = await import(`./${name}.mjs`);
    if (typeof guard.run !== 'function') throw new Error(`./${name}.mjs exports no run(payload)`);
    await guard.run(readPayload());
  } catch (error) {
    process.stderr.write(`${oneLine(error?.message ?? error)}\n`);
    process.exit(FAILED);
  }
  process.exit(0);
}

if (process.argv[2] === RUN_FLAG) await runChild(process.argv[3]);
else await dispatch(process.argv[2]);
