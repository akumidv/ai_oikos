// Isolation of installations (npm test). Each test copies examples/installation (ACME Corp) into a
// temporary folder, links `oikos/` to this core as a real installation does, and runs the tools the
// way an agent host would: as `node oikos/tools/<tool>/cli.mjs` from the installation, or as the
// hook dispatcher with the host's payload. Nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CORE_ROOT, locateInstallation } from '../tools/common/paths.mjs';

const CORE = realpathSync(CORE_ROOT);
const FIXTURE = join(CORE, 'examples', 'installation');
const made = [];

/** A fresh installation from the fixture: `oikos.yaml` edited by `config`, `oikos/` linked to the core. */
function installation(name = 'acme', config = (text) => text) {
  const base = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(base);
  const dir = join(base, name);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'oikos.yaml'), config(readFileSync(join(dir, 'oikos.yaml'), 'utf8')));
  symlinkSync(relative(dir, CORE), join(dir, 'oikos'), 'dir');
  mkdirSync(join(dir, '.local'));
  return dir;
}

process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** The environment of a session outside any installation, so the caller's own never leaks in. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['OIKOS_HOME', 'CLAUDE_PROJECT_DIR', 'QWEN_PROJECT_DIR', 'INIT_CWD', 'PWD', 'JIRA_BASE_URL', 'GITHUB_ORG', 'OIKOS_CHROME_PORT']) delete env[k];
  return { ...env, ...extra };
}

/** Run `oikos/tools/<tool>/cli.mjs` from `dir`, as an agent does. */
function tool(dir, toolName, args, env = {}) {
  return spawnSync(process.execPath, [join(dir, 'oikos', 'tools', toolName, 'cli.mjs'), ...args],
    { cwd: dir, encoding: 'utf8', env: cleanEnv({ PWD: dir, ...env }) });
}

/** Run a guard through the hook dispatcher of `dir`'s `oikos/`, with the host's payload. */
function hook(dir, guard, payload, env = {}) {
  const r = spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'hooks', 'host-hook.mjs'), guard],
    { cwd: dir, input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: dir, ...env }) });
  return r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : {};
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('the installation is found from where oikos runs, never from the core', () => {
  const dir = installation();
  assert.equal(locateInstallation({ env: {}, cwd: dir }).root, dir);
  assert.equal(locateInstallation({ env: {}, cwd: join(dir, 'resources') }).root, dir);
  assert.equal(locateInstallation({ env: { OIKOS_HOME: dir }, cwd: CORE }).root, dir);
  assert.equal(locateInstallation({ env: { CLAUDE_PROJECT_DIR: dir }, cwd: tmpdir() }).root, dir);
  const core = locateInstallation({ env: { CLAUDE_PROJECT_DIR: CORE }, cwd: CORE });
  assert.equal(core.root, null, 'the core repository is not an installation');
  assert.match(core.problem, /core repository/);
  assert.equal(locateInstallation({ env: { OIKOS_HOME: tmpdir() }, cwd: dir }).root, null, 'a wrong OIKOS_HOME is an error, not a fallback');
});

test('each installation reads its own configuration through the shared core', () => {
  const acme = installation('acme');
  const other = installation('other', (t) => t.replace('task-tracking: [jira]', 'task-tracking: []').replace('ACME Corp', 'Other Corp'));
  const skill = (dir) => JSON.parse(tool(dir, 'landscape', ['skills', 'task-tracking', '--json']).stdout)[0];
  assert.deepEqual(skill(acme).configured, ['jira']);
  assert.deepEqual(skill(other).configured, []);
  assert.equal(skill(acme).file, 'oikos/skills/task-tracking/SKILL.md');
  const resources = JSON.parse(tool(acme, 'landscape', ['resources', '--json']).stdout);
  assert.deepEqual(resources.map((r) => r.resource), ['tracker']);
});

test('landscape shows as used only the connectors the installation lists', () => {
  const used = (dir) => Object.fromEntries([...tool(dir, 'landscape', ['skills']).stdout.matchAll(/^(\S+) — [\s\S]*?used here: (.*)$/gm)].map((m) => [m[1], m[2]]));
  // The fixture lists code-hosting, task-tracking and wiki; messaging and workspace are left out.
  const acme = used(installation('acme'));
  assert.equal(acme['code-hosting'], 'github (default github)');
  assert.equal(acme.messaging, '—', 'a skill left out uses no connector');
  assert.equal(acme.workspace, '—');
  const json = JSON.parse(tool(installation('acme'), 'landscape', ['skills', 'messaging', '--json']).stdout)[0];
  assert.deepEqual(json.configured, []);
  // Nothing listed at all: no skill uses a connector.
  const none = used(installation('none', (t) => t.replace(/^connectors:\n(?:\s+.*\n)+/m, 'connectors:\n')));
  assert.ok(Object.keys(none).length >= 5, JSON.stringify(none));
  for (const [skill, shown] of Object.entries(none)) assert.equal(shown, '—', skill);
});

