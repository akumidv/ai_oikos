// The boundary of an installation in the file tools (ADR 0007 D02 and D05, task B1): Read, Grep, Glob
// and their Qwen counterparts are denied a path of another installation unless it is registered as a
// mount without `use`, in either layer; Edit, Write, MultiEdit and NotebookEdit are denied it always;
// the core is never another installation. And the guards that hold the boundary fail closed: a check
// that throws gives a deny naming the failed check and the error, and the privilege, staging and
// landing rules of the git guard decide without the boundary code. The hooks run as a host runs them
// (`host-hook.mjs <guard>`, tests/helpers/mounts.mjs) from temporary installations (ACME Corp); nothing
// here runs git or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { installation } from './helpers/installation.mjs';
import { hook, mounted, repository, write } from './helpers/mounts.mjs';
import { realOf } from '../tools/common/paths.mjs';

const stranger = realpathSync(installation((t) => t));
const friend = repository(realpathSync(installation((t) => t))); // a registered mount is a repository (D01)
const { dir, team, own } = mounted({ local: `  ${friend}:\n`, shared: '  linked:\n' });
const linked = join(dir, 'linked'); // a linked installation inside this one, registered in the shared layer
const inner = join(dir, 'inner'); // another one, registered nowhere
repository(linked);
for (const root of [linked, inner]) {
  write(join(root, 'oikos.yaml'), 'name: ACME Corp\n');
  write(join(root, 'AGENTS.md'), 'rules\n');
}
mkdirSync(join(dir, 'notes'));
write(join(dir, 'notes', 'a.md'), 'a\n');
write(join(stranger, 'notes', 'secret.md'), 'x\n');
symlinkSync(stranger, join(dir, 'link-stranger'), 'dir');
symlinkSync(join(stranger, 'oikos.yaml'), join(dir, 'file-link'));

/** A tool's call through `guard` in the installation `where`, from `cwd`: the reason when denied, else null. */
function call(guard, toolName, input, cwd = dir, where = dir) {
  const answer = hook(where, guard, { hook_event_name: 'PreToolUse', tool_name: toolName, cwd, tool_input: input }).hookSpecificOutput;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}
const guard = (toolName, input, cwd) => call('package-guard', toolName, input, cwd);
const READ = /oikos boundary guard: `\w+` reads .*, which is in another installation \(.+\) that is not registered as a mount \(ADR 0007 D05\)/;
const WRITE = /oikos boundary guard: `\w+` writes to .*, which is in another installation \(.+\) — an installation writes only into itself/;
const ROUTE = /mount add .* --personal --dry-run.*`setup transfer`, run in the receiving installation/s;
const FAILED = /the boundary check could not run on .* \(The "paths\[0\]" argument must be of type string\. Received type number \(42\)\), so the call is denied instead of let through unchecked/;

test('a read, a search or a listing of a path of an unregistered installation is denied, in either host\'s tools', () => {
  const file = join(stranger, 'notes', 'secret.md');
  for (const [name, input] of [
    ['Read', { file_path: file }],
    ['Read', { file_path: join(stranger, 'oikos.yaml') }],
    ['Grep', { pattern: 'x', path: stranger }],
    ['Grep', { pattern: 'x', path: file }],
    ['Glob', { pattern: '**/*.md', path: stranger }],
    ['Glob', { pattern: `${stranger}/**/*.md` }],
    ['read_file', { file_path: file }],
    ['grep_search', { pattern: 'x', path: stranger }],
    ['glob', { pattern: '*.md', path: stranger }],
    ['list_directory', { path: stranger }],
  ]) {
    const reason = guard(name, input);
    assert.match(reason ?? '(allowed)', READ, `${name} ${JSON.stringify(input)}`);
    assert.match(reason, ROUTE, 'the reason says the route');
    assert.ok(reason.includes(stranger), 'the reason names the installation');
  }
});

