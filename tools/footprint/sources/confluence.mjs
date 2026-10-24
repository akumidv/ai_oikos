// The confluence source: the pages and blog posts a person created over the period (with the words
// of their current text) and every version of a page they saved in it, found through CQL and each
// page's versions. People are found by name through Confluence's own user search, by email through
// Jira's when the installation has it: the site's accounts are shared.
import { UsageError } from '../../common/cli.mjs';
import { HttpError } from '../../common/http.mjs';
import { addDays } from '../report.mjs';
import { inWorkingPeriod, periodBounds } from './period.mjs';
import { ACCOUNT_ID, atlassianAccount } from './jira.mjs';
import { eachLimited } from './limited.mjs';

const RESULT_CAP = 500;
const PAGE_SIZE = 50;
const USER_LIMIT = 20;
/** Pages whose versions are read at once. */
const CONCURRENCY = 6;

/**
 * The words of a storage-format body: the tags and entities stripped, the rest split on space.
 *
 * @param {string|undefined} storage the page's body in storage format
 * @returns {number} how many words
 */
export function wordCount(storage) {
  const text = String(storage || '').replace(/<[^>]*>/g, ' ').replace(/&[#a-z0-9]+;/gi, ' ');
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

/** The results of a CQL search with `expand`, following `_links.next`, at most RESULT_CAP: { results, more }. */
async function search(wiki, cql, expand) {
  const results = [];
  let path = `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${PAGE_SIZE}&expand=${expand}`;
  while (path && results.length < RESULT_CAP) {
    const d = await wiki.get(path);
    results.push(...(d.results || []));
    const next = d._links?.next;
    path = next && (d.results || []).length ? nextPath(next) : null;
  }
  return { results: results.slice(0, RESULT_CAP), more: Boolean(path) || results.length > RESULT_CAP };
}

/** The people (not apps) of Confluence's user search whose full name matches `name`. */
async function usersNamed(wiki, name) {
  const cql = `user.fullname~"${name.replace(/["\\]/g, '\\$&')}"`;
  const found = await wiki.get(`/wiki/rest/api/search/user?cql=${encodeURIComponent(cql)}&limit=${USER_LIMIT}`);
  return (found?.results || []).map((r) => r.user).filter((u) => u?.accountId && u.accountType !== 'app');
}

/**
 * The account id of `who` in Confluence: an account id as is; a name through Confluence's user
 * search (`/wiki/rest/api/search/user`, CQL `user.fullname`) — exactly one match, else a usage
 * error listing them. Confluence Cloud does not search people by email, so an email goes through
 * Jira's user search when `jira` is given, and is refused with the way to the account id when not.
 *
 * @param {object} wiki an `atlassianClient` for Confluence (common/atlassian.mjs)
 * @param {string} who an account id, a name or an email
 * @param {object|null} [jira] an `atlassianClient` for Jira on the same site, or null when the
 *   installation lists no jira connector or has no complete Jira credentials
 * @returns {Promise<string>} the account id
 * @throws {UsageError} for an email without `jira`, or a name or email that matches none or several
 */
export async function confluenceAccount(wiki, who, jira = null) {
  if (ACCOUNT_ID.test(who)) return who;
  if (who.includes('@')) {
    if (jira) return atlassianAccount(jira, who);
    throw new UsageError(`Confluence does not find people by email (${who}), and no Jira to ask (the jira connector is not listed or has no `
      + 'complete credentials): pass --atlassian <accountId> or a name (identify --name lists the accounts)');
  }
  const people = await usersNamed(wiki, who);
  if (people.length === 1) return people[0].accountId;
  if (!people.length) throw new UsageError(`no Confluence account matches ${who}`);
  throw new UsageError(`${people.length} Confluence accounts match ${who}; pass --atlassian <accountId>: `
    + people.slice(0, 10).map((u) => `${u.displayName} (${u.accountId})`).join('; '));
}

/** A `_links.next` of Confluence as a path from the site: v1's is relative to <base>/wiki, v2's starts with /wiki. */
const nextPath = (next) => (next.startsWith('/wiki/') ? next : `/wiki${next}`);

/**
 * The versions of one page or blog post, newest first, as { number, by, when }, read until the
 * first one older than `from`: v1 `/wiki/rest/api/content/{id}/version`, else v2
 * `/wiki/api/v2/{pages|blogposts}/{id}/versions` where v1 answers 404 or 410.
 */
async function versionsOf(wiki, page, from) {
  const out = [];
  const older = () => out.length && Date.parse(out.at(-1).when) < from;
  try {
    for (let start = 0; ;) {
      const d = await wiki.get(`/wiki/rest/api/content/${encodeURIComponent(page.id)}/version?start=${start}&limit=${PAGE_SIZE}`);
      const rows = d.results || [];
      out.push(...rows.map((v) => ({ number: v.number, by: v.by?.accountId, when: v.when })));
      if (!rows.length || !d._links?.next || older()) return out;
      start += rows.length;
    }
  } catch (e) {
    if (!(e instanceof HttpError && [404, 410].includes(e.status))) throw e;
  }
  // v2 starts over: what v1 gave before it failed would be counted twice.
  out.length = 0;
  const kind = page.type === 'blogpost' ? 'blogposts' : 'pages';
  let path = `/wiki/api/v2/${kind}/${encodeURIComponent(page.id)}/versions?limit=${PAGE_SIZE}&sort=-modified-date`;
  while (path) {
    const d = await wiki.get(path);
    const rows = d.results || [];
    out.push(...rows.map((v) => ({ number: v.number, by: v.authorId, when: v.createdAt })));
    path = rows.length && d._links?.next && !older() ? nextPath(d._links.next) : null;
  }
  return out;
}

/**
 * The confluence source for one person: pages and blog posts created in the period (each a `page
 * created` event, with the words of its current text), and every version the person saved in the
 * period of the pages they contributed to that changed since it began (each a `page edited` event;
 * the first version is the creation). Each event is `{ at, kind, what: '<SPACE>: <title>',
 * where: '<SPACE>' }`.
 *
 * @param {object} wiki an `atlassianClient` for Confluence (common/atlassian.mjs)
 * @param {{ who?: string, me?: boolean, jira?: object|null, since: string, until: string, tz?: string, dayStartsMin?: number }} query
 *   `who` an account id, name or email; `me` the credential's own account; `jira` a Jira client
 *   that resolves an email (see `confluenceAccount`); `tz` the zone of the period (default UTC);
 *   `dayStartsMin` the working day's start: an edit belongs to the period by its working day (period.mjs)
 * @returns {Promise<object>} a source result (report.mjs)
 */
export async function collectConfluence(wiki, { who, me, jira = null, since, until, tz = 'UTC', dayStartsMin = 0 }) {
  let id;
  if (who) id = await confluenceAccount(wiki, who, jira);
  else if (me) id = (await wiki.get('/wiki/rest/api/user/current')).accountId;
  else throw new UsageError('no Atlassian account: pass --atlassian <accountId|email|name> (or --me)');
  // CQL reads the dates in the account's time zone: a day of slack before the period, and after it
  // one more where a page created before day_starts after `until`'s midnight still belongs to `until`.
  // The working-day filter below keeps the period exact.
  const first = addDays(since, -1);
  const next = addDays(until, dayStartsMin ? 2 : 1);
  const kinds = 'type in (page, blogpost)';
  const found = await search(wiki, `${kinds} AND creator = "${id}" AND created >= "${first}" AND created < "${next}"`, 'space,history,body.storage');
  // `contributor` is anyone who ever created or edited the page, `lastmodified` the latest change by
  // anyone: a page the person edited in the period has changed since it began; its versions say who
  // saved what when.
  const contributed = await search(wiki, `${kinds} AND contributor = "${id}" AND lastmodified >= "${first}"`, 'space,version');
  const notes = [];
  if (found.more) notes.push(`created pages cut at ${RESULT_CAP}`);
  if (contributed.more) notes.push(`pages contributed to cut at ${RESULT_CAP}: the edits are a lower bound`);
  const period = { since, until, tz, dayStartsMin };
  const { from } = periodBounds(period);
  const inPeriod = (at) => inWorkingPeriod(at, period);
  // A page counts by its creation's working day here; one without a creation date cannot be placed.
  const created = found.results.filter((page) => page.history?.createdDate && inPeriod(page.history.createdDate));
  const perSpace = new Map();
  const row = (page) => {
    const key = page.space?.key || '?';
    if (!perSpace.has(key)) perSpace.set(key, { name: page.space?.name || key, created: 0, words: 0, edits: 0, edited: 0 });
    return perSpace.get(key);
  };
  const event = (page, at, kind) => ({ at, kind, what: `${page.space?.key || '?'}: ${page.title || page.id}`, where: page.space?.key || null });
  const events = [];
  let words = 0;
  for (const page of created) {
    const n = wordCount(page.body?.storage?.value);
    const r = row(page);
    r.created += 1;
    r.words += n;
    words += n;
    events.push(event(page, page.history.createdDate, 'page created'));
  }
  let unread = 0;
  await eachLimited(contributed.results, CONCURRENCY, async (page) => {
    let versions;
    try {
      versions = await versionsOf(wiki, page, from);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      // Versions that cannot be read: the latest change alone, where it is the person's.
      unread += 1;
      versions = page.version ? [{ number: page.version.number, by: page.version.by?.accountId, when: page.version.when }] : [];
    }
    const own = versions.filter((v) => v.by === id && v.number > 1 && inPeriod(v.when));
    if (!own.length) return;
    const r = row(page);
    r.edits += own.length;
    r.edited += 1;
    for (const v of own) events.push(event(page, v.when, 'page edited'));
  });
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.what.localeCompare(b.what));
  if (unread) notes.push(`the versions of ${unread} page(s) could not be read: only their latest change is counted, where it is the person's`);
  notes.push(
    'an edit is a version the person saved in the period (version 1 is the creation, not an edit); the pages looked into are those they ever contributed to '
      + `that changed since the period began (at most ${RESULT_CAP})`,
    'words are those of the current text of the created pages, not what the person wrote of it',
  );
  const edits = events.filter((e) => e.kind === 'page edited').length;
  const ordered = [...perSpace.entries()].sort((a, b) => b[1].created + b[1].edits - (a[1].created + a[1].edits) || a[0].localeCompare(b[0]));
  return {
    source: 'confluence',
    label: `Confluence ${id}`,
    totals: [
      ['pages created', created.length],
      ['words in them', words],
      ['page edits', edits],
      ['pages edited', ordered.reduce((n, [, r]) => n + r.edited, 0)],
      ['spaces', perSpace.size],
    ],
    events,
    breakdown: {
      title: 'per space',
      header: ['Space', 'Created', 'Words', 'Edits', 'Pages edited'],
      rows: ordered.map(([key, r]) => [`${key} ${r.name !== key ? r.name : ''}`.trim(), r.created, r.words, r.edits, r.edited]),
      wheres: ordered.map(([key]) => key),
    },
    notes,
  };
}

/**
 * The credential's own Atlassian account: through Jira's `/rest/api/3/myself` when `jira` is given
 * (the site's accounts are shared), else Confluence's `/wiki/rest/api/user/current`.
 *
 * @param {object} wiki an `atlassianClient` for Confluence
 * @param {object|null} [jira] an `atlassianClient` for Jira on the same site, or null
 * @returns {Promise<{ accountId: string, name: string, email: string|null }[]>} one candidate, as `identifyConfluence` gives them
 */
export async function identifyConfluenceMe(wiki, jira = null) {
  const u = jira ? await jira.get('/rest/api/3/myself') : await wiki.get('/wiki/rest/api/user/current');
  return [{ accountId: u.accountId, name: u.displayName, email: u.emailAddress || u.email || null }];
}

/**
 * Confluence accounts whose full name matches `name` (`/wiki/rest/api/search/user`).
 *
 * @param {object} wiki an `atlassianClient` for Confluence
 * @param {string} name a person's name
 * @returns {Promise<{ accountId: string, name: string, email: string|null }[]>}
 */
export async function identifyConfluence(wiki, name) {
  return (await usersNamed(wiki, name)).map((u) => ({ accountId: u.accountId, name: u.displayName, email: u.email || null }));
}
