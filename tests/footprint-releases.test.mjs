// The github source's releases, production releases, issues closed and first pull request
// (ADR 0008 D05, D06), against a fake client: GraphQL answered by query name, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageError } from '../tools/common/cli.mjs';
import { collectGithub } from '../tools/footprint/sources/github.mjs';

const WEEK = { since: '2026-03-01', until: '2026-03-07' };
const ORG = { login: 'ada', org: 'acme-corp', ...WEEK, tz: 'UTC' };
const NO_ORG = { login: 'ada', org: null, ...WEEK, tz: 'UTC' };
const OPTIONS = { today: '2026-03-10', pauseMs: 0, rateLimitPauseMs: 0 };
const EMPTY_SEARCH = { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };

/** A release node as the probe selects it. */
const release = (tagName, publishedAt, fields = {}) => ({ tagName, createdAt: publishedAt, publishedAt, isPrerelease: false, ...fields });
/** A repository in the probe: no pull requests, no issues, these releases. */
const probed = (releases = []) => ({
  pullRequests: { nodes: [] }, issues: { totalCount: 0, nodes: [] }, releases: { totalCount: releases.length, nodes: releases },
});
/** A search answer of one page. */
const page = (nodes, issueCount = nodes.length) => ({ search: { issueCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes } });

/**
 * A client: `repos` listed under the organization, every GraphQL call recorded and answered by the
 * function `answers` gives for its query name (default: nothing found).
 */
function fakeClient({ repos = [], probes = {}, answers = {} } = {}) {
  const calls = [];
  const graphql = async (query, variables) => {
    const name = query.match(/query (\w+)/)[1];
    calls.push({ name, variables });
    if (name === 'OikosFootprintProbe') {
      return Object.fromEntries(Object.entries(variables).filter(([k]) => /^n\d+$/.test(k))
        .map(([k, repo]) => [`r${k.slice(1)}`, probes[repo] || probed()]));
    }
    if (answers[name]) return answers[name](variables);
    if (name === 'OikosFootprintRepoPulls') return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    return EMPTY_SEARCH;
  };
  const paged = async () => repos.map((name) => ({ name }));
  return { calls, g: { graphql, paged, api: async () => ({ data: { login: 'ada' } }) } };
}

const totalsOf = (result) => Object.fromEntries(result.totals);
const eventsOf = (result, kind) => result.events.filter((e) => e.kind === kind);

test('github releases: those published in the period per repository, a prerelease marked, a draft and an older one left out; no request beyond the probe', async () => {
  const { calls, g } = fakeClient({
    repos: ['web', 'api'],
    probes: {
      web: probed([
        release('v2.0.0', '2026-03-03T10:00:00Z'),
        release('v2.0.0-rc.1', '2026-03-02T09:00:00Z', { isPrerelease: true }),
        release('v1.9.0', '2026-02-10T10:00:00Z'),
        { tagName: 'v2.1.0', createdAt: '2026-03-06T10:00:00Z', publishedAt: null, isPrerelease: false }, // a draft
      ]),
      api: probed([release('v0.4.0', '2026-03-07T23:59:00Z')]),
    },
  });
  const result = await collectGithub(g, ORG, OPTIONS);
  const facts = eventsOf(result, 'github release').sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(facts, [
    { id: 'ghrel:acme-corp/api:v0.4.0', at: '2026-03-07T23:59:00Z', kind: 'github release', action: false, what: 'acme-corp/api: v0.4.0', where: 'acme-corp/api',
      detail: { repo: 'acme-corp/api', tag: 'v0.4.0', prerelease: false } },
    { id: 'ghrel:acme-corp/web:v2.0.0', at: '2026-03-03T10:00:00Z', kind: 'github release', action: false, what: 'acme-corp/web: v2.0.0', where: 'acme-corp/web',
      detail: { repo: 'acme-corp/web', tag: 'v2.0.0', prerelease: false } },
    { id: 'ghrel:acme-corp/web:v2.0.0-rc.1', at: '2026-03-02T09:00:00Z', kind: 'github release', action: false, what: 'acme-corp/web: v2.0.0-rc.1', where: 'acme-corp/web',
      detail: { repo: 'acme-corp/web', tag: 'v2.0.0-rc.1', prerelease: true } },
  ]);
  assert.equal(totalsOf(result)['GitHub releases'], 3);
  assert.equal(calls.filter((c) => c.name === 'OikosFootprintProbe').length, 1);
  assert.match(result.notes.join('\n'), /GitHub releases: the 20 newest of each of the 2 repositories/);
  assert.doesNotMatch(result.notes.join('\n'), /GitHub releases cut/);
  assert.equal(result.partial, undefined);
});

