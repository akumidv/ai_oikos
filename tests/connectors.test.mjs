// Connector tools without their site setting or token (npm test). Each test copies
// examples/installation (ACME Corp) into a temporary folder — with the site's URL taken out of
// `oikos.yaml`, or no token given — and runs the tool as an agent does. A missing credential or site
// is a usage error (exit 1) that names the key — never a TypeError, never a fallback to a dry run —
// and it comes before any request: a preloaded `fetch` that reports and refuses every call proves
// nothing reached the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE, NETWORK, NO_FETCH, assertNoCrashNoRequest, cleanEnv, installation, tempDir, tool, withGitlab } from './helpers/installation.mjs';

test('gitlab without GITLAB_URL is a usage error that names the key, before any request', () => {
  const dir = installation(withGitlab);
  for (const args of [['whoami'], ['projects'], ['mrs']]) {
    const r = tool(dir, 'gitlab', args, { GITLAB_TOKEN: 'glpat-fake-token' });
    assertNoCrashNoRequest(r);
    assert.equal(r.status, 1, `gitlab ${args[0]}: ${r.output}`);
    assert.match(r.stderr, /^gitlab: no GITLAB_URL$/m);
    assert.match(r.stderr, /GITLAB_URL\s+missing/);
    assert.match(r.stderr, /GITLAB_TOKEN\s+set/);
    assert.doesNotMatch(r.stderr, /null|personal_access_tokens/, 'no token page without a site');
  }
});

test('gitlab with GITLAB_URL set still reaches for the site', () => {
  const dir = installation((t) => withGitlab(t).replace('settings:', 'settings:\n  GITLAB_URL: https://gitlab.example.com/'));
  const r = tool(dir, 'gitlab', ['whoami'], { GITLAB_TOKEN: 'glpat-fake-token' });
  assert.doesNotMatch(r.output, /TypeError|no GITLAB_URL/);
  assert.match(r.stderr, new RegExp(`${NETWORK} https://gitlab\\.example\\.com/api/v4/user`), 'the trailing slash is trimmed');
});

test('github without GITHUB_ORG is a usage error that names the key, before any request', () => {
  const dir = installation((t) => t.replace(/^\s*GITHUB_ORG:.*\n/m, ''));
  const r = tool(dir, 'github', ['repos'], { GITHUB_TOKEN: 'ghp_fake_token' });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /GITHUB_ORG/);
});

// Without its credentials a connector command is a usage error that names what is missing, before any
// request — the same in every connector. Only an explicit --dry-run whose preview reads nothing from
// the site still runs, and says the write itself needs the credentials.

/** A folder with no programs in it: as PATH, it takes the `gh` login away from the github tool. */
const NO_PROGRAMS = tempDir('no-programs-');

function assertMissing(r, keyPattern, what) {
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 1, `${what}: ${r.output}`);
  assert.match(r.stderr, keyPattern, what);
}

test('github without GITHUB_TOKEN and without a gh login is a usage error that names the key, before any request', () => {
  const dir = installation((t) => t);
  for (const args of [['whoami'], ['repos'], ['file', '--repo', 'tools', '--path', 'README.md']]) {
    const r = tool(dir, 'github', args, { PATH: NO_PROGRAMS });
    assertMissing(r, /^github: no GitHub credential$/m, `github ${args[0]}`);
    assert.match(r.stderr, /GITHUB_TOKEN\s+missing/);
  }
});

