// How the package guard reads a path a file tool names, and which roots it keeps closed (ADR 0007 D01,
// D02, D05; the findings of the security audit of the mounts work): a `~` path is the home folder's,
// not the session's (H1); a `..` after a link is judged as the kernel reads it and as the host collapses
// it (H2); a leading space or an escape does not hide a path, and Qwen's `zoom_image` and `lsp` are
// file tools (L11); an entry of `mounts:` that is a problem, or sits in a file that does not parse, is
// still a guarded root (M1); the problems D01 names are reported, and read back exactly (L12); the write
// guard's record is closed to the file tools (L13). The hooks run as a host runs them
// (`host-hook.mjs <guard>`) from temporary installations (ACME Corp); nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { cleanEnv, installation, script, tempDir } from './helpers/installation.mjs';
import { configOf, hook, mounted, repository, sync, write } from './helpers/mounts.mjs';
import { guardedRoots, problemsOf, resolveMounts, scanMountKeys } from '../tools/common/mounts.mjs';
import { HOSTS } from '../tools/hooks/wiring.mjs';

const stranger = realpathSync(installation((t) => t));
// vault2 is a shared entry that is no mapping, `/elsewhere` one with an absolute path: both are problem entries, never mounts.
const outside = tempDir('outside-');
const { dir, team } = mounted({ shared: `  vault2: [wiki]\n  ${outside}:\n    use: [wiki]\n` });
const vault2 = join(dir, 'vault2');
mkdirSync(vault2);
mkdirSync(join(dir, 'notes'));
write(join(stranger, 'AGENTS.md'), 'rules\n');
const home = dirname(dir); // the hook runs with this as HOME, so `~/<name>/…` is in the temporary folder
const tilde = (path) => `~/${path.slice(home.length + 1)}`;

/** A guard's answer to a call as a host would send it, with `~` the folder `home`: the reason when denied, else null. */
function ask(guard, toolName, input, cwd = dir) {
  const r = spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'hooks', 'host-hook.mjs'), guard], {
    cwd: dir, encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: dir, HOME: home }),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, cwd, tool_input: input }),
  });
  const answer = r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()).hookSpecificOutput : undefined;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}
const file = (toolName, input, cwd) => ask('package-guard', toolName, input, cwd);
const shell = (command) => ask('git-guard', 'Bash', { command });
const CLOSED = /\.local\/outgoing\.yaml holds the words/;
const MOUNT = /is inside the mount/;

test('H1: a ~ path is the home folder\'s, in a write, a read and a search', () => {
  assert.match(file('Write', { file_path: tilde(join(dir, '.local', 'outgoing.yaml')), content: 'x' }) ?? '(allowed)', CLOSED);
  assert.match(file('Write', { file_path: tilde(join(team, 'x.md')), content: 'x' }) ?? '(allowed)', MOUNT);
  assert.match(file('Write', { file_path: tilde(join(stranger, 'x.md')), content: 'x' }) ?? '(allowed)', /another installation/);
  assert.match(file('Read', { file_path: tilde(join(stranger, 'AGENTS.md')) }) ?? '(allowed)', /another installation/);
  assert.match(file('Grep', { pattern: 'x', path: '~' }) ?? '(allowed)', /a folder above this installation/);
  assert.match(file('Glob', { pattern: '*.md', path: '~' }) ?? '(allowed)', /a folder above this installation/);
  assert.match(file('Grep', { pattern: 'x', path: tilde(stranger) }) ?? '(allowed)', /another installation/);
  assert.match(file('Edit', { file_path: `  ${tilde(join(dir, '.local', 'outgoing.yaml'))}`, old_string: 'a', new_string: 'b' }) ?? '(allowed)', CLOSED);
  // ordinary work in the installation, spelled with ~, stays open
  assert.equal(file('Write', { file_path: tilde(join(dir, 'notes', 'x.md')), content: 'x' }), null);
  assert.equal(file('Read', { file_path: tilde(join(dir, 'README.md')) }), null);
  assert.equal(file('Grep', { pattern: 'x', path: tilde(dir) }), null);
});