test('github releases: a repository whose 20 newest releases all fall in the period is named as cut', async () => {
  const nodes = Array.from({ length: 20 }, (_, i) => release(`v1.${i}.0`, '2026-03-04T10:00:00Z'));
  const { g } = fakeClient({ repos: ['web'], probes: { web: { ...probed(nodes), releases: { totalCount: 25, nodes } } } });
  const result = await collectGithub(g, ORG, OPTIONS);
  assert.equal(totalsOf(result)['GitHub releases'], 20);
  assert.match(result.notes.join('\n'), /GitHub releases cut at 20 per repository in 1 repository \(web\): the count is a lower bound/);
  assert.equal(result.partial, true); // a cut crawl is merged by id in the store, nothing earlier dropped
  assert.deepEqual(result.partialReasons, ['GitHub releases cut']);
});

test('github releases: without an organization there are none, and no row for them', async () => {
  const { g } = fakeClient();
  const result = await collectGithub(g, NO_ORG, OPTIONS);
  assert.equal(eventsOf(result, 'github release').length, 0);
  assert.ok(!('GitHub releases' in totalsOf(result)));
});

/** The merged-pull search answer: the pull requests merged per repository named in the query. */
const mergedAnswer = (byRepo) => (variables) => {
  const repo = variables.q.match(/repo:(\S+)/)[1];
  return page((byRepo[repo] || []).map((mergedAt, i) => ({ id: `${repo}#${mergedAt}#${i}`, url: `https://github.com/${repo}/pull/${i + 1}`, mergedAt })));
};
const RULE = { rule: 'merge-days', base: 'main', repos: ['acme-corp/web', 'acme-corp/api'] };

test('production releases by merge-days: two repositories merging on the same UTC date are one release; a late merge keeps its UTC date in another time zone', async () => {
  const { calls, g } = fakeClient({ answers: { OikosFootprintMergedPulls: mergedAnswer({
    'acme-corp/web': ['2026-03-03T10:00:00Z', '2026-03-03T23:30:00Z', '2026-03-08T00:30:00Z'],
    'acme-corp/api': ['2026-03-03T05:00:00Z', '2026-03-05T23:30:00Z'],
  }) } });
  // Zurich is an hour ahead: 23:30 UTC on the 5th is already the 6th there, the production release stays on the 5th.
  const result = await collectGithub(g, { ...NO_ORG, tz: 'Europe/Zurich', releases: RULE }, OPTIONS);
  assert.deepEqual(eventsOf(result, 'production release'), [
    { id: 'prod:2026-03-03', date: '2026-03-03', kind: 'production release', action: false, what: 'production release', where: null,
      detail: { repos: ['acme-corp/api', 'acme-corp/web'], pulls: 3 } },
    { id: 'prod:2026-03-05', date: '2026-03-05', kind: 'production release', action: false, what: 'production release', where: null,
      detail: { repos: ['acme-corp/api'], pulls: 1 } },
  ]);
  assert.equal(totalsOf(result)['production release days'], 2);
  const searches = calls.filter((c) => c.name === 'OikosFootprintMergedPulls').map((c) => c.variables.q);
  assert.deepEqual(searches, [
    'repo:acme-corp/web is:pr is:merged base:main merged:2026-03-01..2026-03-07',
    'repo:acme-corp/api is:pr is:merged base:main merged:2026-03-01..2026-03-07',
  ]);
  assert.match(result.notes.join('\n'), /production releases by rule merge-days: distinct UTC dates of pull requests merged into main in acme-corp\/web, acme-corp\/api.*2 date\(s\)/);
});

test('production releases: without the rule no search and no row; an unknown rule, base or repository list is a usage error naming its key before any request', async () => {
  const none = fakeClient();
  const result = await collectGithub(none.g, NO_ORG, OPTIONS);
  assert.ok(!none.calls.some((c) => c.name === 'OikosFootprintMergedPulls'));
  assert.ok(!('production release days' in totalsOf(result)));
  for (const [releases, key] of [
    [{ rule: 'tag-days', base: 'main', repos: ['acme-corp/web'] }, /^releases\.rule: unknown rule "tag-days" \(known: merge-days\)$/],
    [{ base: 'main', repos: ['acme-corp/web'] }, /^releases\.rule: unknown rule undefined/],
    [{ rule: 'merge-days', repos: ['acme-corp/web'] }, /^releases\.base/],
    [{ rule: 'merge-days', base: 'main', repos: ['web'] }, /^releases\.repos/],
  ]) {
    const { calls, g } = fakeClient();
    await assert.rejects(collectGithub(g, { ...NO_ORG, releases }, OPTIONS), (e) => e instanceof UsageError && key.test(e.message));
    assert.equal(calls.length, 0);
  }
});

