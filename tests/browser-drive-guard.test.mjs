// Who may drive the shared browser (npm test): a delegated agent and an autonomous run are denied the
// oikos browser CLI, akmon's own tool and the akmon-browser MCP server; the developer's own session
// passes; an attached browser is never closed by an agent. The decision is akmon's, imported from the
// submodule (tools/hooks/browser-drive-guard.mjs); oikos adds its CLI's spelling, so the command lists
// below are akmon's conformance cases (meta/conformance/scenarios/hooks/browser-guard-*.toml) written
// with the oikos CLI. Temporary installations (ACME Corp), no network, no Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { installation, tool } from './helpers/installation.mjs';
import { hook } from './helpers/mounts.mjs';
import { driveDecision, loadAkmon, run, runsBrowserScript, withOikosScript } from '../tools/hooks/browser-drive-guard.mjs';
import { WIRING, guardsIn, hooksFor } from '../tools/hooks/wiring.mjs';

const CORE = realpathSync(CORE_ROOT);
const akmon = await loadAkmon(CORE);
/** The tests that read akmon's guard skip when the submodule (or its browser tool) is not checked out. */
const NEEDS_AKMON = { skip: akmon ? false : 'the akmon submodule is not checked out with its browser tool' };

const DRIVES = [
  'node oikos/tools/browser/cli.mjs status',
  'node ./oikos/tools/browser/cli.mjs start --url https://compliance.acme.example',
  `node ${CORE}/tools/browser/cli.mjs status`,
  'node "$CLAUDE_PROJECT_DIR/oikos/tools/browser/cli.mjs" status',
  'node oikos/tools/./browser/cli.mjs status',
  'node tools/browser/cli.mjs status',
  'cd oikos && node tools/browser/cli.mjs status',
  'cd oikos/tools/browser && node cli.mjs status',
  'FOO=1 node oikos/tools/browser/cli.mjs status',
  'env OIKOS_CHROME_PORT=9333 node oikos/tools/browser/cli.mjs start',
  '/usr/bin/env node oikos/tools/browser/cli.mjs status',
  'timeout 30 node oikos/tools/browser/cli.mjs status',
  'nice -n 5 node oikos/tools/browser/cli.mjs status',
  'node --no-warnings oikos/tools/browser/cli.mjs status',
  '/usr/bin/node oikos/tools/browser/cli.mjs status',
  'true; node oikos/tools/browser/cli.mjs status | cat',
  'bash -c \'node oikos/tools/browser/cli.mjs status\'',
  'echo $(node oikos/tools/browser/cli.mjs status)',
  'akmon tool browser status',
  'node _aitna/akmon/js/tools/browser.mjs status',
  'npm run browser -- status',
  'npm --prefix oikos run browser status',
  'npm run-script browser',
  'pnpm browser status',
  'yarn run browser status',
  'bash -c \'npm run browser -- status\'',
  'node --run browser -- status',
  'node --no-warnings --run=browser status',
  'node oikos/tools/browser/mcp.mjs',
  'node _aitna/akmon/js/tools/browser/mcp.mjs',
  'cat notes.txt <<EOF\nplain\nEOF\nnpm run browser -- status',
];

const TEXT = [
  'ls -la',
  'npm test',
  'npm run lint',
  'npm install browser-sync',
  'echo "node oikos/tools/browser/cli.mjs status"',
  'echo \'node oikos/tools/browser/cli.mjs status\' > note.txt',
  'echo node oikos/tools/browser/cli.mjs status',
  'grep -r \'tools/browser/cli.mjs\' docs',
  'cat <<\'EOF\'\nnode oikos/tools/browser/cli.mjs status\nEOF',
  'cat tools/browser/cli.mjs',
  'git diff tools/browser/cli.mjs',
  'git commit -m \'browser: node oikos/tools/browser/cli.mjs\'',
  'node --test tests/browser.test.mjs',
  'node oikos/tools/sync/cli.mjs --check',
  'node oikos/tools/setup/cli.mjs status',
  'npx --no-install oxlint tools/browser/cli.mjs',
  'bash -c \'echo npm run browser\'',
  'cat <<EOF\nnpm run browser\nEOF',
  'cat <<EOF\nnode --run browser\nnode oikos/tools/browser/mcp.mjs\nEOF',
  'node --run test',
  'node --run lint -- tools/browser',
];

const call = (command, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const mcp = (name, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: `mcp__akmon-browser__${name}`, tool_input: {}, ...extra });
const where = { root: null, env: {} };

