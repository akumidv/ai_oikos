// Mounts, the declaration (ADR 0007): the files that declare the mounts are closed to file tools
// (D-A9-SELF-UNLOCK), the package guard keeps a recorded mount closed and does not throw open on an
// unreadable configuration, a local entry only narrows a shared one (D-A9-LOCAL-NARROW), `skills.tracked`
// lets a personal pointer be committed (D-A9-PERSONAL-POINTERS), and `setup mount add|remove` changes
// either layer without touching the rest of the file. Each test makes a temporary installation (ACME
// Corp) as tests/helpers/mounts.mjs does. Nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tool } from './helpers/installation.mjs';
import { ENV, configOf, hook, mounted, readJson, repository, skill, sync, write } from './helpers/mounts.mjs';

/** The answer of the package guard to a file tool's call, or undefined when it lets it through. */
const guard = (dir, toolName, input) => hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: toolName, cwd: dir, tool_input: input }).hookSpecificOutput;
const isDenied = (answer) => answer?.permissionDecision === 'deny';
const setup = (dir, ...args) => tool(dir, 'setup', ['mount', ...args], ENV);
const text = (path) => readFileSync(path, 'utf8');

test('the package guard keeps file tools from changing .local/mounts.yaml at all', () => {
  const { dir } = mounted();
  const local = join(dir, '.local', 'mounts.yaml');
  for (const [name, input] of [
    ['Edit', { file_path: local, old_string: 'default: true', new_string: 'default: false' }],
    ['Write', { file_path: local, content: text(local) }],
    ['MultiEdit', { file_path: local, edits: [{ old_string: 'use: [wiki]', new_string: 'use: [wiki]' }] }],
    ['NotebookEdit', { notebook_path: local }],
    ['Write', { file_path: '.local/mounts.yaml', content: '' }],
  ]) {
    const answer = guard(dir, name, input);
    assert.ok(isDenied(answer), `${name} ${JSON.stringify(input).slice(0, 60)}`);
    assert.match(answer.permissionDecisionReason, /Change mounts with `node oikos\/tools\/setup\/cli\.mjs mount add\|remove … --dry-run`/);
  }
  assert.equal(guard(dir, 'Write', { file_path: join(dir, '.local', 'catalog.yaml'), content: 'x' }), undefined, 'the rest of .local/ is not this guard\'s');
});

test('the package guard keeps file tools from changing .local/outgoing.yaml and .local/sync.json at all (D-A9-GUARD-FILES)', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  write(join(dir, '.local', 'outgoing.yaml'), 'terms: [Globex]\nallow: ["a phrase that is let through"]\n');
  for (const file of ['outgoing.yaml', 'sync.json']) {
    const path = join(dir, '.local', file);
    for (const [name, input] of [
      ['Edit', { file_path: path, old_string: text(path).slice(0, 5), new_string: 'x' }],
      ['Write', { file_path: path, content: text(path) }],
      ['MultiEdit', { file_path: path, edits: [{ old_string: text(path).slice(0, 5), new_string: 'x' }] }],
      ['NotebookEdit', { notebook_path: path }],
      ['Write', { file_path: `.local/${file}`, content: '' }],
    ]) {
      const answer = guard(dir, name, input);
      assert.ok(isDenied(answer), `${file}: ${name}`);
      assert.match(answer.permissionDecisionReason, new RegExp(`\\.local/${file.replace('.', '\\.')} .*not changed by a file tool.*in their own editor`));
    }
  }
  assert.equal(guard(dir, 'Write', { file_path: join(dir, '.local', 'catalog.yaml'), content: 'x' }), undefined, 'the rest of .local/ is not this guard\'s');
});