test('the folder a search runs in, a relative path and a link are judged by where they really lead', () => {
  assert.match(guard('Grep', { pattern: 'x' }, stranger) ?? '(allowed)', READ, 'no path: the session folder is the scope');
  assert.match(guard('Glob', { pattern: '**/*.md' }, stranger) ?? '(allowed)', READ);
  for (const [name, input] of [
    ['Read', { file_path: 'link-stranger/oikos.yaml' }],
    ['Read', { file_path: 'file-link' }],
    ['Read', { file_path: 'notes/../link-stranger/oikos.yaml' }],
    ['Read', { file_path: `${stranger}/../${basename(stranger)}/oikos.yaml` }],
    ['Read', { file_path: `../${basename(stranger)}/oikos.yaml` }],
    ['Grep', { pattern: 'x', path: 'link-stranger' }],
    ['Grep', { pattern: 'x', path: `${dir}/notes/../link-stranger/notes` }],
  ]) assert.match(guard(name, input) ?? '(allowed)', READ, `${name} ${JSON.stringify(input)}`);
});

test('a glob is judged by the folder before its first wildcard, absolute or relative to its path', () => {
  for (const input of [
    { pattern: `${stranger}/notes/*.md` },
    { pattern: `${stranger}/*/oikos.yaml`, path: dir },
    { pattern: `${stranger}/oikos.yaml` },
    { pattern: `../${basename(stranger)}/**/*.md`, path: dir },
    { pattern: 'link-stranger/**/*.md', path: dir },
    { pattern: '../../**/oikos.yaml', path: join(dir, 'notes') },
    { pattern: 'notes/*.md', path: stranger },
  ]) {
    assert.match(guard('Glob', input) ?? '(allowed)', /oikos boundary guard: .*(reads|would search)/, JSON.stringify(input));
  }
  for (const input of [
    { pattern: 'notes/**/*.md', path: dir },
    { pattern: '**/*.md', path: dir },
    { pattern: '*.md', path: join(dir, 'notes') },
    { pattern: `${dir}/notes/*.md` },
    { pattern: '../notes/*.md', path: join(dir, 'notes') },
    { pattern: '{a,b}/*.md', path: dir },
    { pattern: 'a.md', path: join(dir, 'notes') },
  ]) assert.equal(guard('Glob', input), null, JSON.stringify(input));
});

test('an installation registered as a mount without use is read, in either layer; one registered with use is not', () => {
  for (const [name, input] of [
    ['Read', { file_path: join(friend, 'AGENTS.md') }],
    ['Grep', { pattern: 'x', path: friend }],
    ['Glob', { pattern: '**/*.md', path: friend }],
    ['Glob', { pattern: `${friend}/*.md` }],
    ['list_directory', { path: friend }],
    ['read_file', { file_path: join(friend, 'AGENTS.md') }],
    ['Read', { file_path: join(linked, 'AGENTS.md') }],
    ['Grep', { pattern: 'x', path: linked }],
    ['Read', { file_path: 'linked/AGENTS.md' }],
  ]) assert.equal(guard(name, input), null, `${name} ${JSON.stringify(input)}`);
  assert.match(guard('Read', { file_path: join(inner, 'AGENTS.md') }) ?? '(allowed)', READ, 'an installation inside this one, registered nowhere');
  const { dir: used } = mounted({ local: `  ${stranger}:\n    use: [wiki]\n` });
  assert.match(call('package-guard', 'Read', { file_path: join(stranger, 'AGENTS.md') }, used, used) ?? '(allowed)', READ);
  assert.match(call('package-guard', 'Read', { file_path: join(friend, 'AGENTS.md') }, used, used) ?? '(allowed)', READ, 'registered in the first installation only');
});

test('the local entry wins over the shared one: an installation registered with use in one layer and without in the other', () => {
  const entry = '  vaults/inst:\n    use: [wiki]\n    wiki: { name: inst }\n';
  const read = (installed) => call('package-guard', 'Read', { file_path: join(installed, 'vaults', 'inst', 'AGENTS.md') }, installed, installed);
  const closed = mounted({ shared: entry });
  const opened = mounted({ shared: entry, local: '  vaults/inst: ~\n' });
  for (const { dir: installed } of [closed, opened]) repository(join(installed, 'vaults', 'inst'));
  for (const { dir: installed } of [closed, opened]) write(join(installed, 'vaults', 'inst', 'oikos.yaml'), 'name: ACME Corp\n');
  assert.match(read(closed.dir) ?? '(allowed)', READ, 'shared, with use: it is no linked installation');
  assert.equal(read(opened.dir), null, 'the local entry without use is the registration');
});

