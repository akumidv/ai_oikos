// The git guard (npm test): the command after a control word (`do`, `then`, …) is the command it
// judges. The hook is driven as a host drives it — `host-hook.mjs git-guard` with the event payload
// on stdin — from a temporary folder outside the core, so no commit check reads a staged tree.
// Nothing here runs git or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';

const CORE = realpathSync(CORE_ROOT);
const HOOK = join(CORE, 'tools', 'hooks', 'host-hook.mjs');
const CWD = mkdtempSync(join(tmpdir(), 'oikos-git-guard-'));
process.on('exit', () => rmSync(CWD, { recursive: true, force: true }));

/** The guard's decision and reason for one shell command in a permission mode. */
function guard(command, permission_mode = 'default') {
  const r = spawnSync(process.execPath, [HOOK, 'git-guard'], {
    cwd: CORE,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'git-guard-test', cwd: CWD, permission_mode, tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const answer = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return answer?.hookSpecificOutput?.permissionDecision ?? null;
}

test('a git push inside a loop or an if is judged as a plain git push', () => {
  for (const mode of ['default', 'auto']) {
    const plain = guard('git push', mode);
    assert.equal(plain, mode === 'default' ? 'ask' : 'deny');
    for (const command of ['for b in x; do git push; done', 'if true; then git push; fi']) {
      assert.equal(guard(command, mode), plain, `${command} (${mode})`);
    }
  }
});