test('H1: another user\'s home (~name) cannot be judged and is denied', () => {
  for (const [name, input] of [
    ['Write', { file_path: '~root/.ssh/x', content: 'x' }],
    ['Read', { file_path: '~root/notes.md' }],
    ['Grep', { pattern: 'x', path: '~root' }],
    ['Glob', { pattern: '~root/**/*.md' }],
    ['MultiEdit', { edits: [{ file_path: '~root/x', old_string: 'a', new_string: 'b' }] }],
  ]) assert.match(file(name, input) ?? '(allowed)', /names ~root.*another user's home, which no guard can judge/, `${name} ${JSON.stringify(input)}`);
});

test('H2: a .. after a link is judged as the host collapses it, as well as the way the kernel reads it', () => {
  // `<dir>/oikos` leads to the core: the kernel reads `oikos/..` as the core's parent, a host as `<dir>`
  assert.match(file('Write', { file_path: `${dir}/oikos/../.local/outgoing.yaml`, content: 'x' }) ?? '(allowed)', CLOSED);
  assert.match(file('Write', { file_path: `${dir}/oikos/../vaults/team/x.md`, content: 'x' }) ?? '(allowed)', MOUNT);
  assert.match(file('Write', { file_path: `${dir}/oikos/../.local/mounts.yaml`, content: '' }) ?? '(allowed)', /Change mounts with/);
  assert.match(file('Edit', { file_path: `${dir}/oikos/../oikos.yaml`, old_string: 'vaults/team:', new_string: 'vaults/x:' }) ?? '(allowed)', /`mounts:` part/);
  assert.match(file('Write', { file_path: 'oikos/../.local/outgoing.yaml', content: 'x' }) ?? '(allowed)', CLOSED, 'relative to the session folder');
  assert.match(file('Read', { file_path: `${dir}/oikos/../../${basename(stranger)}/AGENTS.md` }) ?? '(allowed)', /another installation/);
  assert.match(file('Grep', { pattern: 'x', path: `${dir}/oikos/../..` }) ?? '(allowed)', /a folder above this installation/);
  // a link in the installation into a folder of a mount: `link/..` is the mount's folder to the kernel, and the folder of the link as text
  mkdirSync(join(team, 'deep'));
  symlinkSync(join(team, 'deep'), join(dir, 'notes', 'link-team'), 'dir');
  assert.match(file('Write', { file_path: `${dir}/notes/link-team/../x.md`, content: 'x' }) ?? '(allowed)', MOUNT);
  assert.match(file('Glob', { pattern: `{../${basename(stranger)},notes}/**/*.md` }) ?? '(allowed)', /another installation/, 'a brace group at the start of a glob');
  assert.equal(file('Glob', { pattern: '{notes,vaults}/**/*.md' }), null);
  assert.equal(file('Write', { file_path: `${dir}/notes/../notes/y.md`, content: 'x' }), null);
  assert.equal(file('Edit', { file_path: `${dir}/oikos/../oikos.yaml`, old_string: 'ACME Corp', new_string: 'ACME Corp.' }), null, 'outside mounts: it stays editable');
});

test('L11: a leading space or an escape does not hide a path; Qwen\'s zoom_image and lsp are file tools', () => {
  const closed = join(dir, '.local', 'outgoing.yaml');
  assert.match(file('Write', { file_path: ` ${join(team, 'x.md')}`, content: 'x' }) ?? '(allowed)', MOUNT);
  assert.match(file('write_file', { file_path: `${join(team, 'x.md')}\n`, content: 'x' }) ?? '(allowed)', MOUNT);
  assert.match(file('write_file', { file_path: `\t${closed}`, content: 'x' }) ?? '(allowed)', CLOSED);
  assert.match(file('Write', { file_path: `${team}/a\\ b.md`, content: 'x' }) ?? '(allowed)', MOUNT);
  const image = join(stranger, 'shot.png');
  assert.match(file('zoom_image', { file_path: image, x1: 0, y1: 0, x2: 10, y2: 10 }) ?? '(allowed)', /another installation/);
  assert.match(file('zoom_image', { file_path: ` ${image} `, x1: 0, y1: 0, x2: 10, y2: 10 }) ?? '(allowed)', /another installation/);
  assert.match(file('lsp', { operation: 'documentSymbol', filePath: join(stranger, 'AGENTS.md') }) ?? '(allowed)', /another installation/);
  assert.match(file('lsp', { operation: 'hover', filePath: `file://${join(stranger, 'AGENTS.md')}`, line: 1, character: 1 }) ?? '(allowed)', /another installation/);
  assert.match(file('lsp', { operation: 'incomingCalls', callHierarchyItem: { name: 'f', uri: `file://${join(stranger, 'AGENTS.md')}` } }) ?? '(allowed)', /another installation/);
  assert.equal(file('lsp', { operation: 'workspaceSymbol', query: 'f' }), null, 'no path: nothing to judge');
  assert.equal(file('lsp', { operation: 'documentSymbol', filePath: join(dir, 'notes', 'a.md') }), null);
  assert.equal(file('zoom_image', { file_path: join(dir, 'notes', 'a.png'), x1: 0, y1: 0, x2: 10, y2: 10 }), null);
  // the wiring names both tools in Qwen's file matcher (installations need a `sync`)
  assert.match(HOSTS.qwen.matchers.file, /\|zoom_image\|lsp\|/);
});

test('M1: an entry of mounts: that is a problem stays guarded — a file tool and a shell redirection cannot write there', () => {
  const config = configOf(dir);
  assert.ok(!config.mounts.some((m) => m.path === 'vault2'), 'vault2 is no mount');
  assert.ok(config.problems.some((p) => p.includes('mounts.vault2: must be null (a read-only mount) or a mapping')));
  assert.ok(config.problems.some((p) => p.includes('a shared mount path is relative to the installation')), 'the absolute shared path is a problem');
  assert.match(file('Write', { file_path: join(vault2, 'n.md'), content: 'x' }) ?? '(allowed)', /inside the mount `vault2`/);
  assert.match(file('Write', { file_path: join(outside, 'n.md'), content: 'x' }) ?? '(allowed)', MOUNT);
  assert.match(shell('echo x > vault2/n.md') ?? '(allowed)', /oikos mount guard: .*writes into the mount `vault2`/);
  assert.equal(file('Write', { file_path: join(dir, 'notes', 'x.md'), content: 'x' }), null, 'the installation stays open');
  assert.equal(file('Read', { file_path: join(vault2, 'n.md') }), null, 'reading stays open');
  assert.equal(shell('echo x > notes/n.md'), null);
});

/** The reason the guard `guardName` denies a call in the installation `where`, else null. */
function decided(where, guardName, toolName, input) {
  const answer = hook(where, guardName, { hook_event_name: 'PreToolUse', tool_name: toolName, cwd: where, tool_input: input }).hookSpecificOutput;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}

/** An installation with the folder `vault2` (a repository, no mount of it declared) and `mutate` applied to its configuration; both a file tool and a redirection must be denied there, `notes/` stays open. */
function withVault2(mutate) {
  const { dir: here } = mounted();
  mkdirSync(join(here, 'vault2'));
  mkdirSync(join(here, 'notes'));
  mutate(here);
  return here;
}
const closedVault2 = (here, why) => {
  assert.match(decided(here, 'package-guard', 'Write', { file_path: join(here, 'vault2', 'n.md'), content: 'x' }) ?? '(allowed)', /inside the mount `vault2`/, `${why}: Write`);
  assert.match(decided(here, 'git-guard', 'Bash', { command: 'echo x > vault2/n.md' }) ?? '(allowed)', /writes into the mount `vault2`/, `${why}: echo >`);
  assert.equal(decided(here, 'package-guard', 'Write', { file_path: join(here, 'notes', 'x.md'), content: 'x' }), null, `${why}: the installation stays open`);
  assert.equal(decided(here, 'package-guard', 'Read', { file_path: join(here, 'vault2', 'n.md') }), null, `${why}: reading stays open`);
};

test('M-A: a mounts: that is no mapping is a problem, and what it names stays guarded (D01)', () => {
  const variants = [
    ['a block list in oikos.yaml', (here) => write(join(here, 'oikos.yaml'), 'organization: {name: ACME Corp}\nmounts:\n  - vault2\n'), 'oikos.yaml'],
    ['a flow list in oikos.yaml', (here) => write(join(here, 'oikos.yaml'), 'organization: {name: ACME Corp}\nmounts: [vault2]\n'), 'oikos.yaml'],
    ['a lone string in oikos.yaml', (here) => write(join(here, 'oikos.yaml'), 'organization: {name: ACME Corp}\nmounts: vault2\n'), 'oikos.yaml'],
    ['a list of mappings in oikos.yaml', (here) => write(join(here, 'oikos.yaml'), 'organization: {name: ACME Corp}\nmounts:\n  - vault2: {use: [wiki]}\n'), 'oikos.yaml'],
    ['a block list in .local/mounts.yaml', (here) => write(join(here, '.local', 'mounts.yaml'), 'mounts:\n  - vault2\n'), '.local/mounts.yaml'],
    ['a flow list in .local/mounts.yaml', (here) => write(join(here, '.local', 'mounts.yaml'), 'mounts: [vault2]\n'), '.local/mounts.yaml'],
  ];
  for (const [why, mutate, file] of variants) {
    const here = withVault2(mutate);
    const { problems, mounts } = configOf(here);
    assert.ok(problems.some((p) => p === `${file}: 'mounts' must be a mapping`), `${why}: ${problems.join('\n')}`);
    assert.ok(!mounts.some((m) => m.path === 'vault2'), `${why}: vault2 is no mount`);
    closedVault2(here, why);
  }
  // the control: the same entry as a mapping is a mount and stays guarded
  const mapped = withVault2((here) => write(join(here, 'oikos.yaml'), 'organization: {name: ACME Corp}\nmounts:\n  vault2:\n'));
  assert.ok(configOf(mapped).mounts.some((m) => m.path === 'vault2'));
  closedVault2(mapped, 'a mapping');
});

test('M-A: a circular alias in a mount entry is a problem entry that stays guarded, and the configuration still resolves', () => {
  for (const [why, mutate, file] of [
    ['a circular use in oikos.yaml', (here) => write(join(here, 'oikos.yaml'), 'organization: {name: ACME Corp}\nmounts:\n  vault2:\n    use: &u [*u]\n'), 'oikos.yaml'],
    ['a circular skills.prefix in .local/mounts.yaml', (here) => write(join(here, '.local', 'mounts.yaml'), 'mounts:\n  vault2:\n    use: [skills]\n    skills: {prefix: &p [*p]}\n'), '.local/mounts.yaml'],
  ]) {
    const here = withVault2(mutate);
    const { problems } = configOf(here); // resolving does not throw
    assert.ok(problems.some((p) => p.startsWith(`${file}: mounts.vault2: `)), `${why}: ${problems.join('\n')}`);
    closedVault2(here, why);
  }
});

test('M-A: when the configuration cannot be resolved at all, every path both mounts files name stays guarded and no read opens (D02)', () => {
  // A circular value in a part of oikos.yaml that other code reads (the desk's thresholds) makes config() throw; the guard still holds what the files name.
  const here = withVault2((root) => {
    write(join(root, 'oikos.yaml'), 'organization: {name: ACME Corp}\ndesk: &d {warm_days: *d}\nmounts:\n  vault2:\n');
    write(join(root, '.local', 'mounts.yaml'), 'mounts:\n  notes/inbox-vault: ~\n');
  });
  const thrown = script(here, "import { config } from './oikos/tools/common/config.mjs'; try { config(); console.log('resolved'); } catch (e) { console.log('threw'); }");
  assert.match(thrown.stdout, /^threw/, 'the premise: config() throws here');
  closedVault2(here, 'config() not resolvable');
  write(join(here, 'vault2', 'inner', 'oikos.yaml'), 'organization: {name: ACME Corp}\n');
  assert.match(decided(here, 'package-guard', 'Read', { file_path: join(here, 'vault2', 'inner', 'oikos.yaml') }) ?? '(allowed)', /another installation/, 'a guarded root opens no read');
  mkdirSync(join(here, 'notes', 'inbox-vault'), { recursive: true });
  assert.match(decided(here, 'package-guard', 'Write', { file_path: join(here, 'notes', 'inbox-vault', 'n.md'), content: 'x' }) ?? '(allowed)', /inside the mount/, 'the local file\'s keys too');
});

test('M1: the guarded roots leave out the installation, the core and .local/, which other rules hold', () => {
  const root = realpathSync(tempDir('plain-'));
  mkdirSync(join(root, '.local'));
  const roots = guardedRoots(root, ['.', 'vault', 'vault/', '.local/x', 'oikos/skills', '', 'a/../b', '/'], 'shared');
  assert.deepEqual(roots.map((g) => g.root), [join(root, 'vault'), join(root, 'b')]);
  assert.deepEqual(guardedRoots(root, ['../side'], 'local').map((g) => g.root), [join(dirname(root), 'side')]);
});

test('M1: an oikos.yaml that does not parse keeps its shared mounts guarded, and every other edit stays possible', () => {
  const { dir: broken } = mounted();
  write(join(broken, 'oikos.yaml'), 'organization: {name: ACME Corp\nmounts:\n  vaults/team:\n    use: [wiki]\n  "new vault":\n    use: [wiki\n  other: ~\n');
  const config = configOf(broken);
  assert.ok(config.problems.some((p) => /oikos\.yaml does not parse/.test(p)));
  assert.deepEqual(config.mounts.map((m) => m.layer), ['local'], 'no shared mount is configured from a file that does not read');
  const roots = ['vaults/team', 'new vault', 'other'].map((p) => join(broken, p));
  for (const root of roots) {
    mkdirSync(root, { recursive: true });
    const r = spawnSync(process.execPath, [join(broken, 'oikos', 'tools', 'hooks', 'host-hook.mjs'), 'package-guard'], {
      cwd: broken, encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: broken }),
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: broken, tool_input: { file_path: join(root, 'n.md'), content: 'x' } }),
    });
    assert.match(r.stdout, /inside the mount/, root);
  }
  const ok = spawnSync(process.execPath, [join(broken, 'oikos', 'tools', 'hooks', 'host-hook.mjs'), 'package-guard'], {
    cwd: broken, encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: broken }),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: broken, tool_input: { file_path: join(broken, 'notes.md'), content: 'x' } }),
  });
  assert.equal(ok.stdout.trim(), '', 'the file can be repaired and worked in');
});