test('the core, a mount, this installation and a path inside no installation are not another installation', () => {
  for (const [name, input] of [
    ['Read', { file_path: 'oikos/OIKOS.md' }],
    ['Read', { file_path: join(dir, 'oikos', 'examples', 'installation', 'oikos.yaml') }],
    ['Grep', { pattern: 'x', path: 'oikos/skills' }],
    ['Glob', { pattern: 'oikos/skills/**/SKILL.md', path: dir }],
    ['Glob', { pattern: '**/SKILL.md', path: join(dir, 'oikos') }],
    ['Read', { file_path: join(team, 'NOTES.md') }],
    ['Grep', { pattern: 'x', path: own }],
    ['Read', { file_path: join(dir, 'notes', 'a.md') }],
    ['Read', { file_path: join(dir, 'notes', 'missing.md') }],
    ['Read', { file_path: '/etc/hostname' }],
    ['Read', { file_path: join(dir, '..', 'no-such-folder', 'x.md') }],
    ['Grep', { pattern: 'x' }],
    ['list_directory', { path: dir }],
  ]) assert.equal(guard(name, input), null, `${name} ${JSON.stringify(input)}`);
});

test('a write into another installation is denied, registered or not, whatever the tool or the spelling', () => {
  for (const root of [stranger, friend, linked]) {
    const file = join(root, 'notes', 'new.md');
    for (const [name, input] of [
      ['Edit', { file_path: file, old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: file, content: 'x' }],
      ['MultiEdit', { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }] }],
      ['NotebookEdit', { notebook_path: join(root, 'a.ipynb') }],
      ['Write', { file_path: join(root, 'AGENTS.md'), content: 'x' }],
      ['edit', { file_path: file, old_string: 'a', new_string: 'b' }],
      ['write_file', { file_path: file, content: 'x' }],
      ['Write', { file_path: `${root}/../${basename(root)}/notes/new.md`, content: 'x' }],
    ]) {
      const reason = guard(name, input);
      assert.match(reason ?? '(allowed)', root === stranger ? WRITE : /is inside the mount/, `${root}: ${name}`);
      assert.ok(reason, `${name} ${JSON.stringify(input)}`);
    }
  }
  const reason = guard('Write', { file_path: join(stranger, 'notes', 'new.md'), content: 'x' });
  assert.match(reason, /setup transfer <file> --dry-run` in the receiving installation/);
  assert.ok(reason.includes(stranger));
  for (const input of [
    { file_path: 'link-stranger/notes/new.md', content: 'x' },
    { file_path: 'notes/../link-stranger/new.md', content: 'x' },
    { file_path: 'file-link', content: 'x' },
  ]) assert.match(guard('Write', input) ?? '(allowed)', WRITE, JSON.stringify(input));
});

test('a registered linked installation is closed to writes by the mount rule, and a write inside this installation is still let through', () => {
  assert.match(guard('Write', { file_path: join(friend, 'x.md'), content: 'x' }) ?? '(allowed)', /oikos package guard: .* is inside the mount `.+` — an installation writes only into itself/);
  for (const input of [
    { file_path: join(dir, 'notes', 'a.md'), old_string: 'a', new_string: 'b' },
    { file_path: join(dir, 'notes', 'new.md'), old_string: '', new_string: 'b' },
    { file_path: join(dir, '.local', 'catalog.yaml'), old_string: '', new_string: 'b' },
  ]) assert.equal(guard('Edit', input), null, JSON.stringify(input));
  assert.equal(guard('Write', { file_path: join('/tmp', 'oikos-scratch-no-installation.txt'), content: 'x' }), null, 'a folder inside no installation');
});

test('the package guard fails closed: a check that throws denies the call, naming the check and the error', () => {
  assert.throws(() => realOf('x', 42), /argument must be of type string/, 'the premise: a session folder that is no string makes the path judgement throw');
  for (const [name, input] of [
    ['Read', { file_path: 'notes/a.md' }],
    ['Edit', { file_path: 'notes/a.md', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: 'notes/new.md', content: 'x' }],
    ['Grep', { pattern: 'x', path: 'notes' }],
    ['Glob', { pattern: '*.md' }],
    ['read_file', { file_path: 'notes/a.md' }],
  ]) {
    const reason = guard(name, input, 42);
    assert.match(reason ?? '(allowed)', /^oikos package guard: /, `${name}`);
    assert.match(reason, FAILED, name);
    assert.ok(reason.includes(`\`${name}\``), 'it names the call');
  }
  assert.equal(guard('Read', { file_path: 'notes/a.md' }, dir), null, 'the same call with a real session folder is let through');
});