test('jira without JIRA_BASE_URL is a usage error that names the key, before any request', () => {
  const dir = installation((t) => t.replace(/^\s*JIRA_BASE_URL:.*\n/m, ''));
  const r = tool(dir, 'jira', ['whoami'], { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' });
  assertMissing(r, /^jira: no Jira credentials — cannot check the account$/m, 'jira whoami');
  assert.match(r.stderr, /JIRA_BASE_URL\s+missing/);
  assert.match(r.stderr, /JIRA_API_TOKEN\s+set/);
});

test('jira without a token: reads, writes and dry runs that read the site are usage errors', () => {
  const dir = installation((t) => t);
  const env = { JIRA_EMAIL: 'ada@acme.example' };
  for (const args of [
    ['whoami'], ['search', '--jql', 'project = PROJ'], ['info', '--task', 'PROJ-123'],
    ['comment', '--task', 'PROJ-123', '--text', 'Done.'],
    ['transition', '--task', 'PROJ-123', '--to', 'In Progress', '--dry-run'],
    ['create', '--project', 'PROJ', '--summary', 'A task', '--dry-run'],
    ['goal-comment', '--key', 'GOAL-1', '--text', 'On track.', '--dry-run'],
  ]) {
    const r = tool(dir, 'jira', args, env);
    assertMissing(r, /^jira: no Jira credentials — cannot /m, `jira ${args.join(' ')}`);
    assert.match(r.stderr, /JIRA_API_TOKEN\s+missing/);
    assert.doesNotMatch(r.stdout, /DRY RUN/, 'never a dry run in place of the command');
  }
});

test('jira without a token still previews a comment under an explicit --dry-run, offline', () => {
  const dir = installation((t) => t);
  const r = tool(dir, 'jira', ['comment', '--task', 'PROJ-123', '--text', 'Done.', '--dry-run'], { JIRA_EMAIL: 'ada@acme.example' });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /--- DRY RUN \(requested --dry-run\) ---/);
  assert.match(r.stdout, /no Jira credentials — the write itself needs them/);
  assert.match(r.stdout, /JIRA_API_TOKEN\s+missing/);
});

test('confluence without a base URL is a usage error that names the key, before any request', () => {
  const dir = installation((t) => t.replace(/^\s*JIRA_BASE_URL:.*\n/m, ''));
  const env = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
  for (const args of [
    ['info', '--page', '123'], ['search', '--title', 'Handbook'],
    ['append', '--page', '123', '--text', 'A section.'],
    ['replace-section', '--page', '123', '--heading', 'Scope', '--text', 'New scope.', '--dry-run'],
  ]) {
    const r = tool(dir, 'confluence', args, env);
    assertMissing(r, /^confluence: no Atlassian credentials — cannot /m, `confluence ${args.join(' ')}`);
    assert.match(r.stderr, /JIRA_BASE_URL\s+missing/);
    assert.doesNotMatch(r.stdout, /DRY RUN/, 'never a dry run in place of the command');
  }
  const dry = tool(dir, 'confluence', ['append', '--page', '123', '--text', 'A section.', '--dry-run'], env);
  assertNoCrashNoRequest(dry);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /--- DRY RUN \(requested --dry-run\) ---/);
  assert.match(dry.stdout, /no Atlassian credentials — the write itself needs them/);
});

test('setup status reports a connector without credentials as missing, and does not fail', () => {
  const dir = installation((t) => t);
  // NODE_OPTIONS carries the fetch guard into every whoami that status starts.
  const r = tool(dir, 'setup', ['status'], { PATH: NO_PROGRAMS, NODE_OPTIONS: `--import=${NO_FETCH}` });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}-- {2}jira — jira: no Jira credentials — cannot check the account$/m);
  assert.match(r.stdout, /^ {2}-- {2}github — github: no GitHub credential$/m);
  assert.match(r.stdout, /^not ready: .*\bjira\b.*\bgithub\b/m);
});

// A connector tool runs only in an installation that lists its connector under some skill in
// `connectors:`: a token exported in the shell reaches every installation on the machine, and must
// not work in one that does not use the connector. The check comes before any credential or request.

const notListed = (name) => new RegExp(`^${name}: ${name} is not a connector of this installation — add it under connectors: in oikos\\.yaml`, 'm');