test('the package guard lets a file tool change only the permissions key of the settings files (D-A9-GUARD-FILES, D-AUDIT5-EXEC-KEYS)', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  for (const file of ['settings.json', 'settings.local.json']) {
    const path = join(dir, '.claude', file);
    const settings = readJson(path);
    // The two files each hold something: the shared one the hooks, the local one the mounts' exclusions; give both every key.
    write(path, `${JSON.stringify({ ...settings, hooks: settings.hooks ?? { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] }, claudeMdExcludes: settings.claudeMdExcludes ?? ['/x/CLAUDE.md'], disableAllHooks: false, model: 'a', env: { DEBUG: '1' }, permissions: { allow: ['Read'] } }, null, 2)}\n`);
    const before = text(path);
    const edit = (old_string, new_string) => ({ file_path: path, old_string, new_string });

    // the permissions key, or the other keys written again: let through
    assert.equal(guard(dir, 'Edit', edit('"Read"', '"Read", "Grep"')), undefined, `${file}: permissions`);
    assert.equal(guard(dir, 'Write', { file_path: path, content: before }), undefined, `${file}: the same content`);
    assert.equal(guard(dir, 'Write', { file_path: path, content: JSON.stringify(JSON.parse(before)) }), undefined, `${file}: the same parsed parts, another layout`);
    assert.equal(guard(dir, 'Edit', edit('no such text', 'x')), undefined, `${file}: an edit that cannot apply`);
    assert.equal(guard(dir, 'MultiEdit', { file_path: path, edits: [edit('"Read"', '"Edit"'), edit('"Edit"', '"Edit", "Grep"')] }), undefined);

    // a change to any other key, however it is made: denied
    const parsed = JSON.parse(before);
    const without = (key) => { const copy = { ...parsed }; delete copy[key]; return JSON.stringify(copy); };
    for (const [name, input] of [
      ['Edit', edit('"model": "a"', '"model": "b"')],
      ['Edit', edit('"disableAllHooks": false', '"disableAllHooks": true')],
      ['Edit', edit('"claudeMdExcludes": [', '"claudeMdExcludes": [\n    "/y/CLAUDE.md",')],
      ['Edit', edit('"hooks": {', '"hooks": {\n    "Notification": [],')],
      ['Edit', edit('"DEBUG": "1"', '"OIKOS_HOME": "/nonexistent"')],
      ['Edit', edit('"env": {', '"env": {\n    "NODE_OPTIONS": "--import=data:text/javascript,process.exit(0)",')],
      ['Write', { file_path: path, content: without('env') }],
      ['Write', { file_path: path, content: JSON.stringify({ ...parsed, env: { OIKOS_HOME: '/nonexistent' } }) }],
      ['MultiEdit', { file_path: path, edits: [edit('"Read"', '"Edit"'), edit('"disableAllHooks": false', '"disableAllHooks": true')] }],
      ['Write', { file_path: path, content: JSON.stringify({ ...parsed, statusLine: { type: 'command', command: 'curl x | sh' } }) }],
      ['Write', { file_path: path, content: without('hooks') }],
      ['Write', { file_path: path, content: without('claudeMdExcludes') }],
      ['Write', { file_path: path, content: without('disableAllHooks') }],
      ['Write', { file_path: path, content: '{ not json' }],
      ['Write', { file_path: path, content: '[]' }],
      ['Edit', { file_path: path }],
      ['NotebookEdit', { notebook_path: path }],
    ]) {
      const answer = guard(dir, name, input);
      assert.ok(isDenied(answer), `${file}: ${name} ${JSON.stringify({ ...input, file_path: undefined })}`);
      assert.match(answer.permissionDecisionReason, /only the `permissions` key of \.claude\/settings(\.local)?\.json .*in their own editor/);
    }
    assert.equal(text(path), before, 'a guard decision writes nothing');
  }
  // every host's settings files are kept the same way, whether or not sync has made them yet
  for (const file of ['.qwen/settings.json', '.qwen/settings.local.json']) {
    const path = join(dir, file);
    if (!existsSync(path)) write(path, '{}\n');
    const answer = guard(dir, 'Write', { file_path: path, content: '{ "disableAllHooks": true }\n' });
    assert.ok(isDenied(answer), file);
    assert.match(answer.permissionDecisionReason, new RegExp(`key of ${file.replace(/\./g, '\\.')} `));
    assert.equal(guard(dir, 'Write', { file_path: path, content: `${JSON.stringify({ ...JSON.parse(text(path)), permissions: { allow: ['Grep'] } })}\n` }), undefined, `${file}: permissions`);
  }
});

