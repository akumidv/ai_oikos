// How a glob pattern's folders are read (tools/hooks/host.mjs, ADR 0007 D02; the L-c finding of the security
// re-audit): the braces of a pattern are expanded first and `~` second, in each alternative, so a `~` inside
// a brace (`{~/other,x}/**`) is the home folder's like one at the start; a `~name` alternative cannot be judged
// and is denied. The unit half calls host.mjs; the guard half runs the package guard as a host runs it, from
// temporary installations (ACME Corp). Nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { cleanEnv, installation } from './helpers/installation.mjs';
import { mounted, write } from './helpers/mounts.mjs';
import { searchScopes, unjudgeablePath } from '../tools/hooks/host.mjs';

const glob = (pattern, path) => ({ tool_name: 'Glob', tool_input: path ? { pattern, path } : { pattern } });

test('searchScopes: a `~` inside a brace alternative is the home folder, like one at the start', () => {
  const named = (pattern) => searchScopes(glob(pattern), '/work').map((scope) => scope.named);
  assert.ok(named('{~/acme/other,x}/**/*.md').includes(`${homedir()}/acme/other/`), 'the home folder is expanded in the alternative');
  assert.ok(named('{x,~/acme/other}/**/*.md').includes(`${homedir()}/acme/other/`), 'in the last alternative too');
  assert.ok(named('~/acme/{a,b}/*.md').includes(`${homedir()}/acme/a/`), 'a brace after the home folder');
  assert.ok(named('{{~/acme/deep,y},x}/*.md').includes(`${homedir()}/acme/deep/`), 'in a nested group');
  assert.ok(!named('{x,y}/*.md').some((scope) => scope.includes(homedir())), 'a brace without `~` names no home folder');
});

test('unjudgeablePath: a `~name` alternative of a brace is another user\'s home and cannot be judged', () => {
  assert.equal(unjudgeablePath(glob('{~root/x,y}/*.md')), '~root/x/*.md');
  assert.equal(unjudgeablePath(glob('{y,~root}/*.md')), '~root/*.md');
  assert.equal(unjudgeablePath(glob('~root/*.md')), '~root/*.md');
  assert.equal(unjudgeablePath(glob('{~/x,y}/*.md')), undefined, 'the user\'s own home is judgeable');
  assert.equal(unjudgeablePath(glob('src/{a,b}/*.md')), undefined);
  assert.equal(unjudgeablePath({ tool_name: 'Grep', tool_input: { pattern: '{~root,y}' } }), undefined, 'a Grep pattern is a regex, not a path');
});

// -- the package guard ------------------------------------------------------------------------------

const stranger = realpathSync(installation((t) => t));
const { dir } = mounted();
write(join(stranger, 'AGENTS.md'), 'rules\n');
const home = dirname(dir); // the hook runs with this as HOME, so `~/<name>/…` is in the temporary folder
const tilde = (path) => `~/${path.slice(home.length + 1)}`;

/** The package guard's reason for denying a Glob call as a host would send it (`~` is the folder `home`), else null. */
function guard(input) {
  const r = spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'hooks', 'host-hook.mjs'), 'package-guard'], {
    cwd: dir, encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: dir, HOME: home }),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Glob', cwd: dir, tool_input: input }),
  });
  const answer = r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()).hookSpecificOutput : undefined;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}

test('L-c: a Glob whose brace holds a `~` path of another installation is denied; a brace inside the installation is allowed', () => {
  assert.match(guard({ pattern: `{${tilde(stranger)},x}/**/*.md` }) ?? '(allowed)', /another installation|would search/);
  assert.match(guard({ pattern: `{x,${tilde(stranger)}}/**/*.md` }) ?? '(allowed)', /another installation|would search/);
  assert.match(guard({ pattern: `{${tilde(stranger)}/a,${tilde(stranger)}/b}/*.md` }) ?? '(allowed)', /another installation|would search/);
  assert.match(guard({ pattern: '{~root/x,y}/**/*.md' }) ?? '(allowed)', /another user's home/);
  assert.equal(guard({ pattern: `{${tilde(dir)}/notes,${tilde(dir)}/docs}/**/*.md` }), null, 'both alternatives are inside the installation');
  assert.equal(guard({ pattern: '{notes,docs}/**/*.md' }), null);
});