test('akmon\'s hook modules load from the submodule, and the oikos script is added without loading the rest', NEEDS_AKMON, () => {
  assert.ok(akmon, 'the akmon submodule is checked out (git submodule update --init --recursive)');
  const data = withOikosScript(akmon.lazyHookData());
  assert.ok(data.core.browser.scripts.includes('tools/browser/cli.mjs'));
  assert.ok(data.core.browser.scripts.includes('js/tools/browser.mjs'), 'akmon\'s own script stays');
  assert.ok(!akmon.lazyHookData().core.browser.scripts.includes('tools/browser/cli.mjs'), 'akmon\'s data is not changed');
});

test('a delegated agent is denied every spelling of the browser CLI', NEEDS_AKMON, () => {
  for (const command of DRIVES) {
    const answer = driveDecision(call(command, { agent_id: 'agent-1', permission_mode: 'default' }), akmon, where);
    assert.equal(answer?.decision, 'deny', command);
    assert.match(answer.reason, /delegated agent does not drive it/, command);
    assert.match(answer.reason, /hand it back to the main session/, command);
  }
});

test('an autonomous run is denied, delegated or not', NEEDS_AKMON, () => {
  for (const command of DRIVES) {
    for (const agentId of [undefined, 'agent-1']) {
      const answer = driveDecision(call(command, { agent_id: agentId }), akmon, { root: null, env: { AKMON_ACTOR: 'autonomous' } });
      assert.equal(answer?.decision, 'deny', command);
      assert.match(answer.reason, /autonomous run/, command);
    }
  }
});

test('the developer\'s own session drives the browser: nothing is said', NEEDS_AKMON, () => {
  for (const command of DRIVES) assert.equal(driveDecision(call(command), akmon, where), null, command);
  assert.equal(driveDecision(mcp('take_snapshot'), akmon, where), null);
});

test('quoted words, other programs and unrelated commands are silent, for every actor', NEEDS_AKMON, () => {
  for (const command of TEXT) {
    const delegated = driveDecision(call(command, { agent_id: 'agent-1' }), akmon, where);
    assert.equal(delegated, null, command);
    assert.equal(driveDecision(call(command), akmon, { root: null, env: { AKMON_ACTOR: 'autonomous' } }), null, command);
  }
  assert.equal(driveDecision({ hook_event_name: 'PreToolUse', tool_name: 'mcp__other-server__click', tool_input: {}, agent_id: 'a' }, akmon, where), null);
});

test('the browser npm script is read by its words, also inside a shell string', () => {
  for (const command of DRIVES.filter((c) => /\b(npm|pnpm|yarn)\b|--run/.test(c) && !/mcp\.mjs/.test(c))) assert.ok(runsBrowserScript(command), command);
  for (const command of TEXT) assert.ok(!runsBrowserScript(command), command);
});

test('a delegated agent and an autonomous run are denied the MCP tools of the browser server, reads included', NEEDS_AKMON, () => {
  for (const name of ['take_snapshot', 'list_pages', 'navigate_page', 'click', 'fill']) {
    const delegated = driveDecision(mcp(name, { agent_id: 'agent-1' }), akmon, where);
    assert.equal(delegated?.decision, 'deny', name);
    assert.match(delegated.reason, /delegated agent/);
    const autonomous = driveDecision(mcp(name), akmon, { root: null, env: { AKMON_ACTOR: 'autonomous' } });
    assert.equal(autonomous?.decision, 'deny', name);
  }
});

test('the guard answers through the dispatcher: delegated and autonomous are denied, the developer passes', NEEDS_AKMON, () => {
  const dir = realpathSync(installation((t) => t));
  const run = (payload, env = {}) => hook(dir, 'browser-drive-guard', { cwd: dir, ...payload }, { AKMON_ACTOR: '', ...env }).hookSpecificOutput;

  const delegated = run(call('cd oikos && node tools/browser/cli.mjs status', { agent_id: 'agent-1' }));
  assert.equal(delegated?.permissionDecision, 'deny');
  assert.match(delegated.permissionDecisionReason, /Browser guardrail: .* delegated agent/);
  assert.match(delegated.permissionDecisionReason, /a web fetch of it is denied as well/);

  assert.equal(run(call('node oikos/tools/browser/cli.mjs status'), { AKMON_ACTOR: 'autonomous' })?.permissionDecision, 'deny');
  assert.equal(run(mcp('take_snapshot', { agent_id: 'agent-1' }))?.permissionDecision, 'deny');
  assert.equal(run(mcp('take_snapshot'), { AKMON_ACTOR: 'autonomous' })?.permissionDecision, 'deny');

  assert.equal(run(call('node oikos/tools/browser/cli.mjs status')), undefined, 'the developer\'s own session');
  assert.equal(run(mcp('take_snapshot')), undefined, 'the developer\'s own MCP call');
  assert.equal(run(call('ls -la', { agent_id: 'agent-1' })), undefined, 'an unrelated command');
  assert.equal(run(call('echo "node oikos/tools/browser/cli.mjs status"', { agent_id: 'agent-1' })), undefined, 'quoted text');
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: 'tools/browser/cli.mjs' }, agent_id: 'agent-1' }), undefined, 'a file read');
});