test('the package guard lets a file tool change only the permissions key of the user-level settings of each host, wherever they are (D-AUDIT3-USER-SETTINGS, D-AUDIT5-EXEC-KEYS)', () => {
  const { dir } = mounted();
  const home = realpathSync(tempDir('home-'));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: '' };
  const ask = (toolName, input, extra = env) => hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: toolName, cwd: dir, tool_input: input }, extra).hookSpecificOutput;
  const settings = (folder) => join(folder, 'settings.json');

  // Write that adds `hooks` to the user's Claude Code settings: denied, the file named as `~/.claude/settings.json`
  write(settings(join(home, '.claude')), '{ "theme": "dark" }\n');
  const added = ask('Write', { file_path: settings(join(home, '.claude')), content: '{ "theme": "dark", "hooks": {} }\n' });
  assert.ok(isDenied(added));
  assert.match(added.permissionDecisionReason, /key of ~\/\.claude\/settings\.json /);
  assert.ok(isDenied(ask('Write', { file_path: join(home, '.claude', 'settings.local.json'), content: '{ "claudeMdExcludes": ["x"] }\n' })), 'the local file too, new');
  assert.ok(isDenied(ask('Write', { file_path: '~/.claude/settings.json', content: '{ "hooks": {} }\n' })), 'named with ~');

  // Edit that changes disableAllHooks in the user's Qwen Code settings: denied
  write(settings(join(home, '.qwen')), '{ "disableAllHooks": false, "theme": "dark" }\n');
  const qwen = ask('Edit', { file_path: settings(join(home, '.qwen')), old_string: '"disableAllHooks": false', new_string: '"disableAllHooks": true' });
  assert.ok(isDenied(qwen));
  assert.match(qwen.permissionDecisionReason, /key of ~\/\.qwen\/settings\.json /);

  // the `env` key reaches the guards' processes: the user-level files keep it too
  const withEnv = ask('Write', { file_path: settings(join(home, '.claude')), content: '{ "theme": "dark", "env": { "OIKOS_HOME": "/nonexistent" } }\n' });
  assert.ok(isDenied(withEnv), 'env added to the user-level settings');
  assert.match(withEnv.permissionDecisionReason, /key of ~\/\.claude\/settings\.json /);
  assert.ok(isDenied(ask('Edit', { file_path: settings(join(home, '.claude')), old_string: '"theme": "dark"', new_string: '"theme": "dark", "env": {}' })), 'env added by an Edit');

  // the other keys are closed too; the permissions key stays editable, in both files
  assert.ok(isDenied(ask('Edit', { file_path: settings(join(home, '.claude')), old_string: '"theme": "dark"', new_string: '"theme": "light"' })), 'theme');
  assert.equal(ask('Edit', { file_path: settings(join(home, '.qwen')), old_string: '"theme": "dark"', new_string: '"theme": "dark", "permissions": { "allow": ["Read"] }' }), undefined);
  assert.equal(ask('Edit', { file_path: settings(join(home, '.claude')), old_string: '"theme": "dark"', new_string: '"theme": "dark", "permissions": { "allow": ["Read"] }' }), undefined);
  assert.equal(ask('Write', { file_path: join(home, '.claude', 'other.json'), content: '{ "hooks": {} }\n' }), undefined, 'a file that is not a settings file');

  // a symlinked ~/.claude is still the same file
  const real = realpathSync(tempDir('claude-real-'));
  write(settings(real), '{ "theme": "dark" }\n');
  const linked = realpathSync(tempDir('home-'));
  symlinkSync(real, join(linked, '.claude'));
  assert.ok(isDenied(ask('Write', { file_path: settings(join(linked, '.claude')), content: '{ "hooks": {} }\n' }, { HOME: linked, CLAUDE_CONFIG_DIR: '' })), 'through the link, named from the home');
  assert.ok(isDenied(ask('Write', { file_path: settings(real), content: '{ "hooks": {} }\n' }, { HOME: linked, CLAUDE_CONFIG_DIR: '' })), 'named by the real folder');
  assert.equal(ask('Edit', { file_path: settings(join(linked, '.claude')), old_string: '"dark"', new_string: '"dark", "permissions": {}' }, { HOME: linked, CLAUDE_CONFIG_DIR: '' }), undefined, 'permissions, through the link');

  // CLAUDE_CONFIG_DIR is protected too, and the default folder with it
  const config = realpathSync(tempDir('claude-config-'));
  write(settings(config), '{ "theme": "dark" }\n');
  const withConfig = { HOME: home, CLAUDE_CONFIG_DIR: config };
  const moved = ask('Write', { file_path: settings(config), content: '{ "disableAllHooks": true }\n' }, withConfig);
  assert.ok(isDenied(moved));
  assert.match(moved.permissionDecisionReason, new RegExp(`key of ${config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/settings\\.json `));
  assert.ok(isDenied(ask('Write', { file_path: settings(join(home, '.claude')), content: '{ "hooks": {} }\n' }, withConfig)), 'the default folder');
  assert.equal(ask('Write', { file_path: settings(config), content: '{ "theme": "dark", "permissions": {} }\n' }, withConfig), undefined, 'permissions');
  assert.equal(ask('Write', { file_path: settings(config), content: '{ "hooks": {} }\n' }), undefined, 'a folder the environment does not name is not protected');
});

