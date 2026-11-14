// The team source: facts about the people around the work in the period, not about one person —
// the Jira projects (their lead, versions released, people assigned to issues updated in the period)
// and the authors of commits per repository. Every event is a fact (`action: false`). Who counts as
// a team member is the user's rule (`team.members`): the rule is printed and marks people, it never
// ranks them — rows are sorted by name, people are listed by name, nothing is ordered by a count.
import { basename, dirname } from 'node:path';
import { UsageError } from '../../common/cli.mjs';
import { HttpError } from '../../common/http.mjs';
import { addDays } from '../report.mjs';
import { dateLimit, installedGitVersion, remoteLocation, repoWhere, runGit } from './git.mjs';
import { eachLimited } from './limited.mjs';
import { inWorkingPeriod, workingDate } from './period.mjs';
import { RATE_LIMIT_PAUSE_MS, rateLimitNotes, readWithRateLimit } from './ratelimit.mjs';
import { jiraInstant, searchIssues } from './jira.mjs';

/** The issues scanned at most for the assigned people (and, with no project given, the projects). */
const ISSUE_CAP = 1000;
/** Projects read at once. */
const CONCURRENCY = 4;
/** A Jira project key as it goes into a query. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const REFS = ['--branches', '--tags', '--remotes', '--no-merges'];

/** The counting rule's test: whether any of `facts` (a name, an email, an account id) is one of `members`, exactly, ignoring case. */
const isMember = (members, ...facts) => facts.some((f) => f && members.has(String(f).toLowerCase()));
/** People by name, never by count; a member is marked. */
const listPeople = (people) => [...people.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
  .map((p) => (p.member ? `${p.name} (member)` : p.name));

/** Whether `e` is Jira saying a project is gone or hidden: 404 or 403. */
const unreadable = (e) => e instanceof HttpError && [403, 404].includes(e.status);

/**
 * The Jira facts and rows of the period. Returns `{ events, projects, assigned, notes }`: `projects`
 * one `{ key, lead, versions, people }` per project read, `assigned` every person assigned.
 */
async function jiraFacts(jira, { projects, members, since, until, tz, dayStartsMin }, limits) {
  const given = projects.map((p) => String(p).trim()).filter(Boolean);
  for (const key of given) {
    if (!PROJECT_KEY.test(key)) throw new UsageError(`team: project key ${JSON.stringify(key)} is not a Jira project key (letters, digits, underscore)`);
  }
  const period = { since, until, tz, dayStartsMin };
  const notes = [];
  const skipped = [];
  const events = [];
  const read = async (path) => readWithRateLimit(() => jira.get(path), limits);
  // The projects to read: the ones given, each checked for access first (a JQL naming a missing project is an error).
  const readable = new Map();
  const detail = async (key) => {
    try {
      readable.set(key, await read(`/rest/api/3/project/${encodeURIComponent(key)}`));
    } catch (e) {
      if (!unreadable(e)) throw e;
      skipped.push(`${key} (${e.status})`);
    }
  };
  await eachLimited(given, CONCURRENCY, detail);
  const scope = given.length ? `project in (${[...readable.keys()].map((k) => `"${k}"`).join(', ')}) AND ` : '';
  // A day of slack on each side: Jira reads the date in the account's time zone; the period is exact below.
  const jql = `${scope}updated >= "${addDays(since, -1)}" AND updated < "${addDays(until, 2)}"`;
  const scanned = given.length && !readable.size
    ? { issues: [], more: false }
    : await searchIssues(jira, jql, 'summary,project,assignee,updated', ISSUE_CAP);
  const issues = scanned.issues.filter((i) => inWorkingPeriod(jiraInstant(i.fields?.updated || ''), period));
  const keyOf = (issue) => issue.fields?.project?.key || issue.key.split('-')[0];
  const keys = given.length ? [...readable.keys()] : [...new Set(issues.map(keyOf))];
  if (!given.length) await eachLimited(keys, CONCURRENCY, detail);
  const rows = new Map(keys.filter((k) => readable.has(k)).map((k) => [k, { key: k, lead: null, versions: [], people: new Map() }]));
  const assigned = new Map();
  for (const issue of issues) {
    const who = issue.fields?.assignee;
    const row = rows.get(keyOf(issue));
    if (!who || !row) continue;
    const name = who.displayName || who.accountId || '';
    const person = { key: who.accountId || name, name, member: isMember(members, who.displayName, who.emailAddress, who.accountId) };
    row.people.set(person.key, person);
    assigned.set(person.key, person);
    events.push({
      id: `assigned:${issue.key}`, at: jiraInstant(issue.fields.updated), kind: 'assigned issue', action: false,
      what: issue.key, where: row.key, detail: { project: row.key, person: name, member: person.member },
    });
  }
  const now = new Date().toISOString();
  await eachLimited([...rows.values()], CONCURRENCY, async (row) => {
    const lead = readable.get(row.key).lead;
    if (lead?.displayName) {
      row.lead = { name: lead.displayName, member: isMember(members, lead.displayName, lead.emailAddress, lead.accountId) };
      events.push({
        id: `lead:${row.key}`, at: now, kind: 'project lead', action: false, snapshot: true,
        what: `${row.key}: ${row.lead.name}`, where: row.key, detail: { project: row.key, lead: row.lead.name, member: row.lead.member },
      });
    }
    let versions;
    try {
      versions = await read(`/rest/api/3/project/${encodeURIComponent(row.key)}/versions`);
    } catch (e) {
      if (!unreadable(e)) throw e;
      skipped.push(`${row.key} versions (${e.status})`);
      return;
    }
    for (const v of Array.isArray(versions) ? versions : versions?.values || []) {
      if (!v.released || !v.releaseDate || v.releaseDate < since || v.releaseDate > until) continue;
      row.versions.push(v.name);
      events.push({
        id: `version:${row.key}:${v.name}`, date: v.releaseDate, kind: 'version released', action: false,
        what: `${row.key} ${v.name}`, where: row.key, detail: { project: row.key, version: v.name },
      });
    }
  });
  notes.push(
    given.length
      ? `Jira projects: ${given.join(', ')} (team.projects)`
      : `Jira projects: those of the ${issues.length} issue(s) updated in the period that the account can see (team.projects not set)`,
    'project leads are a snapshot of now; versions released are those marked released with a release date in the period; '
      + 'people assigned are the assignees now of issues updated in the period — a person assigned earlier and since replaced is not seen',
  );
  if (scanned.more) notes.push(`issue scan cut at ${ISSUE_CAP}: the projects found and the people assigned are a lower bound`);
  if (skipped.length) notes.push(`${skipped.length} Jira read(s) refused or missing (404 gone, 403 no access) and left out: ${skipped.sort().join(', ')}`);
  const partial = [];
  if (scanned.more) partial.push(`issue scan cut at ${ISSUE_CAP}`);
  if (skipped.length) partial.push(`${skipped.length} Jira read(s) refused or missing`);
  return { events, projects: [...rows.values()], assigned, notes, partial };
}

/** A clone's label and identity: its remote's path (`owner/name`, with the host where it is not a local one), else its folder name; two clones of one remote share both. */
function repoIdentity(repo) {
  const where = repoWhere(repo);
  const remote = where.length > repo.length ? where.slice(repo.length + 1) : null;
  const at = remoteLocation(remote);
  if (!at) return { key: `dir:${repo}`, label: basename(repo), wider: `${basename(dirname(repo))}/${basename(repo)}`, where };
  return {
    key: `${at.host}:${at.path.toLowerCase()}`,
    label: at.host ? at.path : basename(at.path),
    wider: at.host ? `${at.host}/${at.path}` : `${basename(dirname(at.path))}/${basename(at.path)}`,
    where,
  };
}

/** The repositories grouped by identity, each with a label that two different repositories do not share. */
function repoGroups(repos) {
  const groups = new Map();
  for (const repo of repos) {
    const id = repoIdentity(repo);
    if (!groups.has(id.key)) groups.set(id.key, { ...id, repos: [] });
    groups.get(id.key).repos.push(repo);
  }
  const labels = new Map();
  for (const g of groups.values()) labels.set(g.label, (labels.get(g.label) || 0) + 1);
  for (const g of groups.values()) if (labels.get(g.label) > 1) g.label = g.wider;
  return [...groups.values()];
}

/**
 * The git facts of the period: per repository, author and working day. Returns `{ events, rows,
 * authors, notes }`; `rows` one `{ label, where, people }` per repository read.
 */
function gitFacts(repos, { members, since, until, tz, dayStartsMin }) {
  const limit = dateLimit(installedGitVersion(), since);
  const events = [];
  const rows = [];
  const authors = new Map();
  const failures = [];
  const seen = new Set();
  for (const group of repoGroups(repos)) {
    const days = new Map();
    const people = new Map();
    let failed = 0;
    for (const repo of group.repos) {
      let out;
      try {
        out = runGit(repo, ['log', ...REFS, ...limit, '--format=%x1e%H%x09%aI%x09%ae%x09%an']);
      } catch (e) {
        failed += 1;
        failures.push(`${group.label}: git log failed (${String(e.stderr || e.message).trim().split('\n')[0]})`);
        continue;
      }
      for (const chunk of out.split('\x1e').slice(1)) {
        // The name is last: a tab in it stays in it.
        const [hash, at, email, ...name] = chunk.trim().split('\t');
        const date = workingDate(at, { tz, dayStartsMin });
        if (date < since || date > until || seen.has(hash)) continue;
        seen.add(hash);
        const mail = email.toLowerCase();
        const author = name.join('\t');
        const member = isMember(members, author, email);
        const day = days.get(`${mail}\0${date}`) || { email: mail, date, author, commits: 0, member };
        day.commits += 1;
        days.set(`${mail}\0${date}`, day);
        people.set(mail, { key: mail, name: people.get(mail)?.name || author, member });
        authors.set(mail, { key: mail, name: authors.get(mail)?.name || author, member });
      }
    }
    if (failed === group.repos.length) continue;
    rows.push({ label: group.label, where: group.where, people });
    for (const d of days.values()) {
      events.push({
        id: `author:${group.label}:${d.email}:${d.date}`, date: d.date, kind: 'repository author', action: false,
        what: group.label, where: group.where, detail: { repo: group.label, author: d.author, email: d.email, commits: d.commits, member: d.member },
      });
    }
  }
  const notes = [
    `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} read for authors: commits by author date on the period's working days, `
      + 'branches, tags and remote-tracking branches, merges left out; names and addresses as the commits write them, one person per address; '
      + 'only what was fetched into the clones is seen',
    ...failures,
  ];
  if (failures.length && !rows.length) throw new UsageError(`team: git log failed in every repository searched; ${failures[0]}`);
  return { events, rows, authors, notes, partial: failures.length ? [`git log failed in ${failures.length} repositor${failures.length === 1 ? 'y' : 'ies'}`] : [] };
}

/**
 * The team facts of the period: Jira projects (lead, versions released, people assigned) and the git
 * authors per repository. Who counts as a team member is `members`, as the user wrote them; the
 * result never ranks anyone — rows by name, people by name, no order by a count.
 *
 * @param {{ jira?: object|null, repos?: string[], members?: string[], projects?: string[], since: string, until: string, tz: string, dayStartsMin?: number }} query
 *   `jira` an `atlassianClient` for Jira, or null (then git only); `repos` repository paths;
 *   `members` names, emails or account ids matched exactly, ignoring case; `projects` Jira project
 *   keys (none: the projects of the issues updated in the period that the account can see);
 *   `dayStartsMin` the working day's start (period.mjs)
 * @param {{ rateLimitPauseMs?: number }} [options] the wait after a 429 that names none (tests give another)
 * @returns {Promise<object>} a source result (report.mjs)
 * @throws {UsageError} when neither Jira nor a repository is given, or a read of git failed in every repository
 */
export async function collectTeam({ jira = null, repos = [], members = [], projects = [], since, until, tz, dayStartsMin = 0 }, { rateLimitPauseMs = RATE_LIMIT_PAUSE_MS } = {}) {
  if (!jira && !repos.length) throw new UsageError('team: no Jira and no repository: set up Jira, or pass --repos <a repository or a folder of repositories>');
  const rule = new Set(members.map((m) => String(m).trim().toLowerCase()).filter(Boolean));
  const query = { members: rule, since, until, tz, dayStartsMin };
  const limits = { pauseMs: rateLimitPauseMs, waits: [] };
  const events = [];
  const totals = [];
  const rows = [];
  const notes = [rule.size
    ? `counting rule (team.members, as given): ${members.join(', ')} — a person counts when a name, an email or an account id equals one of them, ignoring case`
    : 'no members rule: people seen in the period, not a team'];
  const partial = [];
  const withRule = (list) => (rule.size ? list : []);
  if (jira) {
    const found = await jiraFacts(jira, { ...query, projects }, limits);
    events.push(...found.events);
    totals.push(['projects', found.projects.length], ['versions released', found.projects.reduce((n, p) => n + p.versions.length, 0)],
      ['people assigned', found.assigned.size],
      ...withRule([['members among people assigned', [...found.assigned.values()].filter((p) => p.member).length]]));
    for (const p of found.projects) {
      rows.push({
        sort: [0, p.key], cells: [p.key, p.lead ? `${p.lead.name}${p.lead.member ? ' (member)' : ''}` : '—', p.versions.length, listPeople(p.people).join('; ') || '—'], where: p.key,
      });
    }
    partial.push(...found.partial);
    notes.push(...found.notes, ...rateLimitNotes(limits.waits, 'Jira'));
  } else {
    notes.push('Jira was not read: no project leads, versions released or people assigned');
  }
  if (repos.length) {
    const found = gitFacts(repos, query);
    events.push(...found.events);
    totals.push(['repositories', found.rows.length], ['authors', found.authors.size],
      ...withRule([['members among authors', [...found.authors.values()].filter((p) => p.member).length]]));
    for (const r of found.rows) rows.push({ sort: [1, r.label], cells: [r.label, '—', '—', listPeople(r.people).join('; ') || '—'], where: r.where });
    partial.push(...found.partial);
    notes.push(...found.notes);
  }
  notes.push('people are listed by name, never ordered by a count: the facts describe a team, not a ranking of its people');
  events.sort((a, b) => a.id.localeCompare(b.id));
  rows.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1].localeCompare(b.sort[1]));
  return {
    source: 'team',
    label: 'team facts',
    ...(partial.length ? { partial: true, partialReasons: partial } : {}),
    totals,
    events,
    breakdown: {
      title: 'per project and repository',
      header: ['Project or repository', 'Lead', 'Versions released', 'People (assigned to issues, or commit authors)'],
      rows: rows.map((r) => r.cells),
      wheres: rows.map((r) => r.where),
    },
    notes,
  };
}
