// The write guard (npm test): a changing command runs for real only after its dry run and a user
// prompt since. The hook is driven as a host drives it — `host-hook.mjs write-guard` with the
// event payload on stdin — once in each host's shell tool name; its per-session state goes to a
// temporary TMPDIR per test. The pattern of a tool call is checked on its own, for tool names that
// writes.mjs does not list yet. Nothing here runs a tool or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { toolCallPattern } from '../tools/hooks/write-guard.mjs';

const CORE = realpathSync(CORE_ROOT);
const HOOK = join(CORE, 'tools', 'hooks', 'host-hook.mjs');
const SHELLS = ['Bash', 'run_shell_command'];
const made = [];

process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A guard session: its own state folder and session id; `prompt()` and `shell()` send one event each. */
function session(shellTool) {
  const state = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(state);
  const sessionId = `write-guard-test-${process.pid}-${made.length}`;
  const send = (payload) => {
    const r = spawnSync(process.execPath, [HOOK, 'write-guard'], {
      cwd: CORE,
      input: JSON.stringify({ session_id: sessionId, cwd: CORE, permission_mode: 'default', ...payload }),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: state },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  return {
    prompt: () => send({ hook_event_name: 'UserPromptSubmit', prompt: 'yes' }),
    shell: (command) => send({ hook_event_name: 'PreToolUse', tool_name: shellTool, tool_input: { command } }),
  };
}

const denied = (answer) => answer?.hookSpecificOutput?.permissionDecision === 'deny';

const COMMENT = 'node tools/jira/cli.mjs comment PROJ-123 --text "Done"';

for (const shellTool of SHELLS) {
  test(`${shellTool}: a jira write without a dry run is denied, naming the tool and command`, () => {
    const answer = session(shellTool).shell(COMMENT);
    assert.ok(denied(answer), JSON.stringify(answer));
    const reason = answer.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /jira comment changes a remote service/);
    assert.match(reason, /--dry-run/);
  });

  test(`${shellTool}: dry run, then a user prompt, then the same command passes once`, () => {
    const s = session(shellTool);
    assert.equal(s.shell(`${COMMENT} --dry-run`), null);
    const early = s.shell(COMMENT);
    assert.ok(denied(early), JSON.stringify(early));
    assert.match(early.hookSpecificOutput.permissionDecisionReason, /has not been answered yet/);
    s.prompt();
    assert.equal(s.shell(COMMENT), null);
    assert.ok(denied(s.shell(COMMENT)), 'the confirmed dry run is used up by the run');
  });

  test(`${shellTool}: a changed command after the dry run needs a new dry run`, () => {
    const s = session(shellTool);
    s.shell(`${COMMENT} --dry-run`);
    s.prompt();
    assert.ok(denied(s.shell('node tools/jira/cli.mjs comment PROJ-123 --text "Other"')));
  });

  test(`${shellTool}: a read and the npm form of a read pass; the npm form of a write is denied`, () => {
    const s = session(shellTool);
    assert.equal(s.shell('node tools/jira/cli.mjs task PROJ-123'), null);
    assert.equal(s.shell('node tools/github/cli.mjs repos'), null);
    assert.equal(s.shell('npm run jira -- task PROJ-123'), null);
    assert.ok(denied(s.shell('npm run confluence -- append 12345 --file note.md')));
  });
}

/** The `<tool> <command>` pairs `pattern` finds in `command`. */
const callsIn = (pattern, command) => [...command.matchAll(pattern)].map((m) => `${m[1] || m[2]} ${m[3]}`);

test('toolCallPattern: a hyphenated tool is matched whole, and a shorter name never takes it', () => {
  const pattern = toolCallPattern(['github', 'github-issues']);
  assert.deepEqual(callsIn(pattern, 'node tools/github-issues/cli.mjs create --repo acme/app'), ['github-issues create']);
  assert.deepEqual(callsIn(pattern, 'node tools/github/cli.mjs repos'), ['github repos']);
  assert.deepEqual(callsIn(toolCallPattern(['github-issues']), 'node tools/github/cli.mjs repos'), []);
  assert.deepEqual(callsIn(toolCallPattern(['github']), 'node tools/github-issues/cli.mjs create'), []);
});

test('toolCallPattern: the npm form, with and without --', () => {
  const pattern = toolCallPattern(['gitlab-wiki', 'gitlab']);
  assert.deepEqual(callsIn(pattern, 'npm run gitlab-wiki -- append Home --file note.md'), ['gitlab-wiki append']);
  assert.deepEqual(callsIn(pattern, 'npm run gitlab-wiki append Home'), ['gitlab-wiki append']);
  assert.deepEqual(callsIn(toolCallPattern(['gitlab']), 'npm run gitlab-wiki -- append Home'), []);
});

test('toolCallPattern: regex metacharacters in a name are literal', () => {
  assert.deepEqual(callsIn(toolCallPattern(['a.b']), 'node tools/axb/cli.mjs create'), []);
  assert.deepEqual(callsIn(toolCallPattern(['a.b']), 'node tools/a.b/cli.mjs create'), ['a.b create']);
});