test('sync, a tool and not a file tool, still writes the settings files the guard protects', () => {
  const { dir, team } = mounted();
  assert.equal(sync(dir).status, 0);
  const local = join(dir, '.claude', 'settings.local.json');
  const shared = join(dir, '.claude', 'settings.json');
  assert.ok(readJson(local).claudeMdExcludes.some((entry) => entry.startsWith(team)), 'the exclusions are written');
  assert.ok(readJson(shared).hooks, 'the hooks are written');
  write(shared, text(shared).replace('"hooks"', '"hooks_x"'));
  const again = sync(dir);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(readJson(shared).hooks, 'sync puts the generated hooks back');
});

test('the package guard lets oikos.yaml be edited except for its mounts: part', () => {
  const { dir } = mounted();
  const yaml = join(dir, 'oikos.yaml');
  const before = text(yaml);
  const organization = { old_string: 'name: ACME Corp', new_string: 'name: ACME Inc' };
  const mountChange = { old_string: 'rules: NOTES.md', new_string: 'rules: RULES.md' };
  assert.equal(guard(dir, 'Edit', { file_path: yaml, ...organization }), undefined, 'another part');
  assert.equal(guard(dir, 'Edit', { file_path: yaml, old_string: 'mounts:\n', new_string: 'mounts:   # the sources\n' }), undefined, 'a comment is not a change of the value');
  assert.equal(guard(dir, 'Edit', { file_path: yaml, old_string: 'no such text', new_string: 'x' }), undefined, 'an edit that cannot apply changes nothing');
  assert.equal(guard(dir, 'Write', { file_path: yaml, content: before.replace('ACME Corp', 'ACME Inc') }), undefined);
  assert.equal(guard(dir, 'MultiEdit', { file_path: yaml, edits: [organization, { old_string: 'warm_days: 30', new_string: 'warm_days: 31' }] }), undefined);

  for (const [name, input] of [
    ['Edit', { file_path: yaml, ...mountChange }],
    ['Edit', { file_path: 'oikos.yaml', ...mountChange }],
    ['Edit', { file_path: yaml, old_string: 'use: [skills]', new_string: 'use: [skills, wiki]' }],
    ['Write', { file_path: yaml, content: before.replace(/\nmounts:[\s\S]*$/, '\n') }],
    ['Write', { file_path: yaml, content: `${before}  vaults/extra: ~\n` }],
    ['Write', { file_path: yaml, content: 'mounts: [unclosed' }],
    ['MultiEdit', { file_path: yaml, edits: [organization, mountChange] }],
    ['Edit', { file_path: yaml }],
  ]) {
    const answer = guard(dir, name, input);
    assert.ok(isDenied(answer), `${name} ${JSON.stringify(input).slice(0, 70)}`);
    assert.match(answer.permissionDecisionReason, /`mounts:` part.*mount add\|remove … --dry-run/);
  }
});

