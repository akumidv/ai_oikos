// The jira source: a person's timed actions over the period — issues created, status changes and
// other edits (each issue's changelog), comments, worklogs — read on the issues they had to do with,
// each an event at its instant, and their worklogs as hours per local date.
import { UsageError } from '../../common/cli.mjs';
import { HttpError } from '../../common/http.mjs';
import { addDays, localParts } from '../report.mjs';
import { inWorkingPeriod } from './period.mjs';
import { eachLimited } from './limited.mjs';
import { RATE_LIMIT_PAUSE_MS, rateLimitNotes, readWithRateLimit } from './ratelimit.mjs';

/** The candidate issues read at most. */
const CANDIDATE_CAP = 1000;
/** Issues whose changelog, comments and worklogs are read at once. */
const CONCURRENCY = 6;
/** Rows per page of an issue's changelog, comments or worklogs. */
const PAGE_SIZE = 100;
/** An Atlassian account id: a 24-hex legacy id, or `<number>:<uuid>` (taken as is by the confluence source too). */
export const ACCOUNT_ID = /^(\d+:[0-9a-f-]{36}|[0-9a-f]{24})$/i;

/**
 * Jira writes an offset as `+0200`; Date.parse wants `+02:00`.
 *
 * @param {string} s a Jira timestamp
 * @returns {string} the same instant as ISO 8601 that Date.parse reads
 */
export const jiraInstant = (s) => String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

/**
 * The account id of `who` in Jira: an account id as is; an email or a name through
 * `/rest/api/3/user/search` — exactly one match, else a usage error listing them.
 *
 * @param {object} client an `atlassianClient` (common/atlassian.mjs)
 * @param {string} who an account id, an email or a name
 * @returns {Promise<string>} the account id
 */
export async function atlassianAccount(client, who) {
  if (ACCOUNT_ID.test(who)) return who;
  const found = await client.get(`/rest/api/3/user/search?query=${encodeURIComponent(who)}`);
  const people = (found || []).filter((u) => u.accountType !== 'app');
  if (people.length === 1) return people[0].accountId;
  if (!people.length) throw new UsageError(`no Atlassian account matches ${who}`);
  throw new UsageError(`${people.length} Atlassian accounts match ${who}; pass --atlassian <accountId>: `
    + people.slice(0, 10).map((u) => `${u.displayName} (${u.accountId})`).join('; '));
}