test('the keys of a mounts: block are scanned from text that does not parse', () => {
  assert.deepEqual(scanMountKeys('name: x\nmounts:\n  a/b:\n    use: [wiki\n  "c d": ~\n  \'e\':\n    x: 1\n# c\nother:\n  not-a-mount:\n'), ['a/b', 'c d', 'e']);
  assert.deepEqual(scanMountKeys('mounts: { a: {use: [wiki]}, "b c": ~, d: 1\n'), ['a', 'b c', 'd']);
  assert.deepEqual(scanMountKeys('mounts:\n\n  # note\n  /abs/p:\n    use: [\n'), ['/abs/p']);
  assert.deepEqual(scanMountKeys('organization: {}\n'), []);
});

test('L5: the scan of a mounts file that does not parse finds a mount in every shape that names one', () => {
  const scanned = {
    'a block list': ['mounts:\n  - vault2\nbad: [\n', ['vault2']],
    'a block list at the key\'s column': ['mounts:\n- vault2\n- "c d"\nbad: [\n', ['vault2', 'c d']],
    'a list of mappings': ['mounts:\n  - vault2: {use: [wiki]}\n  - other:\n      use: [wiki\n', ['vault2', 'other']],
    'a flow list': ['mounts: [vault2, "c d", {e: 1}]\nbad: [\n', ['vault2', 'c d', 'e']],
    'a flow list over lines': ['mounts: [\n  vault2,\n  other\n]\nbad: [\n', ['vault2', 'other']],
    'a lone name': ['mounts: vault2\nbad: [\n', ['vault2']],
    'an alias whose anchor is elsewhere': ['base: &m\n  vault2: {use: [wiki]}\nmounts: *m\nbad: [\n', ['vault2']],
    'an anchor with a flow mapping': ['base: &m {vault2: ~, other: ~}\nmounts: *m\nbad: [\n', ['vault2', 'other']],
    'a complex key': ['mounts:\n  ? vault2\n  : {use: [wiki]}\n  ? "c d"\n  :\nbad: [\n', ['vault2', 'c d']],
    'a quoted mounts key': ['"mounts":\n  vault2: ~\nbad: [\n', ['vault2']],
    'a top-level list': ['- mounts: {vault2: {use: [wiki]}}\nbad: [\n', ['vault2']],
    'a top-level list, block': ['- mounts:\n    vault2: ~\n    other: ~\n- x: [\n', ['vault2', 'other']],
    'a comment and a blank line': ['mounts:\n\n  # note\n  - vault2 # here\nbad: [\n', ['vault2']],
  };
  for (const [why, [text, expected]] of Object.entries(scanned)) assert.deepEqual(scanMountKeys(text), expected, why);
  // controls: what is not under mounts: is no mount, and a valid file is read as before
  assert.deepEqual(scanMountKeys('desk:\n  - not-a-mount\nmounts:\nother: x\n'), []);
  assert.deepEqual(scanMountKeys('mounts:\n  a/b:\n    use: [wiki]\n    wiki: { name: v }\n  c: ~\n'), ['a/b', 'c']);
});