test('the package guard keeps a mount closed until sync --prune forgets it, and when the configuration cannot be read', () => {
  const { dir, team, own } = mounted();
  assert.equal(sync(dir).status, 0);
  const note = (root) => guard(dir, 'Write', { file_path: join(root, 'note.md'), content: 'x' });
  const oikosYaml = join(dir, 'oikos.yaml');
  const declared = text(oikosYaml);
  const localYaml = join(dir, '.local', 'mounts.yaml');
  const declaredLocal = text(localYaml);

  // the entries are gone from both files, the record is not: the mounts stay closed
  write(oikosYaml, declared.replace(/\nmounts:[\s\S]*$/, '\n'));
  write(localYaml, 'mounts:\n');
  assert.deepEqual(configOf(dir).mounts, []);
  assert.ok(isDenied(note(team)), 'removed from the configuration, still recorded');
  assert.ok(isDenied(note(own)));
  assert.match(note(team).permissionDecisionReason, /inside the mount/);
  assert.equal(sync(dir).status, 0);
  assert.ok(isDenied(note(team)), 'plain sync keeps the wiring and the record: still closed');
  assert.ok(isDenied(note(own)));
  assert.equal(sync(dir, '--prune').status, 0);
  assert.equal(note(team), undefined, 'sync --prune has removed the record');
  assert.equal(note(own), undefined);

  // both files malformed: no mount is configured, the recorded roots hold
  write(oikosYaml, declared);
  write(localYaml, declaredLocal);
  assert.equal(sync(dir).status, 0);
  write(oikosYaml, 'mounts: [unclosed\n  : :');
  write(localYaml, 'mounts: {unclosed');
  assert.ok(configOf(dir).problems.some((p) => /does not parse/.test(p)));
  assert.ok(isDenied(note(team)), 'oikos.yaml does not parse');
  assert.ok(isDenied(note(own)), '.local/mounts.yaml does not parse');
  assert.equal(guard(dir, 'Write', { file_path: join(dir, 'notes.md'), content: 'x' }), undefined, 'only the mounts are closed');

  // the record does not read: the configuration still guards
  write(oikosYaml, declared);
  write(localYaml, declaredLocal);
  write(join(dir, '.local', 'sync.json'), 'not json');
  assert.ok(isDenied(note(team)));
});

test('a local entry replaces a shared one whole but may only narrow it', () => {
  const { dir, team, dev } = mounted({ shared: '  vaults/open:\n    use: [wiki]\n    wiki: { name: open }\n    mention_assistant: allow\n' });
  repository(join(dir, 'vaults', 'open'));
  write(join(dir, '.local', 'mounts.yaml'), `mounts:
  ${dev}:
    use: [skills, wiki]
    skills: { from: .claude/skills, prefix: dev }
    wiki: { name: devwiki }
    mention_assistant: allow
  ${team}: ~
  vaults/open:
    use: [wiki]
    wiki: { name: open }
    mention_assistant: allow
`);
  const config = configOf(dir);
  assert.deepEqual(config.problems, [
    `.local/mounts.yaml: mounts.${dev}: may not widen the shared mount projects/dev-root — use: 'wiki' is not in the shared entry's use; dropped`,
    `.local/mounts.yaml: mounts.${dev}: may not widen the shared mount projects/dev-root — mention_assistant: allow is not set on the shared entry; dropped`,
  ]);
  const [teamMount, devMount, openMount] = config.mounts;
  assert.deepEqual([devMount.layer, devMount.use, devMount.wiki, devMount.mention_assistant, devMount.skills.prefix], ['local', ['skills'], null, null, 'dev'], 'the widening is dropped, the rest of the local entry stays');
  assert.deepEqual([teamMount.layer, teamMount.use, teamMount.wiki], ['local', [], null], 'narrowing to read only is fine');
  assert.deepEqual([openMount.layer, openMount.use, openMount.mention_assistant], ['local', ['wiki'], 'allow'], 'what the shared entry allows, the local one may keep');
});