test('a connector tool the installation does not list is a usage error, before any credential or request', () => {
  // The example lists github, jira and confluence; gitlab and google are not there.
  const dir = installation((t) => t.replace('settings:', 'settings:\n  GITLAB_URL: https://gitlab.example.com'));
  const gitlab = tool(dir, 'gitlab', ['whoami'], { GITLAB_TOKEN: 'glpat-fake-token' });
  assertMissing(gitlab, notListed('gitlab'), 'gitlab whoami with its site and token');
  assert.match(gitlab.stderr, /landscape\/cli\.mjs skills/);
  assert.doesNotMatch(gitlab.stderr, /Credentials:/, 'no credential lookup');
  assertMissing(tool(dir, 'google', ['drive']), notListed('google'), 'google drive');
});

test('jira and confluence are separate connectors, though they share the credentials', () => {
  const env = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
  const noWiki = installation((t) => t.replace(/^\s*wiki:.*\n/m, ''));
  assertMissing(tool(noWiki, 'confluence', ['info', '--page', '123'], env), notListed('confluence'), 'confluence without wiki');
  const jira = tool(noWiki, 'jira', ['whoami'], env);
  assert.match(jira.stderr, new RegExp(`${NETWORK} https://acme\\.atlassian\\.net/`), `jira is still listed: ${jira.output}`);
  const noTracker = installation((t) => t.replace(/^\s*task-tracking:.*\n/m, ''));
  assertMissing(tool(noTracker, 'jira', ['whoami'], env), notListed('jira'), 'jira without task-tracking');
});

test('an installation that lists no connector runs no connector tool', () => {
  const dir = installation((t) => t.replace(/^connectors:\n(?:\s+.*\n)+/m, 'connectors:\n'));
  const env = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token', GITHUB_TOKEN: 'ghp_fake_token' };
  for (const name of ['jira', 'confluence', 'github']) {
    assertMissing(tool(dir, name, name === 'confluence' ? ['info', '--page', '123'] : ['whoami'], env), notListed(name), name);
  }
});

test('usage and --help of a connector tool print without the check', () => {
  const dir = installation((t) => t);
  const usage = tool(dir, 'gitlab', ['--help']);
  assert.equal(usage.status, 0, usage.output);
  assert.match(usage.stdout, /^usage: node oikos\/tools\/gitlab\/cli\.mjs/m);
  const help = tool(dir, 'gitlab', ['whoami', '--help']);
  assert.equal(help.status, 0, help.output);
  assert.match(help.stdout, /^whoami: /m);
});

