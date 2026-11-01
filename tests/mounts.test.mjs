// Mounts, the trunk (docs/design/mounts.md): the two config layers merged by real path with their
// problems, what sync wires per mount (rule exclusions both ways, the outside mount's directory, the
// mount's .git/info/exclude, the record in .local/sync.json), the check that goes red, the package
// guard that keeps file tools out of every mount, and the session-start lines. (The files that declare
// the mounts, the narrowing rule, `skills.commit` and `setup mount` are in mounts-edit.test.mjs.) Each test makes a
// temporary installation (ACME Corp) with real `git init` mounts: `vaults/team` (a nested wiki),
// `projects/dev-root` (a skills mount) and an outside wiki in the local layer. Nothing here reaches
// the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CORE, cleanEnv, installation, tempDir } from './helpers/installation.mjs';
import { ENV, configOf, hook, mounted, readJson, repository, status, sync, write } from './helpers/mounts.mjs';

test('config merges the two layers by real path, the local entry replacing the shared one whole', () => {
  const { dir, team, own } = mounted();
  const before = configOf(dir);
  assert.deepEqual(before.problems, []);
  assert.deepEqual(before.mounts.map((m) => [m.path, m.layer, m.inside]), [['vaults/team', 'shared', true], ['projects/dev-root', 'shared', true], [own, 'local', false]]);
  const t = before.mounts[0];
  assert.deepEqual({ root: t.root, use: t.use, skills: t.skills, wiki: t.wiki }, {
    root: team, use: ['wiki'], skills: null, wiki: { name: 'team', rules: 'NOTES.md', template: null, inbox: 'inbox/', default: false },
  });
  assert.deepEqual(before.mounts[1].skills, { from: '.claude/skills', prefix: 'dev', only: ['deploy-status'], commit: false });
  assert.equal(before.mounts[2].wiki.default, true);

  // the personal layer names the shared mount by its absolute path: the same real path, so it replaces it
  mkdirSync(join(team, '.claude', 'skills'), { recursive: true });
  write(join(dir, '.local', 'mounts.yaml'), `mounts:\n  ${team}:\n    use: [skills]\n    skills: { prefix: team }\n`);
  const after = configOf(dir);
  assert.deepEqual(after.problems, []);
  assert.equal(after.mounts.length, 2, 'one mount per real path');
  assert.deepEqual(after.mounts.map((m) => m.path), [team, 'projects/dev-root'], 'the local entry takes the shared entry\'s place');
  assert.deepEqual({ layer: after.mounts[0].layer, use: after.mounts[0].use, wiki: after.mounts[0].wiki, skills: after.mounts[0].skills },
    { layer: 'local', use: ['skills'], wiki: null, skills: { from: '.claude/skills', prefix: 'team', only: null, commit: false } }, 'nothing of the replaced entry is kept');
});

test('config reports a mount that cannot be one, each with its place', () => {
  const { dir, dev } = mounted({
    shared: `  /abs/path: ~
  ../up: ~
  vaults/nowhere: ~
  .local/hidden: ~
  oikos/inside: ~
  vaults/team/inner:
    use: [wiki, rules]
    colour: red
  vaults/plain: ~
  vaults/clash:
    use: [wiki]
    wiki: { name: team, default: true }
`,
    local: '',
  });
  repository(join(dir, 'vaults', 'team', 'inner'));
  mkdirSync(join(dir, 'vaults', 'plain'));
  repository(join(dir, 'vaults', 'clash'));
  write(join(dir, '.local', 'mounts.yaml'), `${readFileSync(join(dir, '.local', 'mounts.yaml'), 'utf8')}  ${dev}: ~\n  ${dev}/../dev-root: ~\n`);
  const text = configOf(dir).problems.join('\n');
  for (const expected of [
    /oikos\.yaml: mounts\.\/abs\/path: a shared mount path is relative/,
    /oikos\.yaml: mounts\.\.\.\/up: a shared mount path has no '\.\.'/,
    /oikos\.yaml: mounts\.vaults\/nowhere: .*does not exist/,
    /oikos\.yaml: mounts\.\.local\/hidden: a mount is not at or under oikos\/ or \.local\//,
    /oikos\.yaml: mounts\.oikos\/inside: a mount is not at or under oikos\/ or \.local\//,
    /oikos\.yaml: mounts\.vaults\/team\/inner: use: unknown value "rules"/,
    /oikos\.yaml: mounts\.vaults\/team\/inner: colour: unknown key/,
    new RegExp(`oikos\\.yaml: mounts\\.vaults/team: overlaps the mount vaults/team/inner \\(shared\\)`),
    /oikos\.yaml: mounts\.vaults\/plain: .*is not the top of a repository/,
    /oikos\.yaml: mounts\.vaults\/clash: the wiki name 'team' is also the mount vaults\/team's/,
    /\.local\/mounts\.yaml: mounts\..*: wiki\.default: vaults\/clash is the default wiki already/,
    /\.local\/mounts\.yaml: mounts\..*dev-root: the same folder is declared twice in \.local\/mounts\.yaml/,
  ]) assert.match(text, expected);
});