test('L5: a mounts file that does not parse keeps the mount guarded in every declaring shape — a file tool and a redirection are denied, the installation stays open', () => {
  const unparsable = 'bad: [\n';
  const variants = [
    ['a block list', (here) => write(join(here, 'oikos.yaml'), `organization: {name: ACME Corp}\nmounts:\n  - vault2\n${unparsable}`)],
    ['an alias with the anchor elsewhere', (here) => write(join(here, 'oikos.yaml'), `organization: {name: ACME Corp}\nbase: &m\n  vault2: {use: [wiki]}\nmounts: *m\n${unparsable}`)],
    ['a complex key', (here) => write(join(here, 'oikos.yaml'), `organization: {name: ACME Corp}\nmounts:\n  ? vault2\n  : {use: [wiki]}\n${unparsable}`)],
    ['a lone name', (here) => write(join(here, 'oikos.yaml'), `organization: {name: ACME Corp}\nmounts: vault2\n${unparsable}`)],
    ['a local file with a list at the top', (here) => write(join(here, '.local', 'mounts.yaml'), '- mounts: {vault2: {use: [wiki]}}\n')],
    ['a local block list that does not parse', (here) => write(join(here, '.local', 'mounts.yaml'), `mounts:\n  - vault2\n${unparsable}`)],
  ];
  for (const [why, mutate] of variants) {
    const here = withVault2(mutate);
    const { problems } = configOf(here);
    assert.ok(problems.some((p) => /does not parse|must be a mapping|top level must be a mapping/.test(p)), `${why}: ${problems.join('\n')}`);
    closedVault2(here, why);
  }
  // the scanner never closes the installation itself, and a valid file is unchanged
  const root = realpathSync(tempDir('scan-'));
  mkdirSync(join(root, '.local'));
  assert.deepEqual(guardedRoots(root, scanMountKeys('mounts:\n  - .\n  - vault\n  - ""\nbad: [\n'), 'shared').map((g) => g.root), [join(root, 'vault')]);
  closedVault2(withVault2((here) => write(join(here, 'oikos.yaml'), 'organization: {name: ACME Corp}\nmounts:\n  vault2:\n    use: [wiki]\n    wiki: { name: v }\n')), 'a valid file');
});