test('skills.tracked is for a personal entry of an inside mount only', () => {
  const { dir, own } = mounted();
  write(join(dir, 'oikos.yaml'), text(join(dir, 'oikos.yaml')).replace('prefix: dev,', 'prefix: dev, tracked: true,'));
  skill(own, '.claude/skills', 'outside-skill');
  write(join(dir, '.local', 'mounts.yaml'), `mounts:\n  ${own}:\n    use: [skills]\n    skills: { tracked: true }\n  vaults/team:\n    use: [skills]\n    skills: { tracked: yes }\n`);
  skill(join(dir, 'vaults', 'team'), '.claude/skills', 'note-skill');
  const config = configOf(dir);
  assert.deepEqual(config.problems, [
    'oikos.yaml: mounts.projects/dev-root: skills.tracked: only in .local/mounts.yaml — a shared entry cannot decide what its readers commit',
    `.local/mounts.yaml: mounts.${own}: skills.tracked: a pointer to a mount outside the installation holds an absolute path, so it is never committed`,
    '.local/mounts.yaml: mounts.vaults/team: skills.tracked: must be true or false',
  ]);
  assert.deepEqual(config.mounts.map((m) => m.skills?.tracked), [false, false, false], 'ignored in every case');

  write(join(dir, 'oikos.yaml'), text(join(dir, 'oikos.yaml')).replace(' tracked: true,', ''));
  write(join(dir, '.local', 'mounts.yaml'), 'mounts:\n  projects/dev-root:\n    use: [skills]\n    skills: { prefix: dev, only: [deploy-status], tracked: true }\n');
  const allowed = configOf(dir);
  assert.deepEqual(allowed.problems, [], 'the same key in a personal entry of an inside mount');
  assert.equal(allowed.mounts.find((m) => m.path === 'projects/dev-root').skills.tracked, true);
});

test('the old key skills.commit is an unknown key: reported, and it does not track the pointers', () => {
  const { dir } = mounted();
  write(join(dir, '.local', 'mounts.yaml'), 'mounts:\n  projects/dev-root:\n    use: [skills]\n    skills: { prefix: dev, only: [deploy-status], commit: true }\n');
  const config = configOf(dir);
  assert.deepEqual(config.problems, ['.local/mounts.yaml: mounts.projects/dev-root: skills.commit: unknown key (from, prefix, only, tracked)']);
  assert.equal(config.mounts.find((m) => m.path === 'projects/dev-root').skills.tracked, false);
});

test('sync keeps a personal pointer out of the installation\'s commits unless skills.tracked says to track it', () => {
  const { dir, dev } = mounted();
  repository(dir);
  const pointer = '.claude/skills/dev-deploy-status/SKILL.md';
  const exclude = join(dir, '.git', 'info', 'exclude');
  const excluded = () => (existsSync(exclude) ? text(exclude) : '');
  const entry = (tracked) => `mounts:\n  projects/dev-root:\n    use: [skills]\n    skills: { prefix: dev, only: [deploy-status]${tracked ? ', tracked: true' : ''} }\n`;
  const record = () => readJson(join(dir, '.local', 'sync.json')).mounts[dev];

  write(join(dir, '.local', 'mounts.yaml'), entry(false));
  write(join(dir, 'oikos.yaml'), text(join(dir, 'oikos.yaml')).replace(/\nmounts:[\s\S]*$/, '\n'));
  assert.equal(sync(dir).status, 0);
  assert.ok(excluded().split('\n').includes(`/${pointer}`), 'a personal pointer is excluded');
  assert.deepEqual(record().installIgnored?.includes(`/${pointer}`), true);

  write(join(dir, '.local', 'mounts.yaml'), entry(true));
  const committed = sync(dir);
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  assert.ok(!excluded().includes('dev-deploy-status'), 'the line sync added is taken away');
  assert.equal(record().installIgnored, undefined);
  const body = text(join(dir, pointer));
  assert.match(body, /Source skill: \[\.\.\/\.\.\/\.\.\/projects\/dev-root\/\.claude\/skills\/deploy-status\/SKILL\.md\]/, 'the link is relative');
  assert.ok(!body.includes(dir), 'no absolute path in what may be committed');
  assert.equal(sync(dir, '--check').status, 0);

  write(join(dir, '.local', 'mounts.yaml'), entry(false));
  assert.equal(sync(dir).status, 0);
  assert.ok(excluded().split('\n').includes(`/${pointer}`), 'and back');
});