/** An issue node as the closed-issues search selects it; `closer` the login of its latest close event (null: none). */
const issue = (number, closer, fields = {}) => ({
  number, title: `Issue ${number}`, createdAt: '2026-02-27T12:00:00Z', closedAt: '2026-03-03T12:00:00Z', repository: { nameWithOwner: 'acme-corp/web' },
  timelineItems: { nodes: closer ? [{ actor: { login: closer } }] : [] }, ...fields,
});

test('issues closed: those whose latest close is the person\'s, with their cycle time; one closed by someone else, or outside the period, is not', async () => {
  const { calls, g } = fakeClient({ answers: { OikosFootprintClosedIssues: () => page([
    issue(7, 'Ada'), // 4.0 days
    issue(8, 'bob'),
    issue(9, 'ada', { createdAt: '2026-03-02T00:00:00Z', closedAt: '2026-03-02T06:00:00Z', repository: { nameWithOwner: 'acme-corp/api' } }), // 0.3 days
    issue(10, 'ada', { closedAt: '2026-03-08T00:30:00Z' }), // after the period: the search window is wider
    issue(11, null),
  ]) } });
  const result = await collectGithub(g, ORG, OPTIONS);
  assert.deepEqual(eventsOf(result, 'issue closed'), [
    { id: 'issue-closed:acme-corp/web#7', at: '2026-03-03T12:00:00Z', kind: 'issue closed', what: 'acme-corp/web#7 Issue 7', where: 'acme-corp/web',
      detail: { repo: 'acme-corp/web', number: 7, cycleDays: 4 } },
    { id: 'issue-closed:acme-corp/api#9', at: '2026-03-02T06:00:00Z', kind: 'issue closed', what: 'acme-corp/api#9 Issue 9', where: 'acme-corp/api',
      detail: { repo: 'acme-corp/api', number: 9, cycleDays: 0.3 } },
  ]);
  assert.ok(eventsOf(result, 'issue closed').every((e) => e.action !== false), 'an action of the person');
  const t = totalsOf(result);
  assert.deepEqual([t['issues closed'], t['issue cycle days (median)']], [2, 2.2]);
  assert.equal(calls.find((c) => c.name === 'OikosFootprintClosedIssues').variables.q, 'is:issue is:closed involves:ada org:acme-corp closed:2026-02-28..2026-03-08');
  assert.match(result.notes.join('\n'), /issues closed: .*involve ada .* in acme-corp\), .* lower bound/);
});

test('issues closed: none found gives a zero and no median', async () => {
  const { g } = fakeClient();
  const result = await collectGithub(g, NO_ORG, OPTIONS);
  const t = totalsOf(result);
  assert.equal(t['issues closed'], 0);
  assert.ok(!('issue cycle days (median)' in t));
});

test('first pull request: the oldest the person authored, one snapshot fact, in the organization when given; none found adds none', async () => {
  const found = { number: 12, createdAt: '2024-05-06T08:00:00Z', repository: { nameWithOwner: 'acme-corp/web' } };
  const { calls, g } = fakeClient({ answers: { OikosFootprintFirstPull: () => page([found]) } });
  const result = await collectGithub(g, ORG, OPTIONS);
  assert.deepEqual(eventsOf(result, 'first pull request'), [
    { id: 'first-pr', at: '2024-05-06T08:00:00Z', kind: 'first pull request', action: false, snapshot: true, what: 'acme-corp/web#12', where: 'acme-corp/web',
      detail: { repo: 'acme-corp/web', number: 12 } },
  ]);
  assert.equal(calls.find((c) => c.name === 'OikosFootprintFirstPull').variables.q, 'is:pr author:ada org:acme-corp sort:created-asc');
  const anywhere = fakeClient({ answers: { OikosFootprintFirstPull: () => page([found]) } });
  await collectGithub(anywhere.g, NO_ORG, OPTIONS);
  assert.equal(anywhere.calls.find((c) => c.name === 'OikosFootprintFirstPull').variables.q, 'is:pr author:ada sort:created-asc');
  const nobody = await collectGithub(fakeClient().g, NO_ORG, OPTIONS);
  assert.equal(eventsOf(nobody, 'first pull request').length, 0);
  assert.match(nobody.notes.join('\n'), /first pull request: ada has none/);
});