test('config checks skills.only against the skill folders under skills.from', () => {
  const ok = mounted();
  assert.deepEqual(configOf(ok.dir).problems, []);
  const bad = mounted({ shared: '' });
  write(join(bad.dir, 'oikos.yaml'), readFileSync(join(bad.dir, 'oikos.yaml'), 'utf8').replace('only: [deploy-status]', 'only: [deploy-status, nope]'));
  assert.deepEqual(configOf(bad.dir).problems, ["oikos.yaml: mounts.projects/dev-root: skills.only: 'nope' is not a skill folder under .claude/skills"]);
});

test('sync wires the mounts, writes absolute paths only into local files, and a second run changes nothing', () => {
  const { dir, team, dev, own } = mounted();
  const first = sync(dir);
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const rulesOf = (root) => [`${root}/**/CLAUDE.md`, `${root}/**/CLAUDE.local.md`, `${root}/**/.claude/rules/**`];
  const local = readJson(join(dir, '.claude', 'settings.local.json'));
  assert.deepEqual(local.claudeMdExcludes, [...rulesOf(team), ...rulesOf(dev)], 'item 1: the rules of an inside mount are not loaded here');
  assert.deepEqual(local.permissions.additionalDirectories, [CORE, own], 'an outside mount is a directory of the session');

  assert.deepEqual(readJson(join(team, '.claude', 'settings.local.json')).claudeMdExcludes,
    [`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`, `${dir}/vaults/CLAUDE.md`, `${dir}/vaults/CLAUDE.local.md`], 'item 2: the installation, and the folder between it and the mount');
  assert.deepEqual(readJson(join(dev, '.claude', 'settings.local.json')).claudeMdExcludes, [`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`, `${dir}/projects/CLAUDE.md`, `${dir}/projects/CLAUDE.local.md`]);
  assert.ok(!existsSync(join(own, '.claude')), 'nothing is written inside an outside mount');

  assert.match(readFileSync(join(team, '.git', 'info', 'exclude'), 'utf8'), /^\/\.claude\/settings\.local\.json$/m, 'item 3');
  assert.equal(status(team), '', 'the mount shows nothing new to commit');
  assert.doesNotMatch(status(dev), /settings\.local\.json/, 'only the mount\'s own files show');

  assert.deepEqual(readJson(join(dir, '.local', 'sync.json')).mounts, {
    [team]: { installExcludes: rulesOf(team), excludes: [`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`, `${dir}/vaults/CLAUDE.md`, `${dir}/vaults/CLAUDE.local.md`], created: true, ignored: ['/.claude/settings.local.json'] },
    [dev]: { installExcludes: rulesOf(dev), pointers: ['dev-deploy-status'], excludes: [`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`, `${dir}/projects/CLAUDE.md`, `${dir}/projects/CLAUDE.local.md`], created: true, ignored: ['/.claude/settings.local.json'] },
    [own]: { installDirs: [own] },
  });
  assert.ok(readJson(join(dir, '.local', 'sync.json')).mcp.includes('chrome-devtools'), 'the MCP record is kept beside it');

  // absolute paths of mounts stay out of what is committed: oikos.yaml, the shared settings, the pointers
  for (const committed of ['oikos.yaml', '.claude/settings.json', '.claude/skills/wiki/SKILL.md']) assert.ok(!readFileSync(join(dir, committed), 'utf8').includes(dir), committed);
  assert.ok(!readFileSync(join(dir, 'oikos.yaml'), 'utf8').includes(own));

  const files = [join(dir, '.claude', 'settings.local.json'), join(team, '.claude', 'settings.local.json'), join(team, '.git', 'info', 'exclude'), join(dir, '.local', 'sync.json')];
  const snapshot = () => files.map((f) => readFileSync(f, 'utf8'));
  const before = snapshot();
  const second = sync(dir);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.doesNotMatch(second.stdout, /^wrote:/m);
  assert.deepEqual(snapshot(), before);
  const check = sync(dir, '--check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('sync keeps the person\'s own entries and keys, and removing a mount removes exactly its wiring', () => {
  const { dir, team, dev, own } = mounted();
  // what the person and the mount's own framework wrote already, one entry of it the same as sync's
  write(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ model: 'kept', claudeMdExcludes: ['/mine/**/CLAUDE.md'], permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/mine'] } }));
  write(join(team, '.claude', 'settings.local.json'), JSON.stringify({ theme: 'dark', claudeMdExcludes: ['/own/CLAUDE.md', `${dir}/CLAUDE.md`] }));
  write(join(team, '.git', 'info', 'exclude'), '# mine\n/scratch/\n');
  write(join(dev, '.gitignore'), '.claude/settings.local.json\n'); // already ignored there: sync adds no line
  assert.equal(sync(dir).status, 0);

  const local = readJson(join(dir, '.claude', 'settings.local.json'));
  assert.equal(local.model, 'kept');
  assert.deepEqual(local.permissions.allow, ['Bash(ls)']);
  assert.deepEqual(local.permissions.additionalDirectories, ['/mine', CORE, own]);
  assert.equal(local.claudeMdExcludes[0], '/mine/**/CLAUDE.md');
  const mine = readJson(join(team, '.claude', 'settings.local.json'));
  assert.equal(mine.theme, 'dark');
  assert.deepEqual(mine.claudeMdExcludes.slice(0, 2), ['/own/CLAUDE.md', `${dir}/CLAUDE.md`], 'the person\'s entries come first and are not repeated');
  assert.equal(mine.claudeMdExcludes.filter((e) => e === `${dir}/CLAUDE.md`).length, 1);
  assert.match(readFileSync(join(team, '.git', 'info', 'exclude'), 'utf8'), /^# mine\n\/scratch\/\n\/\.claude\/settings\.local\.json\n$/);
  assert.ok(!readFileSync(join(dev, '.git', 'info', 'exclude'), 'utf8').includes('settings.local.json'), 'a file git already ignores gets no line');
  const record = readJson(join(dir, '.local', 'sync.json')).mounts;
  assert.ok(!record[team].excludes.includes(`${dir}/CLAUDE.md`), 'an entry that was there is the person\'s, not sync\'s');
  assert.equal(record[dev].ignored, undefined);

  // drop the shared wiki, the skills mount and the personal wiki: only what sync wrote goes
  write(join(dir, 'oikos.yaml'), readFileSync(join(dir, 'oikos.yaml'), 'utf8').replace(/\nmounts:[\s\S]*$/, '\n'));
  write(join(dir, '.local', 'mounts.yaml'), 'mounts:\n');
  const removal = sync(dir);
  assert.equal(removal.status, 0, removal.stdout + removal.stderr);
  const after = readJson(join(dir, '.claude', 'settings.local.json'));
  assert.deepEqual(after.claudeMdExcludes, ['/mine/**/CLAUDE.md']);
  assert.deepEqual(after.permissions.additionalDirectories, ['/mine', CORE]);
  assert.deepEqual(readJson(join(team, '.claude', 'settings.local.json')), { theme: 'dark', claudeMdExcludes: ['/own/CLAUDE.md', `${dir}/CLAUDE.md`] });
  assert.equal(readFileSync(join(team, '.git', 'info', 'exclude'), 'utf8'), '# mine\n/scratch/\n');
  assert.ok(!existsSync(join(dev, '.claude', 'settings.local.json')), 'a settings file sync created goes when it is empty');
  assert.equal(readJson(join(dir, '.local', 'sync.json')).mounts && Object.keys(readJson(join(dir, '.local', 'sync.json')).mounts).length, 0);
  assert.equal(sync(dir, '--check').status, 0);
});

test('sync --check is red for a mount that is wrong and for wiring that is missing or stale', () => {
  const { dir } = mounted({ shared: '  vaults/missing: ~\n' });
  const red = sync(dir, '--check');
  assert.equal(red.status, 1);
  assert.match(red.stdout, /problem: oikos\.yaml: mounts\.vaults\/missing: .*does not exist/);

  const ok = mounted();
  assert.equal(sync(ok.dir).status, 0);
  assert.equal(sync(ok.dir, '--check').status, 0);
  // wiring removed by hand: the mount's own file, and then the installation's
  writeFileSync(join(ok.team, '.claude', 'settings.local.json'), '{}\n');
  const missing = sync(ok.dir, '--check');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /out of date: vaults\/team\/\.claude\/settings\.local\.json claudeMdExcludes/);
  assert.equal(sync(ok.dir).status, 0);
  const local = readJson(join(ok.dir, '.claude', 'settings.local.json'));
  writeFileSync(join(ok.dir, '.claude', 'settings.local.json'), JSON.stringify({ ...local, claudeMdExcludes: [] }));
  assert.match(sync(ok.dir, '--check').stdout, /out of date: \.claude\/settings\.local\.json claudeMdExcludes/);
  assert.equal(sync(ok.dir).status, 0);
  // stale: the entry is gone from the configuration, its wiring is still there
  write(join(ok.dir, '.local', 'mounts.yaml'), 'mounts:\n');
  const stale = sync(ok.dir, '--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /out of date: \.claude\/settings\.local\.json additionalDirectories/);
});

test('sync --check is red for each of the other problems of the configuration', () => {
  const { dir } = mounted({ shared: '  /abs/path: ~\n  vaults/team/inner: ~\n' });
  repository(join(dir, 'vaults', 'team', 'inner'));
  const red = sync(dir, '--check');
  assert.equal(red.status, 1);
  assert.match(red.stdout, /problem: oikos\.yaml: mounts\.\/abs\/path: a shared mount path is relative/);
  assert.match(red.stdout, /problem: oikos\.yaml: mounts\.vaults\/team: overlaps the mount vaults\/team\/inner/);
});

test('the package guard keeps file tools out of every mount, a wiki included, and leaves reads open', () => {
  const { dir, team, dev, own } = mounted();
  symlinkSync(own, join(dir, 'shortcut'), 'dir');
  const send = (name, path, key = 'file_path') => hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: name, cwd: dir, tool_input: { [key]: path } })
    .hookSpecificOutput;
  for (const name of ['Edit', 'Write']) {
    for (const [path, mount] of [[join(team, 'inbox', 'note.md'), 'vaults/team'], ['vaults/team/note.md', 'vaults/team'], [join(dev, '.claude', 'skills', 'deploy-status', 'SKILL.md'), 'projects/dev-root'],
      [join(own, 'note.md'), own], ['shortcut/note.md', own]]) {
      const answer = send(name, path);
      assert.equal(answer?.permissionDecision, 'deny', `${name} ${path}`);
      assert.match(answer.permissionDecisionReason, new RegExp(`open a session in \`${mount.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\` to change it`));
    }
  }
  assert.equal(send('NotebookEdit', join(team, 'a.ipynb'), 'notebook_path')?.permissionDecision, 'deny');
  assert.equal(send('Read', join(team, 'note.md')), undefined, 'reads stay open');
  assert.equal(send('Grep', join(own, 'x'), 'path'), undefined);
  assert.equal(send('Edit', join(dir, 'oikos.yaml'), 'file_path')?.permissionDecision, 'deny', 'an edit whose effect on mounts cannot be told is not let through');
  assert.equal(hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dir, tool_input: { file_path: join(dir, 'oikos.yaml'), old_string: 'name: ACME Corp', new_string: 'name: ACME Inc' } }).hookSpecificOutput,
    undefined, 'the installation itself is writable');
  assert.equal(send('Edit', join(dir, 'vaults', 'team-notes', 'x.md')), undefined, 'a sibling that only shares a prefix is not the mount');
  assert.equal(send('Write', join(dir, '.local', 'catalog.yaml')), undefined);
  assert.equal(send('Edit', join(CORE, 'OIKOS.md'))?.permissionDecision, 'deny', 'the core guard is unchanged');
});