test('setup mount add --personal changes .local/mounts.yaml: a dry run shows the diff and writes nothing', () => {
  const { dir } = mounted();
  repository(join(dir, 'vaults', 'extra'));
  const local = join(dir, '.local', 'mounts.yaml');
  write(local, `# my notes\n${text(local)}`);
  const before = text(local);

  const dry = setup(dir, 'add', 'vaults/extra', '--use', 'wiki', '--wiki-name', 'extra', '--personal', '--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^\+\+\+ \.local\/mounts\.yaml \(new\)$/m);
  assert.match(dry.stdout, /^\+ {2}vaults\/extra:$/m);
  assert.match(dry.stdout, /dry run: nothing written/);
  assert.equal(text(local), before);

  const done = setup(dir, 'add', 'vaults/extra', '--use', 'wiki', '--wiki-name', 'extra', '--personal');
  assert.equal(done.status, 0, done.output);
  const after = text(local);
  assert.ok(after.startsWith('# my notes\n'), 'the comment stays');
  assert.ok(after.startsWith(before.trimEnd()), 'what was there stays, the entry is added after it');
  const config = configOf(dir);
  assert.deepEqual(config.problems, []);
  const added = config.mounts.find((m) => m.path === 'vaults/extra');
  assert.deepEqual([added.layer, added.use, added.wiki.name], ['local', ['wiki'], 'extra']);
  assert.equal(config.mounts.length, 4);

  const second = setup(dir, 'add', 'vaults/extra', '--use', 'wiki', '--personal');
  assert.equal(second.status, 1);
  assert.match(second.output, /mounts\.vaults\/extra is declared already — remove it first/);
});

test('setup mount add creates .local/mounts.yaml, and --tracked-pointers sets skills.tracked', () => {
  const { dir } = mounted();
  const local = join(dir, '.local', 'mounts.yaml');
  rmSync(local);
  const dev3 = repository(join(dir, 'projects', 'dev3'));
  skill(dev3, '.claude/skills', 'lint');
  const run = setup(dir, 'add', 'projects/dev3/', '--personal', '--use', 'skills', '--prefix', 'd3', '--skills-only', 'lint', '--tracked-pointers');
  assert.equal(run.status, 0, run.output);
  assert.ok(text(local).startsWith('mounts:\n'));
  const config = configOf(dir);
  assert.deepEqual(config.problems, []);
  assert.deepEqual(config.mounts.find((m) => m.path === 'projects/dev3').skills, { from: '.claude/skills', prefix: 'd3', only: ['lint'], tracked: true }, 'the trailing / is not kept');
});

test('setup mount add --shared changes the mounts: part of oikos.yaml and writes no absolute path', () => {
  const { dir } = mounted();
  const yaml = join(dir, 'oikos.yaml');
  const dev2 = repository(join(dir, 'projects', 'dev2'));
  skill(dev2, '.claude/skills', 'lint');
  const before = text(yaml);
  const run = setup(dir, 'add', dev2, '--shared', '--use', 'skills', '--prefix', 'd2', '--skills-only', 'lint');
  assert.equal(run.status, 0, run.output);
  const after = text(yaml);
  assert.ok(after.startsWith(before.split('mounts:')[0]), 'everything above the mounts: part is as it was');
  assert.ok(after.includes('  vaults/team:\n    use: [wiki]\n'), 'the entries there stay as written');
  assert.ok(!after.includes(dir), 'an absolute path inside the installation is written relative to it');
  const config = configOf(dir);
  assert.deepEqual(config.problems, []);
  const added = config.mounts.find((m) => m.path === 'projects/dev2');
  assert.deepEqual([added.layer, added.skills.prefix, added.skills.only], ['shared', 'd2', ['lint']]);
});

test('setup mount remove takes one entry out and leaves the rest of the file', () => {
  const { dir, team, own } = mounted();
  const yaml = join(dir, 'oikos.yaml');
  const local = join(dir, '.local', 'mounts.yaml');
  const before = text(yaml);

  const dry = setup(dir, 'remove', 'vaults/team', '--shared', '--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /^- {2}vaults\/team:$/m);
  assert.equal(text(yaml), before, 'a dry run writes nothing');

  const removed = setup(dir, 'remove', team, '--shared');
  assert.equal(removed.status, 0, 'by the absolute path of its root');
  assert.match(removed.stdout, /sync\/cli\.mjs --prune --dry-run` shows what taking it away would change/, 'the wiring stays until sync --prune');
  assert.ok(!text(yaml).includes('vaults/team'));
  assert.ok(text(yaml).includes('  projects/dev-root:\n    use: [skills]\n'), 'the next entry stays whole');
  assert.ok(text(yaml).startsWith(before.split('mounts:')[0]));
  assert.deepEqual(configOf(dir).mounts.map((m) => m.path), ['projects/dev-root', own]);

  assert.equal(setup(dir, 'remove', 'projects/dev-root', '--shared').status, 0);
  assert.equal(setup(dir, 'remove', own, '--personal').status, 0);
  assert.equal(text(local).trim(), 'mounts:');
  const config = configOf(dir);
  assert.deepEqual([config.mounts, config.problems], [[], []]);
});

test('setup mount refuses what would be wrong, and writes nothing', () => {
  const { dir, dev } = mounted();
  repository(join(dir, 'vaults', 'extra'));
  const yaml = join(dir, 'oikos.yaml');
  const local = join(dir, '.local', 'mounts.yaml');
  const files = () => [text(yaml), text(local)];
  const before = files();
  const outside = repository(tempDir('outside-'));
  for (const [args, expected] of [
    [['add', 'vaults/nowhere', '--shared', '--use', 'wiki'], /nothing written.*mounts\.vaults\/nowhere: .*does not exist/s],
    [['add', outside, '--shared', '--use', 'wiki'], /a shared mount path is relative to the installation/],
    [['add', 'vaults/extra', '--shared', '--use', 'skills', '--tracked-pointers'], /skills\.tracked: only in \.local\/mounts\.yaml/],
    [['add', dev, '--personal', '--use', 'skills,wiki'], /may not widen the shared mount projects\/dev-root/],
    [['add', 'vaults/team', '--shared', '--use', 'wiki'], /mounts\.vaults\/team is declared already/],
    [['add', 'vaults/extra', '--personal', '--wiki-name', 'x'], /--wiki-name belongs to a mount used as a wiki/],
    [['add', 'vaults/extra', '--personal', '--prefix', 'x'], /belong to a mount used for skills/],
    [['add', 'vaults/extra', '--personal', '--use', 'rules'], /one of wiki, skills/],
    [['add', 'vaults/extra', '--use', 'wiki'], /name the layer/],
    [['add', 'vaults/extra', '--use', 'wiki', '--personal', '--shared'], /name the layer/],
    [['remove', 'vaults/ghost', '--personal'], /mounts\.vaults\/ghost is not declared there/],
    [['remove', 'vaults/team', '--personal'], /not declared there/],
    [['remove', 'vaults/team', '--shared', '--use', 'wiki'], /takes only the path and the layer/],
    [['add', '--personal'], /usage: mount add\|remove/],
    [['drop', 'vaults/team', '--personal'], /usage: mount add\|remove/],
  ]) {
    const run = setup(dir, ...args);
    assert.equal(run.status, 1, `${args.join(' ')}: ${run.output}`);
    assert.match(run.output, expected, args.join(' '));
    assert.deepEqual(files(), before, `${args.join(' ')} wrote`);
  }
  const dry = setup(dir, 'add', 'vaults/nowhere', '--shared', '--use', 'wiki', '--dry-run');
  assert.equal(dry.status, 1, 'a dry run shows the diff and the refusal');
  assert.match(dry.stdout, /^\+ {2}vaults\/nowhere:$/m);
  assert.match(dry.stderr, /nothing written/);
});