test('the host\'s own shell tool name is read too (Qwen)', NEEDS_AKMON, () => {
  const answer = driveDecision({ hook_event_name: 'PreToolUse', tool_name: 'run_shell_command', tool_input: { command: 'node oikos/tools/browser/cli.mjs status' }, agent_id: 'a' }, akmon, where);
  assert.equal(answer?.decision, 'deny');
});

test('an attached browser is the user\'s Chrome: no actor closes its window or page', NEEDS_AKMON, () => {
  const dir = realpathSync(installation((t) => t));
  const run = (payload, env = {}) => hook(dir, 'browser-drive-guard', { cwd: dir, ...payload }, { AKMON_ACTOR: '', ...env }).hookSpecificOutput;
  assert.equal(run(mcp('close_page')), undefined, 'detached: the developer closes a page');

  mkdirSync(join(dir, '.local', '.browser'), { recursive: true });
  writeFileSync(join(dir, '.local', '.browser', 'attach.json'), '{}');
  for (const name of ['close_page', 'close_window']) {
    const answer = run(mcp(name));
    assert.equal(answer?.permissionDecision, 'deny', name);
    assert.match(answer.permissionDecisionReason, /attach mode.*never closes its window or its page/, name);
  }
  assert.equal(run(mcp('take_snapshot')), undefined, 'attached: the developer still reads');
  assert.equal(run(mcp('close_page', { agent_id: 'agent-1' }))?.permissionDecision, 'deny');
});

test('the heredoc body is text, a command after it is not; node --run reads like npm run', () => {
  assert.equal(runsBrowserScript('cat <<EOF\nnpm run browser\nEOF'), false);
  assert.equal(runsBrowserScript('cat <<EOF\nnpm run browser\nEOF\nnpm run browser'), true);
  assert.equal(runsBrowserScript('node --run browser'), true);
  assert.equal(runsBrowserScript('node --run test'), false);
  assert.equal(runsBrowserScript('node --test tests/browser.test.mjs'), false);
});

test('a script named from the directory the call starts in is the tool', NEEDS_AKMON, () => {
  const delegated = { agent_id: 'agent-1', cwd: join(CORE, 'tools', 'browser') };
  assert.equal(driveDecision(call('node cli.mjs status', delegated), akmon, where)?.decision, 'deny');
  assert.equal(driveDecision(call('node mcp.mjs', delegated), akmon, where)?.decision, 'deny');
  assert.equal(driveDecision(call('node cli.mjs status', { cwd: delegated.cwd }), akmon, where), null, 'the developer\'s own session');

  // through the hook: the command has no "browser" in it, so only the call's directory makes it a candidate
  const dir = realpathSync(installation((t) => t));
  const folder = join(dir, 'oikos', 'tools', 'browser');
  mkdirSync(folder, { recursive: true });
  const run = (payload) => hook(dir, 'browser-drive-guard', payload, { AKMON_ACTOR: '' }).hookSpecificOutput;
  assert.equal(run(call('node cli.mjs status', { agent_id: 'agent-1', cwd: folder }))?.permissionDecision, 'deny');
  assert.equal(run(call('node cli.mjs status', { cwd: folder })), undefined, 'the developer\'s own session');
  assert.equal(run(call('ls', { agent_id: 'agent-1', cwd: folder })), undefined, 'an unrelated command');
});

test('a delegated agent is denied the MCP launchers, the developer is not', NEEDS_AKMON, () => {
  for (const command of ['node oikos/tools/browser/mcp.mjs', 'node oikos/_aitna/akmon/js/tools/browser/mcp.mjs', 'cd oikos/tools/browser && node mcp.mjs']) {
    assert.equal(driveDecision(call(command, { agent_id: 'agent-1' }), akmon, where)?.decision, 'deny', command);
    assert.equal(driveDecision(call(command), akmon, where), null, command);
  }
});

/** A core folder holding the files `files` name (relative to it, with their source): a stand-in for an older akmon pin. */
function fakeCore(files) {
  const core = mkdtempSync(join(tmpdir(), 'oikos-fake-core-'));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(core, name, '..'), { recursive: true });
    writeFileSync(join(core, name), source);
  }
  return core;
}

const AKMON_JS = '_aitna/akmon/js';
/** Akmon's files as an older pin has them: every module there, but hook_core.mjs has no browser guard. */
const OLDER_PIN = {
  [`${AKMON_JS}/tools/browser.mjs`]: '',
  [`${AKMON_JS}/hooks/hook_core.mjs`]: 'export const something = 1;\n',
  [`${AKMON_JS}/hooks/hook_data.mjs`]: 'export const lazyHookData = () => ({});\n',
  [`${AKMON_JS}/hooks/claude_adapter.mjs`]: 'export const actorFromEnvironment = () => "developer";\nexport const attendedFromEnvironment = () => null;\n',
  [`${AKMON_JS}/common/access_matrix.mjs`]: 'export const ACTORS = {};\n',
};