test('a tool run outside any installation says so', () => {
  const r = spawnSync(process.execPath, [join(CORE, 'tools', 'catalog', 'cli.mjs'), 'summary'], { cwd: CORE, encoding: 'utf8', env: cleanEnv({ PWD: CORE }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no oikos installation here/);
});

test('sync wires the installation into oikos/ and keeps what others wired', () => {
  const dir = installation();
  const foreignHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "_aitna/akmon/hooks/git-commit-guard.py"' }] };
  mkdirSync(join(dir, '.claude', 'skills', 'mine'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: a skill of the person\n---\n');
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'kept', hooks: { PreToolUse: [foreignHook] } }));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { theirs: { type: 'http', url: 'https://other.example.com/mcp' } } }));

  assert.equal(tool(dir, 'sync', []).status, 0);
  assert.equal(tool(dir, 'sync', []).status, 0);
  const check = tool(dir, 'sync', ['--check']);
  assert.equal(check.status, 0, check.stdout + check.stderr);

  const settings = readJson(join(dir, '.claude', 'settings.json'));
  assert.equal(settings.model, 'kept');
  const commands = Object.values(settings.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.includes(foreignHook.hooks[0].command), 'a foreign hook survives');
  assert.ok(commands.some((c) => c === 'node "$CLAUDE_PROJECT_DIR/oikos/tools/hooks/host-hook.mjs" secret-guard'));
  assert.ok(!commands.some((c) => c.includes('"$CLAUDE_PROJECT_DIR/tools/hooks/')), 'no entry points at the core itself');
  assert.ok(existsSync(join(dir, '.claude', 'skills', 'mine', 'SKILL.md')), 'a foreign skill survives');
  assert.match(readFileSync(join(dir, '.claude', 'skills', 'wiki', 'SKILL.md'), 'utf8'), /\.\.\/\.\.\/\.\.\/oikos\/skills\/wiki\/SKILL\.md/);
  assert.ok(existsSync(join(dir, '.claude', 'skills', 'wiki', '..', '..', '..', 'oikos', 'skills', 'wiki', 'SKILL.md')), 'the pointer resolves');
  const qwen = readJson(join(dir, '.qwen', 'settings.json'));
  assert.ok(Object.values(qwen.hooks).flat().some((g) => g.hooks.some((h) => h.command.includes('$QWEN_PROJECT_DIR/oikos/tools/hooks/'))));
  const reads = ['list_pages', 'take_snapshot', 'take_screenshot', 'list_console_messages', 'list_network_requests'].map((t) => `mcp__chrome-devtools__${t}`);
  assert.deepEqual(qwen.permissions.allow, reads, 'a new Qwen settings file pre-allows the read-only DevTools tools, each by name');
  assert.deepEqual(qwen.context.includeDirectories, ['oikos'], 'Qwen may read through the oikos/ link');
  assert.deepEqual(readJson(join(dir, '.claude', 'settings.local.json')).permissions.additionalDirectories, [CORE]);

  let mcp = readJson(join(dir, '.mcp.json')).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ['chrome-devtools', 'knowledge', 'theirs']);
  assert.equal(mcp['chrome-devtools'].env.OIKOS_HOME, dir);
  assert.equal(mcp['chrome-devtools'].args[0], join(CORE, 'tools', 'browser', 'mcp.mjs'));

  // a server the installation drops goes; the foreign one stays
  writeFileSync(join(dir, 'oikos.yaml'), readFileSync(join(dir, 'oikos.yaml'), 'utf8').replace(/mcp_servers:[\s\S]*$/, ''));
  assert.equal(tool(dir, 'sync', []).status, 0);
  mcp = readJson(join(dir, '.mcp.json')).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ['chrome-devtools', 'theirs']);
});

test('sync keeps the keys of an existing Qwen settings file and lets it read oikos/', () => {
  const dir = installation();
  mkdirSync(join(dir, '.qwen'));
  writeFileSync(join(dir, '.qwen', 'settings.json'), JSON.stringify({ $version: 4, permissions: { allow: ['mcp__theirs__read'] }, context: { includeDirectories: ['../shared'], fileName: 'AGENTS.md' } }));
  assert.equal(tool(dir, 'sync', []).status, 0);
  const qwen = readJson(join(dir, '.qwen', 'settings.json'));
  assert.equal(qwen.$version, 4);
  assert.deepEqual(qwen.permissions.allow, ['mcp__theirs__read'], 'the seed is not rewritten into an existing file');
  assert.deepEqual(qwen.context, { includeDirectories: ['../shared', 'oikos'], fileName: 'AGENTS.md' }, 'oikos is added, the rest kept');
  assert.equal(tool(dir, 'sync', []).status, 0);
  assert.deepEqual(readJson(join(dir, '.qwen', 'settings.json')).context.includeDirectories, ['../shared', 'oikos'], 'added once');
  assert.ok(Object.values(qwen.hooks).flat().some((g) => g.hooks.some((h) => h.command.includes('$QWEN_PROJECT_DIR/oikos/tools/hooks/'))));
});