test('L12: a mount that holds an installation, and a linked installation declared with use, are problems', () => {
  const { dir: here } = mounted();
  const holder = repository(join(here, 'projects', 'holder'));
  write(join(holder, 'deep', 'er', 'oikos.yaml'), 'name: ACME Corp\n'); // an installation two levels down
  const linked = join(here, 'linked');
  write(join(linked, 'oikos.yaml'), 'name: ACME Corp\n');
  repository(linked);
  write(join(here, '.local', 'mounts.yaml'), `mounts:\n  ${holder}:\n    use: [skills]\n  ${linked}:\n    use: [wiki]\n    wiki: { name: linked }\n`);
  const problems = configOf(here).problems;
  assert.ok(problems.some((p) => p.includes(`mounts.${holder}: it holds the installation ${join(holder, 'deep', 'er')}`)), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes(`mounts.${linked}: a linked installation is registered with \`use\``)), problems.join('\n'));
  assert.notEqual(sync(here, '--check').status, 0, 'sync --check is red on them');
  // registered without use, the linked installation is no problem
  write(join(here, '.local', 'mounts.yaml'), `mounts:\n  ${linked}:\n`);
  assert.ok(!configOf(here).problems.some((p) => p.includes('installation')), 'a registered linked installation');
});

test('L-f: a linked installation registered without use that holds another installation is a problem; a clean one is not (D01)', () => {
  const { dir: here } = mounted();
  const linked = repository(join(here, 'linked'));
  write(join(linked, 'oikos.yaml'), 'organization: {name: ACME Corp}\n');
  symlinkSync(realpathSync(join(here, 'oikos')), join(linked, 'oikos')); // its own core link is no nested installation
  write(join(here, '.local', 'mounts.yaml'), `mounts:\n  ${linked}:\n`);
  assert.deepEqual(configOf(here).problems, [], 'clean: no problem, readable');
  assert.equal(decided(here, 'package-guard', 'Read', { file_path: join(linked, 'oikos.yaml') }), null);
  const nested = join(linked, 'sub', 'deeper');
  write(join(nested, 'oikos.yaml'), 'organization: {name: ACME Corp}\n');
  write(join(nested, 'AGENTS.md'), 'rules\n');
  const { problems } = configOf(here);
  assert.ok(problems.some((p) => p.startsWith(`.local/mounts.yaml: mounts.${linked}: it holds the installation ${nested} — a mount does not contain another installation`)), problems.join('\n'));
  assert.ok(!problems.some((p) => p.includes('registered with `use`')), 'no use, no such problem');
  assert.match(decided(here, 'package-guard', 'Read', { file_path: join(nested, 'AGENTS.md') }) ?? '(allowed)', /another installation/, 'a read into the nested one is closed');
  assert.match(decided(here, 'package-guard', 'Write', { file_path: join(linked, 'n.md'), content: 'x' }) ?? '(allowed)', /another installation|inside the mount/, 'writes stay guarded');
  assert.match(decided(here, 'git-guard', 'Bash', { command: `echo x > ${linked}/n.md` }) ?? '(allowed)', /another installation|writes into the mount/);
});