test('outside an installation a connector tool says so, before any credential or request', () => {
  const outside = tempDir('outside-');
  const r = spawnSync(process.execPath, ['--import', NO_FETCH, join(CORE, 'tools', 'jira', 'cli.mjs'), 'whoami'], {
    cwd: outside, encoding: 'utf8',
    env: cleanEnv({ PWD: outside, JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' }),
  });
  assertMissing({ ...r, output: `${r.stdout}\n${r.stderr}` }, /^jira: no oikos installation here \(/m, 'jira outside');
});

test('setup status checks the accounts of listed connectors only', () => {
  const dir = installation((t) => t.replace(/^\s*(task-tracking|wiki):.*\n/gm, ''));
  const r = tool(dir, 'setup', ['status'], { PATH: NO_PROGRAMS, NODE_OPTIONS: `--import=${NO_FETCH}`, GITLAB_TOKEN: 'glpat-fake-token' });
  assertNoCrashNoRequest(r);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}-- {2}github — github: no GitHub credential$/m);
  assert.doesNotMatch(r.stdout, /^ {2}(ok |--) {2}(jira|gitlab) — /m);
  assert.doesNotMatch(r.stdout, /is not a connector/);
  // Only github is listed: only its token is a row, though GITLAB_TOKEN is set in the shell.
  assert.match(r.stdout, /^ {2}-- {2}GITHUB_TOKEN — missing/m);
  assert.doesNotMatch(r.stdout, /^ {2}(ok |--) {2}(JIRA_EMAIL|JIRA_API_TOKEN|GITLAB_TOKEN) — /m);
  // None listed: no tool runs, so no account is checked and no token is needed.
  const none = installation((t) => t.replace(/^connectors:\n(?:\s+.*\n)+/m, 'connectors:\n'));
  const s = tool(none, 'setup', ['status'], { PATH: NO_PROGRAMS, NODE_OPTIONS: `--import=${NO_FETCH}`, GITLAB_TOKEN: 'glpat-fake-token' });
  assert.equal(s.status, 0, s.output);
  assert.match(s.stdout, /connectors: none chosen — no connector tool runs until one is listed/);
  assert.match(s.stdout, /^ {2}\.\. {2}no token needed — no connector is listed$/m);
  assert.doesNotMatch(s.stdout, /^ {2}(ok |--) {2}(jira|gitlab|github) — /m);
  assert.doesNotMatch(s.stdout, /^ {2}(ok |--) {2}[A-Z_]+(TOKEN|EMAIL|PASSWORD) — /m);
  assert.doesNotMatch(s.stdout, /is not a connector/);
});

// The git email is a default for JIRA_EMAIL only inside the organization's configured email domain:
// without one, the machine's git email may be another organization's address.

/** A global git configuration whose only setting is `user.email`, for the child's git. */
function gitEmail(address) {
  const file = join(tempDir('git-'), 'gitconfig');
  writeFileSync(file, `[user]\n\temail = ${address}\n`);
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

test('without an email domain jira does not take the git email as JIRA_EMAIL', () => {
  const dir = installation((t) => t.replace(/^\s*email_domain:.*\n/m, ''));
  const r = tool(dir, 'jira', ['whoami'], { ...gitEmail('ada@other.example'), JIRA_API_TOKEN: 'fake-token', JIRA_BASE_URL: 'https://acme.atlassian.net' });
  assertMissing(r, /^jira: no Jira credentials — cannot check the account$/m, 'jira whoami');
  assert.match(r.stderr, /JIRA_EMAIL\s+missing/);
  assert.match(r.stderr, /JIRA_EMAIL must be your work address \(\.local\/\.env or env\)\./, 'git config is not offered as a source');
  assert.doesNotMatch(r.output, /other\.example/);
});

test('with an email domain jira takes an in-domain git email as JIRA_EMAIL, and no other', () => {
  const dir = installation((t) => t);
  // No token: the command stops offline, and the help asks for JIRA_EMAIL only when none was found.
  const inDomain = tool(dir, 'jira', ['whoami'], gitEmail('ada@acme.example'));
  assertMissing(inDomain, /^jira: no Jira credentials — /m, 'in-domain git email');
  assert.doesNotMatch(inDomain.stderr, /JIRA_EMAIL must be/);
  const outside = tool(dir, 'jira', ['whoami'], gitEmail('ada@other.example'));
  assertMissing(outside, /^jira: no Jira credentials — /m, 'out-of-domain git email');
  assert.match(outside.stderr, /JIRA_EMAIL must be an @acme\.example address \(\.local\/\.env or env, or git config user\.email\)\./);
});

test('the mail account takes the git email only inside a configured email domain', () => {
  const script = `import { mailAccount } from ${JSON.stringify(pathToFileURL(join(CORE, 'tools', 'google', 'mail.mjs')).href)}; console.log(String(mailAccount()));`;
  const account = (dir, env) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', env: cleanEnv({ OIKOS_HOME: dir, PWD: dir, ...env }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(account(installation((t) => t.replace(/^\s*email_domain:.*\n/m, '')), gitEmail('ada@other.example')), 'null');
  assert.equal(account(installation((t) => t), gitEmail('ada@acme.example')), 'ada@acme.example');
  assert.equal(account(installation((t) => t.replace(/^\s*email_domain:.*\n/m, '')), { ...gitEmail('ada@other.example'), GMAIL_USER: 'ada@named.example' }), 'ada@named.example');
});