test('oikos/ is read-only in an installation, the installation itself is not', () => {
  const dir = installation();
  const edit = (file_path) => hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dir, tool_input: { file_path } });
  assert.equal(edit(join(dir, 'oikos', 'skills', 'wiki', 'SKILL.md')).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(edit(join(CORE, 'OIKOS.md')).hookSpecificOutput?.permissionDecision, 'deny', 'the core reached by its real path');
  assert.equal(edit('oikos/new-file.md').hookSpecificOutput?.permissionDecision, 'deny', 'a new file inside oikos/');
  assert.deepEqual(edit(join(dir, 'oikos.yaml')), {});
  assert.deepEqual(edit(join(dir, '.local', 'catalog.yaml')), {});
  // the core repository itself is where oikos is developed
  const inCore = spawnSync(process.execPath, [join(CORE, 'tools', 'hooks', 'host-hook.mjs'), 'package-guard'], {
    cwd: CORE, encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: CORE, PWD: CORE }),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: CORE, tool_input: { file_path: join(CORE, 'OIKOS.md') } }),
  });
  assert.equal(inCore.stdout.trim(), '');
});

test('two installations never share a browser', async () => {
  const { defaultPort, ownerOf } = await import('../tools/browser/cli.mjs');
  const a = installation('a');
  const b = installation('b');
  assert.notEqual(defaultPort(a), defaultPort(b));
  assert.equal(defaultPort(a), defaultPort(a));
  if (process.platform !== 'linux') return; // the process table is read from /proc below

  // A stand-in for the Chrome of installation a: a process with Chrome's flags on its command line.
  const port = 19000 + (process.pid % 900);
  const profileA = join(a, '.local', 'browser', 'chrome-profile');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${profileA}`], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ownerOf(port, profileA).owner, 'ours');
    const foreign = ownerOf(port, join(b, '.local', 'browser', 'chrome-profile'));
    assert.equal(foreign.owner, 'foreign');
    assert.equal(foreign.profile, profileA);
    assert.equal(ownerOf(port + 1, profileA).owner, 'unknown');
  } finally {
    child.kill();
  }
});

/** A git configuration whose only user email is `email`, for `setup init` to default JIRA_EMAIL from. */
function gitEmail(base, email) {
  const file = join(base, 'gitconfig');
  writeFileSync(file, `[user]\n\temail = ${email}\n`);
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

/** `setup init <base>/fresh` with `args`, run from `base` with the git email `email`. */
function init(base, args, email) {
  const dir = join(base, 'fresh');
  const r = spawnSync(process.execPath, [join(CORE, 'tools', 'setup', 'cli.mjs'), 'init', dir, ...args],
    { cwd: base, encoding: 'utf8', env: cleanEnv({ PWD: base, ...gitEmail(base, email) }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return dir;
}

test('setup init makes an installation and refuses the core', () => {
  const base = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(base);
  const dir = init(base, ['--org', 'ACME Corp', '--email-domain', 'acme.example'], 'ada@acme.example');
  assert.match(readFileSync(join(dir, '.local', '.env'), 'utf8'), /^JIRA_EMAIL=ada@acme\.example$/m, 'the git email, inside the domain');
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'oikos.yaml', 'LANDSCAPE.md', '.gitignore', 'resources', '.local/AGENTS.md', '.local/.env', '.mcp.json', '.claude/settings.json']) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  assert.equal(realpathSync(join(dir, 'oikos')), CORE);
  assert.match(readFileSync(join(dir, 'oikos.yaml'), 'utf8'), /OIKOS_CHROME_PORT: \d+/);
  assert.equal(tool(dir, 'sync', ['--check']).status, 0);

  const again = spawnSync(process.execPath, [join(CORE, 'tools', 'setup', 'cli.mjs'), 'init', dir], { encoding: 'utf8', env: cleanEnv() });
  assert.match(again.stdout, /kept {4}oikos\.yaml/);
  const core = spawnSync(process.execPath, [join(CORE, 'tools', 'setup', 'cli.mjs'), 'init', join(CORE, 'x')], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(core.status, 1);
  assert.ok(!existsSync(join(CORE, 'x')));
});

test('setup init without an email domain writes no git email into the installation', () => {
  const base = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(base);
  const dir = init(base, ['--org', 'ACME Corp'], 'ada@other.example');
  assert.doesNotMatch(readFileSync(join(dir, '.local', '.env'), 'utf8'), /JIRA_EMAIL/, "another organization's address stays out");
});

test('the leak check finds a private term staged in a repository', async () => {
  const { findLeaks } = await import('../tools/hooks/leaks.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'oikos-test-'));
  made.push(repo);
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, 'notes.md'), 'Neutral text.\nThe Initech board lives here.\n');
  writeFileSync(join(repo, 'unstaged.md'), 'Initech, but never staged.\n');
  git('add', 'notes.md');
  assert.equal(findLeaks(repo, null), null, 'no terms, nothing checked');
  assert.deepEqual(findLeaks(repo, ['initech']), [{ file: 'notes.md', line: 2, term: 'initech' }]);
  assert.deepEqual(findLeaks(repo, ['globex']), []);
});