/** The issues of `jql` with `fields`, following nextPageToken, at most `cap`: { issues, more }. */
async function search(jira, jql, fields, cap) {
  const issues = [];
  let token;
  for (;;) {
    let url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=100`;
    if (token) url += `&nextPageToken=${encodeURIComponent(token)}`;
    const d = await jira.get(url);
    issues.push(...(d.issues || []));
    token = d.nextPageToken;
    if (!token || !(d.issues || []).length || issues.length >= cap) break;
  }
  return { issues: issues.slice(0, cap), more: Boolean(token) || issues.length > cap };
}

/**
 * Every row of a paged list of an issue (`startAt`, `maxResults`; `total` or `isLast` says when it
 * ends): its changelog (`values`), comments (`comments`) or worklogs (`worklogs`). A page answered
 * with 429 is asked once more after the wait (`readWithRateLimit`, `limits` its options).
 */
async function pagedList(jira, path, field, limits) {
  const out = [];
  for (;;) {
    const d = await readWithRateLimit(() => jira.get(`${path}?startAt=${out.length}&maxResults=${PAGE_SIZE}`), limits);
    const page = d[field] || [];
    out.push(...page);
    if (!page.length || d.isLast === true || out.length >= (d.total ?? Infinity)) return out;
  }
}

const projectOf = (issue) => issue.fields?.project?.key || issue.key.split('-')[0];
const round = (h) => Math.round(h * 10) / 10;

/** The kinds of action the totals and the breakdown count, with their measures. */
const MEASURES = [['created', 'issues created'], ['status', 'status changes'], ['edit', 'edits'], ['comment', 'comments'], ['worklog', 'worklogs']];

/**
 * The person's actions on one issue on the working days of `period`: created (as its creator), a
 * status change or another edit (its changelog), a comment, a worklog (at its `created`, the action
 * on its working day; its hours on the calendar date of its `started` in the period's zone, as a
 * timesheet keeps them). Each event is `{ at, kind, what: '<KEY> <summary>', where: '<project key>' }`.
 */
async function issueActions(jira, issue, id, period, limits) {
  const key = encodeURIComponent(issue.key);
  const inPeriod = (at) => inWorkingPeriod(jiraInstant(at || ''), period);
  const where = projectOf(issue);
  const what = `${issue.key} ${issue.fields?.summary || ''}`.trim();
  const events = [];
  const add = (at, kind) => { if (inPeriod(at)) events.push({ at: jiraInstant(at), kind, what, where }); };
  if (issue.fields?.creator?.accountId === id) add(issue.fields.created, 'created');
  for (const h of await pagedList(jira, `/rest/api/3/issue/${key}/changelog`, 'values', limits)) {
    if (h.author?.accountId !== id) continue;
    add(h.created, (h.items || []).some((item) => item.field === 'status' || item.fieldId === 'status') ? 'status' : 'edit');
  }
  for (const c of await pagedList(jira, `/rest/api/3/issue/${key}/comment`, 'comments', limits)) {
    if (c.author?.accountId === id) add(c.created, 'comment');
  }
  const hours = new Map();
  for (const w of await pagedList(jira, `/rest/api/3/issue/${key}/worklog`, 'worklogs', limits)) {
    if (w.author?.accountId !== id) continue;
    add(w.created, 'worklog');
    const started = Date.parse(jiraInstant(w.started || ''));
    if (Number.isNaN(started)) continue;
    const { date } = localParts(started, period.tz);
    if (date < period.since || date > period.until) continue;
    hours.set(date, (hours.get(date) || 0) + (Number(w.timeSpentSeconds) || 0) / 3600);
  }
  return { events, hours };
}

/** Whether `e` is Jira saying an issue is gone or hidden: a 404 (deleted, moved) or a 403 (no access). */
const unreadable = (e) => e instanceof HttpError && [403, 404].includes(e.status);

/**
 * The jira source for one person: the candidate issues — updated since the period began and
 * created, reported, assigned at some time, watched, moved or logged by the person — and on each
 * the person's actions (`issueActions`), read a few issues at a time. An issue that answers 404 or
 * 403 is skipped and counted in the notes; a read answered 429 waits once (`readWithRateLimit`).
 *
 * @param {object} jira an `atlassianClient` for Jira (common/atlassian.mjs)
 * @param {{ who?: string, me?: boolean, since: string, until: string, tz: string, dayStartsMin?: number }} query
 *   `who` an account id, email or name; `me` the credential's own account; `dayStartsMin` the
 *   working day's start: an action belongs to the period by its working day (period.mjs)
 * @param {{ rateLimitPauseMs?: number }} [options] the wait after a 429 that names none (tests give another)
 * @returns {Promise<object>} a source result (report.mjs)
 */
export async function collectJira(jira, { who, me, since, until, tz, dayStartsMin = 0 }, { rateLimitPauseMs = RATE_LIMIT_PAUSE_MS } = {}) {
  let id;
  if (who) id = await atlassianAccount(jira, who);
  else if (me) id = (await jira.get('/rest/api/3/myself')).accountId;
  else throw new UsageError('no Atlassian account: pass --atlassian <accountId|email|name> (or --me)');
  const person = `"${id}"`;
  // A day of slack before the period: Jira reads the date in the account's time zone.
  const jql = `updated >= "${addDays(since, -1)}" AND (creator = ${person} OR reporter = ${person} OR assignee WAS ${person} `
    + `OR watcher = ${person} OR status CHANGED BY ${person} OR worklogAuthor = ${person})`;
  const candidates = await search(jira, jql, 'summary,project,created,creator', CANDIDATE_CAP);
  const period = { since, until, tz, dayStartsMin };
  const events = [];
  const hours = new Map();
  const perProject = new Map();
  const row = (key) => {
    if (!perProject.has(key)) perProject.set(key, { created: 0, status: 0, edit: 0, comment: 0, worklog: 0, hours: 0 });
    return perProject.get(key);
  };
  const limits = { pauseMs: rateLimitPauseMs, waits: [] };
  const skipped = [];
  await eachLimited(candidates.issues, CONCURRENCY, async (issue) => {
    let found;
    try {
      found = await issueActions(jira, issue, id, period, limits);
    } catch (e) {
      if (!unreadable(e)) throw e;
      skipped.push(`${issue.key} (${e.status})`);
      return;
    }
    events.push(...found.events);
    for (const e of found.events) row(e.where)[e.kind] += 1;
    for (const [date, h] of found.hours) {
      hours.set(date, (hours.get(date) || 0) + h);
      row(projectOf(issue)).hours += h;
    }
  });
  // The issues are read side by side: the events in time order, whatever order they came in.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.what.localeCompare(b.what));
  const count = (kind) => events.filter((e) => e.kind === kind).length;
  const total = [...hours.values()].reduce((sum, h) => sum + h, 0);
  const notes = [
    `${candidates.issues.length} issue(s) read: updated since ${addDays(since, -1)} and created, reported, assigned at some time, watched, moved or logged by the person; `
      + 'an action on an issue outside these (a comment on an issue the person does not watch) is missed',
    'an issue resolved is no action of its own: the status change by the person is',
    'hours are those of the person\'s worklogs started on a date of the period, on the calendar date of their start; a worklog is an action at the time it was written',
    "Jira reads the dates of a query in the time zone of the credential's account; the actions are laid on days by their instant in the report's zone",
    'which issues are read depends on their state now (updated since the period began, the person among their people): a later run can find more actions on older days',
  ];
  if (candidates.more) notes.push(`candidate issues cut at ${CANDIDATE_CAP}: the actions and hours are a lower bound`);
  if (skipped.length) notes.push(`${skipped.length} issue(s) could not be read (404 deleted or moved, 403 no access) and are left out: ${skipped.sort().join(', ')}`);
  notes.push(...rateLimitNotes(limits.waits, 'Jira'));
  const ordered = [...perProject.entries()].map(([key, r]) => [key, r, MEASURES.reduce((n, [kind]) => n + r[kind], 0)])
    .filter(([, r, n]) => n || r.hours).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
  return {
    source: 'jira',
    label: `Jira ${id}`,
    totals: [
      ...MEASURES.map(([kind, measure]) => [measure, count(kind)]),
      ['hours logged', round(total)],
      ['issues acted on', new Set(events.map((e) => e.what)).size],
    ],
    events,
    hours,
    breakdown: {
      title: 'per project',
      header: ['Project', 'Created', 'Status changes', 'Edits', 'Comments', 'Worklogs', 'Hours logged'],
      rows: ordered.map(([key, r]) => [key, ...MEASURES.map(([kind]) => r[kind]), round(r.hours)]),
      wheres: ordered.map(([key]) => key),
    },
    notes,
  };
}

/**
 * The credential's own Atlassian account, through Jira (`/rest/api/3/myself`).
 *
 * @param {object} jira an `atlassianClient` for Jira
 * @returns {Promise<{ accountId: string, name: string, email: string|null, active: boolean }[]>} one candidate, as `identifyJira` gives them
 */
export async function identifyJiraMe(jira) {
  const u = await jira.get('/rest/api/3/myself');
  return [{ accountId: u.accountId, name: u.displayName, email: u.emailAddress || null, active: Boolean(u.active) }];
}

/**
 * Atlassian accounts matching `name` (`/rest/api/3/user/search`).
 *
 * @param {object} jira an `atlassianClient` for Jira
 * @param {string} name a person's name or email
 * @returns {Promise<{ accountId: string, name: string, email: string|null, active: boolean }[]>}
 */
export async function identifyJira(jira, name) {
  const found = await jira.get(`/rest/api/3/user/search?query=${encodeURIComponent(name)}`);
  return (found || []).filter((u) => u.accountType !== 'app')
    .map((u) => ({ accountId: u.accountId, name: u.displayName, email: u.emailAddress || null, active: Boolean(u.active) }));
}