test('the git guard fails closed: a boundary check that throws denies the command, naming the check and the error', () => {
  const reason = call('git-guard', 'Bash', { command: 'echo a > notes/new.md' }, 42);
  assert.match(reason ?? '(allowed)', /^oikos git guard: the boundary check of the shell command could not run on `echo a > notes\/new\.md` \(/);
  assert.match(reason, /argument must be of type string\. Received type number \(42\)\), so the call is denied instead of let through unchecked/);
  assert.equal(call('git-guard', 'Bash', { command: 'echo a > notes/new.md' }, dir), null, 'the same command with a real session folder is let through');
  const long = call('git-guard', 'Bash', { command: `echo ${'word '.repeat(60)}> notes/new.md` }, 42);
  assert.ok(long.includes('…'), 'a long command is cut in the message');
});

test('the privilege, staging, commit and landing rules of the git guard decide when the boundary code throws', () => {
  for (const [command, rule] of [
    ['sudo ls > notes/x', /sudo is not run by the agent/],
    ['doas ls > notes/x', /doas is not run by the agent/],
    ['git add -A > notes/x', /stage files by name/],
    ['git add . > notes/x', /stage files by name/],
    ['git commit -a -m x > notes/x', /git commit -a` stages everything/],
    ['ls > notes/x; sudo ls', /sudo is not run by the agent/],
  ]) {
    const reason = call('git-guard', 'Bash', { command }, 42);
    assert.match(reason ?? '(allowed)', rule, command);
    assert.doesNotMatch(reason, /boundary check/, `${command}: the rule decided, not the failure of the boundary check`);
  }
  // A push whose boundary check fails is denied for the failure (a deny outranks the ask), never let through.
  assert.match(call('git-guard', 'Bash', { command: 'git push > notes/x' }, 42) ?? '(allowed)', /boundary check of the shell command could not run/);
  // Without a failure the landing rule asks, as before.
  const asked = hook(dir, 'git-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command: 'git push' } }).hookSpecificOutput;
  assert.equal(asked?.permissionDecision, 'ask');
});

test('a mount with a problem opens no read: a read-only mount that holds an installation does not let a read into it (ADR 0007 D01, D05)', () => {
  const held = mounted({ shared: '  holder:\n    use: []\n' });
  const holder = repository(join(held.dir, 'holder'));
  const nested = join(holder, 'nested');
  write(join(nested, 'oikos.yaml'), 'name: ACME Corp\n');
  write(join(nested, 'AGENTS.md'), 'rules\n');
  write(join(holder, 'plain.md'), 'p\n');
  const asked = (guardName, toolName, input) => call(guardName, toolName, input, held.dir, held.dir);
  // The resolution reports the problem and the mount stays guarded, so the nested installation is another, unregistered one.
  for (const [name, input] of [
    ['Read', { file_path: join(nested, 'AGENTS.md') }],
    ['Grep', { pattern: 'rules', path: nested }],
    ['Glob', { pattern: '*.md', path: nested }],
  ]) assert.match(asked('package-guard', name, input) ?? '(allowed)', READ, `${name} ${JSON.stringify(input)}`);
  assert.match(asked('git-guard', 'Bash', { command: `cat ${nested}/AGENTS.md` }) ?? '(allowed)', /names a path in another installation/, 'the shell');
  assert.equal(asked('package-guard', 'Read', { file_path: join(holder, 'plain.md') }), null, 'the rest of the mount is no other installation');
  assert.match(asked('git-guard', 'Bash', { command: `echo x > ${holder}/plain.md` }) ?? '(allowed)', /writes into the mount/, 'still guarded for writes');
});

test('a clean linked installation registered without `use` stays readable next to a mount with a problem', () => {
  const held = mounted({ local: `  ${friend}:\n`, shared: '  holder:\n    use: []\n' });
  repository(join(held.dir, 'holder'));
  assert.equal(call('package-guard', 'Read', { file_path: join(friend, 'AGENTS.md') }, held.dir, held.dir), null);
  assert.equal(call('git-guard', 'Bash', { command: `cat ${friend}/AGENTS.md` }, held.dir, held.dir), null);
});
