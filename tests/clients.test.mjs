// The shared GitHub and GitLab clients (tools/common/github.mjs, gitlab.mjs) against canned answers
// (npm test): the code-hosting tools run in a copy of examples/installation (ACME Corp) under the
// fake-fetch preload, so pagination, base URLs and error mapping are checked without a network; the
// GraphQL call runs the client through a small module, and the pure helpers are called in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpError } from '../tools/common/http.mjs';
import { UsageError } from '../tools/common/cli.mjs';
import { githubEndpoints, graphqlError } from '../tools/common/github.mjs';
import { CORE, NETWORK, installation, script, tool, withFakeFetch, withGitlab } from './helpers/installation.mjs';

const GITHUB = { GITHUB_TOKEN: 'ghp_fake_token' };
const GITLAB = { GITLAB_TOKEN: 'glpat-fake-token' };
const withSetting = (key, value) => (t) => t.replace('settings:', `settings:\n  ${key}: ${value}`);
const repo = (name) => ({ name, full_name: `acme-corp/${name}`, private: false, pushed_at: '2026-01-02T00:00:00Z', description: `${name} code` });

test('github whoami reads /user, and the log of calls holds no credential', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, [{ url: 'https://api.github.com/user', body: { login: 'ada', name: 'Ada Lovelace' } }]);
  const r = tool(dir, 'github', ['whoami'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout, '@ada (Ada Lovelace) via token (env)\n');
  assert.deepEqual(fake.calls(), [{ method: 'GET', url: 'https://api.github.com/user', body: null }]);
  assert.doesNotMatch(JSON.stringify(fake.calls()), /ghp_fake_token/);
});

test('github repos follows the Link rel="next" header', () => {
  const dir = installation((t) => t);
  const next = 'https://api.github.com/organizations/1/repos?sort=pushed&type=all&per_page=100&page=2';
  const fake = withFakeFetch(dir, [
    {
      url: 'https://api.github.com/orgs/acme-corp/repos?sort=pushed&type=all&per_page=100',
      headers: { Link: `<${next}>; rel="next", <${next}>; rel="last"` },
      body: [repo('tools'), repo('site')],
    },
    { url: next, body: [repo('docs')] },
  ]);
  const r = tool(dir, 'github', ['repos'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^acme-corp\/tools\s+public {2}2026-01-02 {2}tools code$/m);
  assert.match(r.stdout, /^acme-corp\/docs\s+/m);
  assert.match(r.stdout, /^3 repositories$/m);
  assert.equal(fake.calls().length, 2);
});

test('github honours GITHUB_API_URL with a trailing slash', () => {
  const dir = installation(withSetting('GITHUB_API_URL', 'https://github.example.com/api/v3/'));
  const fake = withFakeFetch(dir, [{ url: 'https://github.example.com/api/v3/user', body: { login: 'ada', name: null } }]);
  const r = tool(dir, 'github', ['whoami'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout, '@ada (-) via token (env)\n');
  assert.deepEqual(fake.calls().map((c) => c.url), ['https://github.example.com/api/v3/user']);
});

test('github 401 is the rejected-credential usage error, 404 is "not found, or no access"', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, [
    { url: 'https://api.github.com/user', status: 401, body: { message: 'Bad credentials' } },
    { match: '/repos/acme-corp/missing$', status: 404, body: { message: 'Not Found' } },
  ]);
  const rejected = tool(dir, 'github', ['whoami'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(rejected.status, 1, rejected.output);
  assert.match(rejected.stderr, /^github: GitHub rejected the credential \(401, route: token \(env\)\)$/m);
  const missing = tool(dir, 'github', ['ls', '--repo', 'missing'], { ...GITHUB, ...fake.env }, fake);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.stderr, /^github: not found, or no access \(GitHub answers 404 for both\): \/repos\/acme-corp\/missing$/m);
});

test('gitlab projects follows X-Next-Page', () => {
  const dir = installation((t) => withSetting('GITLAB_URL', 'https://gitlab.example.com/')(withGitlab(t)));
  const project = (path) => ({ path_with_namespace: path, last_activity_at: '2026-01-02T03:04:05Z', web_url: `https://gitlab.example.com/${path}` });
  const pages = 'https://gitlab\\.example\\.com/api/v4/projects\\?membership=true&order_by=last_activity_at&simple=true&per_page=50&page=';
  const fake = withFakeFetch(dir, [
    { match: `^${pages}1$`, headers: { 'X-Next-Page': '2' }, body: [project('acme/tools')] },
    { match: `^${pages}2$`, headers: { 'X-Next-Page': '' }, body: [project('acme/site')] },
  ]);
  const r = tool(dir, 'gitlab', ['projects'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^acme\/tools\s+2026-01-02 03:04 {2}https:\/\/gitlab\.example\.com\/acme\/tools$/m);
  assert.match(r.stdout, /^2 project\(s\)$/m);
  assert.equal(fake.calls().length, 2);
});

test('gitlab 401 is the rejected-token usage error with the token help', () => {
  const dir = installation((t) => withSetting('GITLAB_URL', 'https://gitlab.example.com')(withGitlab(t)));
  const fake = withFakeFetch(dir, [{ url: 'https://gitlab.example.com/api/v4/user', status: 401, body: { message: '401 Unauthorized' } }]);
  const r = tool(dir, 'gitlab', ['whoami'], { ...GITLAB, ...fake.env }, fake);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^gitlab: GitLab rejected the token \(401\)$/m);
  assert.match(r.stderr, /Token \(scope read_api or api\): https:\/\/gitlab\.example\.com\/-\/user_settings\/personal_access_tokens/);
});

test('the fake fetch exhausts a route after `times` and refuses an unmatched call', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, [{ url: 'https://api.example.com/once', body: { ok: true }, times: 1 }]);
  const code = `const a = await fetch('https://api.example.com/once');
console.log(JSON.stringify(await a.json()));
await fetch('https://api.example.com/once').catch((e) => console.log('refused: ' + e.message));`;
  const r = script(dir, code, fake.env, fake);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout, '{"ok":true}\nrefused: the network is off in tests\n');
  assert.match(r.stderr, new RegExp(`^${NETWORK} GET https://api\\.example\\.com/once$`, 'm'));
  assert.equal(fake.calls().length, 2);
});