test('an older akmon pin leaves the guard silent: no browser guard, no access matrix, no tool file', async () => {
  assert.equal(await loadAkmon(fakeCore(OLDER_PIN)), null, 'hook_core.mjs without browserGuardResult');
  const without = (name) => Object.fromEntries(Object.entries(OLDER_PIN).filter(([file]) => !file.endsWith(name)));
  assert.equal(await loadAkmon(fakeCore(without('common/access_matrix.mjs'))), null, 'no access matrix');
  assert.equal(await loadAkmon(fakeCore(without('tools/browser.mjs'))), null, 'no browser tool');
  const core = `${AKMON_JS}/hooks/hook_core.mjs`;
  const importsGone = { ...OLDER_PIN, [core]: 'import "../common/missing.mjs";\nexport const x = 1;\n' };
  assert.equal(await loadAkmon(fakeCore(importsGone)), null, 'a module hook_core.mjs imports is gone');
  const importsName = { ...OLDER_PIN, [core]: 'import { Gone } from "../common/access_matrix.mjs";\nexport const x = Gone;\n' };
  assert.equal(await loadAkmon(fakeCore(importsName)), null, 'a name hook_core.mjs imports is gone');
  assert.equal(await loadAkmon(fakeCore({})), null, 'no submodule');
});

test('a module that is there and breaks is a failure, not silence', async () => {
  const broken = { ...OLDER_PIN, [`${AKMON_JS}/hooks/hook_data.mjs`]: 'throw new Error("boom");\n' };
  await assert.rejects(loadAkmon(fakeCore(broken)), /boom/);
});

test('run says nothing on an older akmon pin, for the call it would deny', async () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    await run(call('node oikos/tools/browser/cli.mjs status', { agent_id: 'agent-1' }), fakeCore(OLDER_PIN));
  } finally {
    process.stdout.write = original;
  }
  assert.deepEqual(written, []);
});

test('the wiring: both hosts match the shell and the server, the guard has a file, and sync writes it', () => {
  assert.ok(WIRING.some((w) => w.guard === 'browser-drive-guard' && w.event === 'PreToolUse'));
  const claude = hooksFor('claude', 'oikos/').PreToolUse.find((g) => g.hooks.some((h) => h.command.endsWith('browser-drive-guard')));
  assert.equal(claude.matcher, 'Bash|mcp__akmon-browser__.*');
  assert.match(claude.hooks[0].command, /\$CLAUDE_PROJECT_DIR\/oikos\/tools\/hooks\/host-hook\.mjs" browser-drive-guard$/);
  const qwen = hooksFor('qwen', 'oikos/').PreToolUse.find((g) => g.hooks.some((h) => h.command.endsWith('browser-drive-guard')));
  assert.equal(qwen.matcher, '^(run_shell_command|mcp__akmon-browser__.*)$');
  // Claude's matcher is an unanchored alternation, Qwen's is anchored (wiring.mjs); both are regular expressions
  const claudeMatcher = new RegExp(`^(?:${claude.matcher})$`);
  const qwenMatcher = new RegExp(qwen.matcher);
  for (const name of ['Bash', 'mcp__akmon-browser__click']) assert.ok(claudeMatcher.test(name), `claude: ${name}`);
  for (const name of ['run_shell_command', 'mcp__akmon-browser__click']) assert.ok(qwenMatcher.test(name), `qwen: ${name}`);
  for (const matcher of [claudeMatcher, qwenMatcher]) assert.ok(!matcher.test('WebFetch') && !matcher.test('mcp__other__click'));

  const dir = realpathSync(installation((t) => t));
  // settings an earlier sync wrote, before this guard existed: sync adds it, and --check agrees
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const older = hooksFor('claude', 'oikos/');
  older.PreToolUse = older.PreToolUse.filter((g) => !g.hooks.some((h) => h.command.endsWith('browser-drive-guard')));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: older }));
  assert.equal(tool(dir, 'sync', ['--check']).status, 1, 'the missing guard is drift');
  const sync = tool(dir, 'sync', []);
  assert.equal(sync.status, 0, sync.output);
  assert.equal(tool(dir, 'sync', ['--check']).status, 0);
  for (const file of ['.claude', '.qwen']) {
    const settings = JSON.parse(readFileSync(join(dir, file, 'settings.json'), 'utf8'));
    assert.ok(Object.values(guardsIn(settings.hooks)).flat().includes('browser-drive-guard'), file);
  }
});
