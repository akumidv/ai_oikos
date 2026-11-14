// The one route to a page (npm test): the akmon-browser MCP server is the only way to read a
// resource the browser skill reaches — a web fetch of such a host answers with the login page, and
// "the page was empty" is a wrong answer. The guard (tools/hooks/browser-guard.mjs) denies that
// fetch and names the skill and the repair; the skill says so too. Temporary installations (ACME
// Corp), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { installation } from './helpers/installation.mjs';
import { hook } from './helpers/mounts.mjs';
import { browserRoutes, fetchReason, hostMatches, routeFor, urlHost } from '../tools/hooks/browser-guard.mjs';

const CORE = realpathSync(CORE_ROOT);

/** A resource note in the installation `dir`, with the frontmatter given. */
function note(dir, name, frontmatter) {
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'resources', `${name}.md`), `---\n${frontmatter}\n---\n\n# ${name}\n`);
}

/** The reason the browser guard denies a fetch of `url` in the installation `dir`, else null. */
function denied(dir, url, tool = 'web_fetch') {
  const answer = hook(dir, 'browser-guard', { hook_event_name: 'PreToolUse', tool_name: tool, cwd: dir, tool_input: { url, prompt: 'what does the page show' } }).hookSpecificOutput;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}

/** An installation with one resource note the browser skill reaches. */
function withBrowserResource() {
  const dir = realpathSync(installation((t) => t));
  note(dir, 'compliance', [
    'id: business-resources-compliance',
    'title: "Compliance portal — ACME Corp"',
    'domain: business',
    'status: draft',
    'resource: compliance',
    'kind: service',
    'network: internal',
    'url: https://compliance.acme.example',
    'auth: sso',
    'via: [browser]',
  ].join('\n'));
  return dir;
}

test('the host of a URL, and whether it is the host or a subdomain of it', () => {
  assert.equal(urlHost('https://Compliance.ACME.example/path'), 'compliance.acme.example');
  assert.equal(urlHost('https://compliance.acme.example:8443/x'), 'compliance.acme.example');
  assert.equal(urlHost('compliance.acme.example'), 'compliance.acme.example');
  assert.equal(urlHost(''), null);
  assert.equal(urlHost('not a url'), null);
  assert.ok(hostMatches('compliance.acme.example', 'compliance.acme.example'));
  assert.ok(hostMatches('portal.compliance.acme.example', 'compliance.acme.example'));
  assert.ok(hostMatches('COMPLIANCE.acme.example', 'compliance.acme.example'), 'the case does not matter');
  assert.ok(!hostMatches('notcompliance.acme.example', 'compliance.acme.example'), 'a look-alike host is not the host');
  assert.ok(!hostMatches('acme.example', 'compliance.acme.example'), 'the parent is not the host');
  assert.ok(!hostMatches('', 'compliance.acme.example'));
});

test('the routes are the resource notes the browser skill reaches', () => {
  const dir = withBrowserResource();
  const routes = browserRoutes(dir);
  assert.deepEqual(routes.map((r) => r.host), ['compliance.acme.example']);
  assert.deepEqual(routes.map((r) => r.file), ['resources/compliance.md']);
  // a note another skill reaches is no route for the browser
  note(dir, 'tracker', 'id: business-resources-tracker\ntitle: t\ndomain: business\nstatus: draft\nresource: tracker\nkind: service\nnetwork: external\nurl: https://acme.atlassian.net\nauth: token\nvia: [jira]\n');
  assert.deepEqual(browserRoutes(dir).map((r) => r.host), ['compliance.acme.example']);
  // a note that does not parse names no route, and does not deny anything
  writeFileSync(join(dir, 'resources', 'broken.md'), '---\nid: [unclosed\n---\n\nbody\n');
  assert.deepEqual(browserRoutes(dir).map((r) => r.host), ['compliance.acme.example']);
  // no installation, no notes, no routes
  assert.deepEqual(browserRoutes(null), []);
});