// GraphQL: the client posts to the endpoint of its API URL and returns `data`, or maps `errors`.

const GITHUB_MODULE = pathToFileURL(join(CORE, 'tools', 'common', 'github.mjs')).href;
const graphqlScript = (query) => `import { githubClient } from ${JSON.stringify(GITHUB_MODULE)};
try {
  console.log(JSON.stringify(await githubClient('test').graphql(${JSON.stringify(query)}, { n: 1 })));
} catch (e) {
  console.log(e.constructor.name + ': ' + e.message);
}`;

test('github graphql posts the query and variables to /graphql and returns data', () => {
  const dir = installation((t) => t);
  const fake = withFakeFetch(dir, [{ graphql: 'query Viewer', body: { data: { viewer: { login: 'ada' } } } }]);
  const r = script(dir, graphqlScript('query Viewer { viewer { login } }'), { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout, '{"viewer":{"login":"ada"}}\n');
  assert.deepEqual(fake.calls(), [{ method: 'POST', url: 'https://api.github.com/graphql', body: { query: 'query Viewer { viewer { login } }', variables: { n: 1 } } }]);
});

test('github graphql on GitHub Enterprise Server uses /api/graphql, and maps a missing scope', () => {
  const dir = installation(withSetting('GITHUB_API_URL', 'https://github.example.com/api/v3'));
  const message = "Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']";
  const fake = withFakeFetch(dir, [{ graphql: 'query Projects', url: 'https://github.example.com/api/graphql', body: { errors: [{ type: 'INSUFFICIENT_SCOPES', message }] } }]);
  const r = script(dir, graphqlScript('query Projects { viewer { login } }'), { ...GITHUB, ...fake.env }, fake);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout, `UsageError: GitHub refused the request (INSUFFICIENT_SCOPES): ${message}\n`);
});

test('githubEndpoints: github.com, GitHub Enterprise Server, an explicit server URL', () => {
  assert.deepEqual(githubEndpoints(), { apiUrl: 'https://api.github.com', serverUrl: 'https://github.com', graphqlUrl: 'https://api.github.com/graphql' });
  assert.deepEqual(githubEndpoints('https://api.github.com/'), githubEndpoints());
  assert.deepEqual(githubEndpoints('https://github.example.com/api/v3//'), {
    apiUrl: 'https://github.example.com/api/v3', serverUrl: 'https://github.example.com', graphqlUrl: 'https://github.example.com/api/graphql',
  });
  assert.equal(githubEndpoints(undefined, '/tmp/remotes/').serverUrl, '/tmp/remotes');
  assert.throws(() => githubEndpoints('github.example.com'), (e) => e instanceof UsageError && /GITHUB_API_URL is not an http\(s\) URL: github\.example\.com/.test(e.message));
});

test('graphqlError maps NOT_FOUND, FORBIDDEN and INSUFFICIENT_SCOPES to usage errors, the rest to HttpError', () => {
  const notFound = graphqlError([{ type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'acme-corp/missing'." }]);
  assert.ok(notFound instanceof UsageError);
  assert.match(notFound.message, /^not found, or no access: Could not resolve/);
  const forbidden = graphqlError([{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }]);
  assert.ok(forbidden instanceof UsageError);
  assert.equal(forbidden.message, 'GitHub refused the request (FORBIDDEN): Resource not accessible by integration');
  const other = graphqlError([{ message: 'Field x is unknown' }, { message: 'Field y is unknown' }], { status: 200, url: 'https://api.github.com/graphql' });
  assert.ok(other instanceof HttpError);
  assert.equal(other.status, 200);
  assert.match(other.message, /^HTTP 200 from https:\/\/api\.github\.com\/graphql: Field x is unknown; Field y is unknown$/);
});