test('L12: a mount that holds the core is a problem', () => {
  const { dir: here } = mounted();
  write(join(here, '.local', 'mounts.yaml'), `mounts:\n  ${dirname(realpathSync(join(here, 'oikos')))}:\n`);
  assert.ok(configOf(here).problems.some((p) => p.includes('a mount is not the core or a folder that holds it')));
});

test('L12: problemsOf names the mount a problem is about, exactly, whatever its path holds', () => {
  const root = realpathSync(tempDir('exact-'));
  const odd = 'notes: v2'; // a path with `: ` in it, and one that is its start
  const plain = 'notes';
  for (const name of [odd, plain, 'x (shared)']) repository(join(root, name));
  const { mounts, problems } = resolveMounts(root, { [odd]: { use: ['bogus'] }, [plain]: null, 'x (shared)': null }, {});
  const [oddMount, plainMount, other] = mounts;
  assert.equal(oddMount.path, odd);
  const own = problemsOf(oddMount, problems);
  assert.ok(own.length >= 1, 'the odd path has its problems');
  assert.ok(own.every((p) => p.startsWith(`oikos.yaml: mounts.${JSON.stringify(odd)}: `)), own.join('\n'));
  assert.deepEqual(problemsOf(plainMount, problems), [], 'a path that starts the other\'s is not blamed');
  assert.deepEqual(problemsOf(other, problems), [], 'nor one that ends like a layer name');
  repository(join(root, 'notes', 'sub'));
  const again = resolveMounts(root, { notes: null, 'notes/sub': null }, {});
  const overlap = /^oikos\.yaml: mounts\.notes: overlaps the mount notes\/sub \(shared\)$/;
  assert.ok(problemsOf(again.mounts[0], again.problems).some((p) => overlap.test(p)), 'the entry it is declared in');
  assert.ok(problemsOf(again.mounts[1], again.problems).some((p) => overlap.test(p)), 'and the mount it overlaps');
});

test('L13: the write guard\'s record in the temporary folder is not changed by a file tool', () => {
  const record = join(tmpdir(), 'oikos-hooks', 'writes-forged.json');
  for (const [name, input] of [
    ['Write', { file_path: record, content: '{"prompts":0,"dryRuns":{"x":0}}' }],
    ['Edit', { file_path: record, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: record, edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['NotebookEdit', { notebook_path: record }],
    ['write_file', { file_path: record, content: 'x' }],
    ['Write', { file_path: join(tmpdir(), 'oikos-hooks', '..', 'oikos-hooks', 'x.json'), content: 'x' }],
  ]) assert.match(file(name, input) ?? '(allowed)', /in the hook state folder .*could forge a dry run/, `${name} ${JSON.stringify(input).slice(0, 60)}`);
  assert.equal(file('Read', { file_path: record }), null, 'reading it is open');
  assert.equal(file('Write', { file_path: join(tmpdir(), 'oikos-other', 'x.json'), content: 'x' }), null, 'only that folder');
});