test('a web fetch of a host the browser skill reaches is denied, with the skill and the repair', () => {
  const dir = withBrowserResource();
  const reason = denied(dir, 'https://compliance.acme.example/controls');
  assert.ok(reason, 'the fetch is denied');
  assert.match(reason, /oikos browser guard/);
  assert.match(reason, /`browser` skill/, 'the reason names the skill');
  assert.match(reason, /compliance\.acme\.example/, 'the reason names the host');
  assert.match(reason, /resources\/compliance\.md/, 'the reason names the note');
  assert.match(reason, /login page/, 'the reason says why a fetch is wrong');
  assert.match(reason, /node oikos\/tools\/sync\/cli\.mjs/, 'the reason names the repair');
  assert.match(reason, /\/mcp reconnect or restart the session/, 'the reason names the repair');
  // a subdomain of the host is the same page
  assert.ok(denied(dir, 'https://portal.compliance.acme.example/x'), 'a subdomain');
  // the other spelling of the host's tool is judged too
  assert.ok(denied(dir, 'https://compliance.acme.example/controls', 'WebFetch'), "Claude's spelling");
  // a look-alike host is not the host
  assert.equal(denied(dir, 'https://notcompliance.acme.example/x'), null);
  assert.equal(denied(dir, 'https://acme.example/x'), null);
  assert.equal(denied(dir, 'https://example.com/x'), null, 'any other host is fetched as before');
  assert.equal(denied(dir, 'https://acme.atlassian.net/x'), null, 'a host another skill reaches');
  // another tool is not a fetch
  assert.equal(denied(dir, 'https://compliance.acme.example/x', 'read_file'), null);
});

test('the reason of a denial is the same whatever the host is written as', () => {
  const routes = browserRoutes(withBrowserResource());
  const reason = fetchReason('https://compliance.acme.example/controls', routes);
  assert.equal(reason, fetchReason('https://COMPLIANCE.acme.example:443/controls', routes));
  assert.match(reason, /akmon-browser MCP server/, 'names the route');
  assert.match(reason, /mcp__akmon-browser__\*/, 'and its tools');
  assert.equal(routeFor('https://example.com/x', routes), null);
});

test('the skill says that the MCP server is the only route to a page, and refuses a fetch of one', () => {
  const skill = readFileSync(join(CORE, 'skills', 'browser', 'SKILL.md'), 'utf8');
  assert.match(skill, /^## The only route to a page$/m);
  assert.match(skill, /akmon-browser MCP server/);
  assert.match(skill, /web_fetch/);
  assert.match(skill, /login page/);
  assert.match(skill, /^refuses:.*web fetch.*akmon-browser MCP server/m, 'the front matter refuses it too');
});

test('the fresh installation seeds the read-only DevTools rules for both hosts', async () => {
  const dir = realpathSync(installation((t) => t));
  const sync = spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'sync', 'cli.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, OIKOS_HOME: dir } });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  const reads = ['list_pages', 'take_snapshot', 'take_screenshot', 'list_console_messages', 'list_network_requests'].map((t) => `mcp__akmon-browser__${t}`);
  for (const host of ['claude', 'qwen']) {
    const settings = JSON.parse(readFileSync(join(dir, `.${host}`, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, reads, `${host}: the read-only DevTools tools are pre-allowed, each by name`);
  }
});

test('the browser guard is wired into both hosts, and the write guard is untouched', async () => {
  const dir = realpathSync(installation((t) => t));
  const sync = spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'sync', 'cli.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, OIKOS_HOME: dir } });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  const { HOSTS } = await import('../tools/hooks/wiring.mjs');
  for (const host of ['claude', 'qwen']) {
    const settings = JSON.parse(readFileSync(join(dir, `.${host}`, 'settings.json'), 'utf8'));
    const groups = settings.hooks.PreToolUse;
    const fetch = groups.find((g) => g.matcher === HOSTS[host].matchers.fetch);
    assert.ok(fetch, `${host}: a group for the fetch tools`);
    assert.ok(fetch.hooks.some((h) => h.command.endsWith('browser-guard')), `${host}: the browser guard is wired`);
    // the write guard and its dry-run flow are where they were
    const shell = groups.find((g) => g.matcher === HOSTS[host].matchers.shell);
    assert.ok(shell.hooks.some((h) => h.command.endsWith('write-guard')), `${host}: the write guard is still wired`);
    assert.ok(shell.hooks.some((h) => h.command.endsWith('git-guard')), `${host}: the git guard is still wired`);
  }
});