test('the package guard decides within two seconds with the mounts read per call', () => {
  const { dir, team } = mounted();
  const started = Date.now();
  const answer = hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dir, tool_input: { file_path: join(team, 'x.md') } });
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

test('session-start names each mount: what is used, the wiki name, and where it is changed', () => {
  const { dir, own } = mounted();
  const context = hook(dir, 'session-start', { hook_event_name: 'SessionStart' }).hookSpecificOutput.additionalContext;
  const lines = context.split('\n').filter((l) => l.startsWith('- ') && /changed only in a session opened there/.test(l));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^- vaults\/team \(shared\): wiki 'team'; changed only in a session opened there \(notes of a wiki go through the `vault` connector\)/);
  assert.match(lines[1], /^- projects\/dev-root \(shared\): skills; changed only in a session opened there, never from this one$/);
  assert.match(lines[2], new RegExp(`^- ${own.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\(local\\): wiki 'own'`));
  const plain = hook(installation((t) => t), 'session-start', { hook_event_name: 'SessionStart' });
  assert.doesNotMatch(plain.hookSpecificOutput?.additionalContext ?? '', /Mounts —/, 'no mounts, no lines');
});

test('a mount whose .git is a file (a submodule) gets its exclude line in the repository it points to', () => {
  const { dir } = mounted();
  const gitdir = join(tempDir('gitdir-'), 'sub.git');
  const sub = join(dir, 'vaults', 'sub');
  mkdirSync(sub, { recursive: true });
  const init = spawnSync('git', ['init', '-q', '--separate-git-dir', gitdir, sub], { encoding: 'utf8', env: cleanEnv(ENV) });
  assert.equal(init.status, 0, init.stderr);
  assert.ok(readFileSync(join(sub, '.git'), 'utf8').startsWith('gitdir: '), 'the mount\'s .git is a file');
  const yaml = join(dir, 'oikos.yaml');
  write(yaml, readFileSync(yaml, 'utf8').replace('mounts:\n', 'mounts:\n  vaults/sub: ~\n'));
  const run = sync(dir);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const exclude = join(realpathSync(gitdir), 'info', 'exclude');
  assert.match(readFileSync(exclude, 'utf8'), /^\/\.claude\/settings\.local\.json$/m);
  assert.equal(status(sub), '', 'the mount shows nothing new to commit');
  assert.equal(sync(dir, '--check').status, 0);

  write(yaml, readFileSync(yaml, 'utf8').replace('  vaults/sub: ~\n', ''));
  assert.equal(sync(dir).status, 0);
  assert.doesNotMatch(readFileSync(exclude, 'utf8'), /settings\.local\.json/, 'the line goes with the mount');
  assert.ok(!existsSync(join(sub, '.claude', 'settings.local.json')));
});
