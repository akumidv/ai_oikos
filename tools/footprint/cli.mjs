#!/usr/bin/env node
// footprint: the traces a person's work left in the organization's resources over a period — local
// git clones, GitHub, GitLab, Jira, Confluence — laid on days and weeks in one time zone, with
// recorded hours (worklogs, timesheets) next to them, as one markdown report. Not a connector: each
// API source runs only where the installation lists its connector, through the shared clients. Every
// command is a read; the report goes to stdout and the caller decides where it is kept. Where the work
// was done (places) and which commits and lines are a tool's output come from the user's settings
// (places.mjs: .local/footprint/config.yaml and the --place, --default-place, --day-starts flags).
// `collect` also saves the events its sources returned into the installation's store (store.mjs), and
// `slice` reports any number of windows from the store without collecting again (ADR 0008 D01).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { runCli, required, printJson, isMain, UsageError } from '../common/cli.mjs';
import { listedConnectors } from '../common/config.mjs';
import { lookup, envValue, gitUserEmail } from '../common/env.mjs';
import { githubClient } from '../common/github.mjs';
import { gitlabClient } from '../common/gitlab.mjs';
import { atlassianCreds, atlassianClient, credsComplete, missingCreds } from '../common/atlassian.mjs';
import { HttpError, ChannelError } from '../common/http.mjs';
import { INSTALL_FILE, installRoot } from '../common/paths.mjs';
import { slugify } from '../common/slug.mjs';
import { addDays, buildReport, renderMarkdown, readTimesheets, isoDate, timeZone, localParts } from './report.mjs';
import { footprintSettings } from './places.mjs';
import { coverage, crawledMatchKeys, eventInPeriod, legacyNote, loadStore, partialNotes, recrawlNotes, replaceCrawled, saveCrawl, storeDir, storePeople, totalsFromEvents } from './store.mjs';
import { findRepos, collectGit, identifyGit, identifyGitMe } from './sources/git.mjs';
import { collectGithub, identifyGithub, identifyGithubMe } from './sources/github.mjs';
import { collectGitlab, identifyGitlab, identifyGitlabMe } from './sources/gitlab.mjs';
import { collectJira, identifyJira, identifyJiraMe } from './sources/jira.mjs';
import { collectConfluence, identifyConfluence, identifyConfluenceMe } from './sources/confluence.mjs';
import { collectSessions, hostFolders } from './sources/sessions.mjs';
import { collectTeam } from './sources/team.mjs';

const TOOL = 'footprint';
const SOURCES = ['git', 'github', 'gitlab', 'jira', 'confluence', 'sessions', 'team'];
/** What runs when --source is not given: team facts are about a team, not a person, and run only when asked for (ADR 0008 D07). */
const DEFAULT_SOURCES = SOURCES.filter((s) => s !== 'team');
/**
 * The connector an API source needs listed in `oikos.yaml`; git and sessions read this machine, and
 * team reads git and, where jira is listed with complete credentials, Jira: none of them needs one.
 */
const CONNECTOR = { github: 'github', gitlab: 'gitlab', jira: 'jira', confluence: 'confluence' };
/** The flags that name the person for each source. */
const IDENTITY = {
  git: '--email or --name (or --me: the installation\'s and each repository\'s git user.email, and the Atlassian email)',
  github: '--github <login> (or --me: the credential\'s user)',
  gitlab: '--gitlab <username> (or --me: the token\'s user)',
  jira: '--atlassian <accountId|email|name> (or --me: the credential\'s account)',
  confluence: '--atlassian <accountId|name|email — an email through Jira, where jira is listed> (or --me: the credential\'s account)',
  sessions: '--me (the transcripts on this machine are the user\'s)',
  team: 'none (facts about the team, not a person; who counts as a member is the team setting)',
};
const hasIdentity = {
  git: (v) => Boolean(v.me || v.email?.length || v.name),
  github: (v) => Boolean(v.me || v.github),
  gitlab: (v) => Boolean(v.me || v.gitlab),
  jira: (v) => Boolean(v.me || v.atlassian),
  confluence: (v) => Boolean(v.me || v.atlassian),
  sessions: (v) => Boolean(v.me),
  team: () => true,
};
/** Said when a source has no identity to run with, in place of the generic "pass <flags>". */
const NO_IDENTITY = {
  sessions: 'sessions runs with --me: the transcripts on this machine are the user\'s',
};
/** The sources that read the local clones `--repos` names. */
const READS_CLONES = ['git', 'sessions', 'team'];

function atlassian(prefix, product) {
  const c = atlassianCreds(prefix);
  if (!credsComplete(c)) throw missingCreds(c, product, 'read the footprint');
  return atlassianClient(c, TOOL);
}

/** The clients, made when a source runs: a missing credential fails that source before any request. */
const CLIENTS = {
  github: () => githubClient(TOOL),
  gitlab: () => gitlabClient(TOOL),
  jira: () => atlassian('JIRA', 'Jira'),
  confluence: () => atlassian('CONFLUENCE', 'Atlassian'),
};

/**
 * The Jira client for a source that uses Jira only where it can: the confluence source resolves an
 * email through it (Confluence finds no one by email; the site's accounts are shared) and the team
 * source reads projects through it. Present only where jira is listed and its credentials are
 * complete, else null.
 */
function optionalJira() {
  const c = atlassianCreds('JIRA');
  return listedConnectors().has('jira') && credsComplete(c) ? atlassianClient(c, TOOL) : null;
}

const notListed = (connector) => `connector ${connector} is not listed in ${INSTALL_FILE} (connectors: under a skill)`;

/** A failure as one line for the notes: its first line, and the keys a credential help names as missing. */
function reasonOf(e) {
  const [first, ...rest] = String(e.message).split('\n');
  const missing = rest.map((l) => l.match(/^\s+(\S+)\s+missing$/)?.[1]).filter(Boolean);
  const line = first.length > 240 ? `${first.slice(0, 239)}…` : first;
  return missing.length ? `${line} (missing: ${missing.join(', ')})` : line;
}

/**
 * Run one source's `task` unless its connector is not listed: its result, or `{ source, skipped }`
 * when it failed the way a source can (no credential, no identity, no access, a remote error) —
 * the other sources still run. Any other error is a bug and propagates.
 */
async function attempt(source, task) {
  const connector = CONNECTOR[source];
  if (connector && !listedConnectors().has(connector)) return { source, skipped: notListed(connector) };
  try {
    return await task();
  } catch (e) {
    if (e instanceof UsageError || e instanceof HttpError || e instanceof ChannelError || e?.name === 'NoInstallation') {
      return { source, skipped: reasonOf(e) };
    }
    throw e;
  }
}

/** The sources --source names (comma-separated), every one but team by default. */
function sourceList(value) {
  if (!value) return DEFAULT_SOURCES;
  const named = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = named.filter((s) => !SOURCES.includes(s));
  if (unknown.length || !named.length) throw new UsageError(`--source takes ${SOURCES.join(', ')}; got: ${value}`);
  return SOURCES.filter((s) => named.includes(s));
}

/**
 * The user's git email as the installation sets it: `git config user.email` read in the
 * installation's root, not in the working folder (whose repository may set another address).
 */
const installationGitEmail = () => gitUserEmail(installRoot() || undefined);

/**
 * The git authors to match: --email and --name, and with --me the installation's git email and the
 * Atlassian email of each Atlassian connector the installation lists (none is read where none is
 * listed). Each repository's own git email is added by the git source (`meEmails`).
 */
function gitAuthors(v) {
  const authors = [...(v.email || []), ...(v.name ? [v.name] : [])];
  if (v.me) {
    const listed = listedConnectors();
    const atlassianEmails = [['jira', 'JIRA'], ['confluence', 'CONFLUENCE']]
      .filter(([connector]) => listed.has(connector)).map(([, prefix]) => atlassianCreds(prefix).email);
    authors.push(...[installationGitEmail(), ...atlassianEmails].filter(Boolean));
  }
  return [...new Set(authors.map((a) => a.trim()).filter(Boolean))];
}

/**
 * Who a source's events are of, as one text a crawl records and a later crawl compares: the git
 * authors, the login or account the user gave, or `--me`; null for a source with no identity (team).
 *
 * @param {string} source
 * @param {object} v the parsed flags
 * @returns {string|null}
 */
function identityOf(source, v) {
  const given = { github: v.github, gitlab: v.gitlab, jira: v.atlassian, confluence: v.atlassian };
  if (source === 'git') return gitAuthors(v).sort().join(', ') || null;
  if (source === 'sessions') return '--me';
  if (source === 'team') return null;
  return v.me ? '--me' : given[source] || null;
}

/** Whether each credential or setting a source reads is present, and where from — never a value. */
function credentialStates(source) {
  const state = (name) => {
    const { source: from } = lookup(name);
    return from ? `set (${from})` : 'missing';
  };
  if (source === 'github') {
    return {
      GITHUB_TOKEN: lookup('GITHUB_TOKEN').source ? state('GITHUB_TOKEN') : 'missing (the gh login is tried when collecting)',
      GITHUB_ORG: lookup('GITHUB_ORG').source ? state('GITHUB_ORG') : 'not set: the whole of GitHub is read',
    };
  }
  if (source === 'gitlab') return { GITLAB_URL: state('GITLAB_URL'), GITLAB_TOKEN: state('GITLAB_TOKEN') };
  if (source === 'jira' || source === 'confluence') {
    const prefix = source === 'jira' ? 'JIRA' : 'CONFLUENCE';
    const creds = atlassianCreds(prefix);
    // atlassianCreds reads <prefix>_<part>, else JIRA_<part>: the one that is set is named.
    const nameOf = (part) => (lookup(`${prefix}_${part}`).source ? `${prefix}_${part}` : `JIRA_${part}`);
    const out = Object.fromEntries(['BASE_URL', 'EMAIL', 'API_TOKEN'].map((part) => [nameOf(part), state(nameOf(part))]));
    const email = nameOf('EMAIL');
    if (!creds.email) out[email] = lookup(email).source ? 'set, but not an address of the organization' : 'missing';
    else if (!lookup(email).source) out[email] = 'from git config user.email';
    return out;
  }
  return {};
}

/**
 * Where each agent host's transcripts are looked for and whether each folder exists — the folders
 * only, no file in them is opened. `false` in the settings is off; none given is the host's default
 * (`hostFolders`). A host is `found` when any of its folders exists (Codex has two).
 *
 * @param {Record<string, string|false|null>} hosts the `sessions` setting
 * @returns {{ host: string, folders: { folder: string, state: 'found'|'not found' }[], state: string }[]}
 */
function sessionHostStates(hosts) {
  const where = { env: process.env, home: homedir() };
  return Object.entries(hosts).map(([host, given]) => {
    const folders = hostFolders(host, given, where);
    if (folders === null) return { host, folders: [], state: 'off' };
    const states = folders.map((folder) => ({ folder, state: existsSync(folder) ? 'found' : 'not found' }));
    return { host, folders: states, state: states.some((f) => f.state === 'found') ? 'found' : 'not found' };
  });
}

/** One host's state as a line of the `sources` text: `codex found (<sessions> found, <archived> not found)`. */
function hostLine({ host, folders, state }) {
  if (folders.length <= 1) return `${host} ${state}${folders.length ? ` (${folders[0].folder})` : ''}`;
  return `${host} ${state} (${folders.map((f) => `${f.folder} ${f.state}`).join(', ')})`;
}

/** The person the store keeps a run's events under: --person, else `me` with --me, else the first identity flag. */
const storePerson = (v) => v.person || (v.me ? 'me' : null) || v.name || v.github || v.gitlab || v.atlassian || v.email?.[0] || 'unknown';

/**
 * Tell, on stderr and in the report's notes of the source, that a crawl replaces events another
 * scope (`--repos`, identity) collected over an overlapping period. A note only: nothing is blocked.
 * Adds the notes to `results`.
 *
 * @param {object[]} crawls the store's crawl lines before this run's
 * @param {object[]} results the source results
 * @param {{ since: string, until: string }} period
 * @param {Record<string, { repos: string[]|null, identity: string|null }>} scopes
 */
function tellRecrawls(crawls, results, period, scopes) {
  for (const { source, note } of recrawlNotes(crawls, results, period, scopes)) {
    console.error(`${TOOL}: ${note}`);
    const result = results.find((r) => r.source === source);
    result.notes = [...(result.notes || []), note];
  }
}

/** Tell, on stderr and in the notes of its source, that a partial crawl is merged by id: same-id events replaced, nothing else dropped. Adds the notes to `results`. */
function tellPartials(results) {
  for (const { source, note } of partialNotes(results)) {
    console.error(`${TOOL}: ${note}`);
    const result = results.find((r) => r.source === source);
    result.notes = [...(result.notes || []), note];
  }
}

/** Tell, on stderr and in the notes of `source`, how many stored events without a transcript file its crawl replaced (none: nothing). */
function tellLegacy(results, source, legacy) {
  if (!legacy) return;
  const note = legacyNote(legacy);
  console.error(`${TOOL}: ${source}: ${note}`);
  const result = results.find((r) => r.source === source);
  result.notes = [...(result.notes || []), note];
}

/**
 * Tell, when the team source ran without --person, that its events are saved under the person of the
 * other flags (`me`, or whatever names one) — beside that person's own — and suggest --person <team>.
 * Adds the note to the team result.
 *
 * @param {object[]} results the source results
 * @param {object} v the parsed flags
 * @param {string} dir the store folder the run saves into
 */
function tellTeamStore(results, v, dir) {
  const team = results.find((r) => r.source === 'team' && !r.skipped);
  if (!team || v.person) return;
  const note = `team: its events are saved under ${basename(dir)} (no --person) beside that person's own; pass --person <team> to keep the team's facts apart`;
  console.error(`${TOOL}: ${note}`);
  team.notes = [...(team.notes || []), note];
}

/**
 * Save this run's events into the person's store folder (unless --no-save) and return every event
 * the store then holds — what the report's sections that link across the whole history read. With
 * nothing saved (--no-save, no installation, a name no folder can be made of) the history is the
 * store as it is with this run's events laid over it in memory, so the store stays untouched.
 *
 * @param {object[]} results the source results
 * @param {{ since: string, until: string, tz: string, dayStartsMin: number }} period
 * @param {object} v the parsed flags
 * @param {Record<string, { repos: string[]|null, identity: string|null }>} scopes per source: the clones read and who the events are of
 * @returns {object[]} the history, each event with its `source`
 */
function keepEvents(results, period, v, scopes) {
  const ran = results.filter((r) => !r.skipped);
  tellPartials(results);
  const { dir, note } = storeFolder(v);
  const saving = ran.length > 0 && !v['no-save'] && dir !== null;
  if (saving) {
    tellRecrawls(loadStore(dir).crawls, results, period, scopes);
    tellTeamStore(results, v, dir);
    for (const { source, legacy } of saveCrawl(dir, results, period, scopes)) tellLegacy(results, source, legacy);
  }
  else if (ran.length && !v['no-save']) console.error(`${TOOL}: not saved: ${note}`);
  const events = new Map(dir ? loadStore(dir).events : []);
  if (!saving) layOver(events, ran, period, results);
  return [...events.values()].flat();
}

/** Lay the events of the sources that ran over `events` (per source) in memory, as saving would, telling what it replaced. */
function layOver(events, ran, period, results) {
  for (const r of ran) {
    const replaced = replaceCrawled(events.get(r.source) || [], r, period);
    events.set(r.source, replaced.events);
    tellLegacy(results, r.source, replaced.legacy);
  }
}

/** The person's store folder for `collect`, or why there is none: no installation, or a name no folder can be made of. */
function storeFolder(v) {
  if (!installRoot()) return { dir: null, note: 'no installation' };
  try {
    return { dir: storeDir(storePerson(v)), note: null };
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    return { dir: null, note: e.message };
  }
}

/** The folder name of the person `slice` reads: --person's, else the only one in the store, else `me`; null for an empty store. */
function slicePerson(person) {
  const people = storePeople();
  if (person) {
    storeDir(person);
    return slugify(person);
  }
  if (people.length <= 1) return people[0] || null;
  if (people.includes('me')) return 'me';
  throw new UsageError(`the store holds several people (${people.join(', ')}): pass --person`);
}

const MAX_WINDOW_DAYS = 3660;

/** A --window as its first and last date: N days ending at `until`, or a start date through `until`. */
function windowOf(text, until) {
  if (/^\d+$/.test(text)) {
    const days = Number(text);
    if (days < 1 || days > MAX_WINDOW_DAYS) throw new UsageError(`--window takes 1 to ${MAX_WINDOW_DAYS} days; got: ${text}`);
    return { since: addDays(until, 1 - days), until };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new UsageError(`--window takes a number of days or a start date YYYY-MM-DD; got: ${text}`);
  const since = isoDate(text, 'window');
  if (since > until) throw new UsageError(`--window ${since} starts after --until ${until}`);
  return { since, until };
}

/** Consecutive dates as ranges: `2026-03-01 … 2026-03-03, 2026-03-07`. */
function rangesOf(dates) {
  const ranges = [];
  let start = dates[0];
  let last = dates[0];
  for (const d of [...dates.slice(1), null]) {
    if (d !== null && d === addDays(last, 1)) { last = d; continue; }
    ranges.push(start === last ? start : `${start} … ${last}`);
    start = d;
    last = d;
  }
  return ranges.join(', ');
}

/** The sources a store holds events or a crawl of, in the order of SOURCES. */
function storedSources(store) {
  const names = new Set([...store.events.keys(), ...store.crawls.filter((c) => !c.skipped).map((c) => c.source)]);
  const rank = (s) => (SOURCES.includes(s) ? SOURCES.indexOf(s) : SOURCES.length);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * One source's stored events as a source result for the window `period`: the events whose working
 * day is in it and every snapshot, totals counted from them, the hours events as `hours`, and a note
 * for the dates no crawl covered. `remotes` (git) and `sites` (a code host) are rebuilt from the
 * source's crawl rows, so the report tells a code host's copy of a commit here as it does in `collect`.
 */
function sliceResult(source, store, period) {
  const stored = store.events.get(source) || [];
  const events = stored.filter((e) => e.kind !== 'hours' && (e.snapshot || eventInPeriod(e, period)));
  const hours = new Map(stored.filter((e) => e.kind === 'hours' && typeof e.detail?.hours === 'number' && e.date >= period.since && e.date <= period.until)
    .map((e) => [e.date, e.detail.hours]));
  const missing = coverage(store.crawls, source, period.since, period.until);
  const { remotes, sites } = crawledMatchKeys(store.crawls, source);
  return {
    source, label: `${source} (stored)`, totals: totalsFromEvents(source, events), events, hours,
    ...(source === 'git' ? { remotes } : {}),
    ...(sites.length ? { sites } : {}),
    notes: missing.length ? [`no crawl of ${source} covered ${rangesOf(missing)}`] : [],
  };
}

/** `team.members` and `team.projects` as one line, as the user wrote them; null when neither is set. */
function teamRule({ members, projects }) {
  const parts = [...(members.length ? [`members: ${members.join(', ')}`] : []), ...(projects.length ? [`projects: ${projects.join(', ')}`] : [])];
  return parts.length ? parts.join('; ') : null;
}

const commands = {
  sources: {
    help: 'what each source needs here: its connector listed, credentials present (never their values), the identity flags — no request; '
      + 'sessions: each agent host\'s transcript folder found, not found or off (no file is read); team: what it reads and when it runs',
    options: {},
    async run(v) {
      const listed = listedConnectors();
      const { sessions } = footprintSettings();
      const rows = SOURCES.map((source) => ({
        source,
        connector: CONNECTOR[source] || null,
        listed: CONNECTOR[source] ? listed.has(CONNECTOR[source]) : null,
        // A source that is not collected is not looked into: none of its credentials is read.
        // Team reads Jira only where it is listed, so only then are its credentials looked at.
        credentials: (CONNECTOR[source] && !listed.has(CONNECTOR[source])) || (source === 'team' && !listed.has('jira'))
          ? null : credentialStates(source === 'team' ? 'jira' : source),
        identity: IDENTITY[source],
        ...(source === 'sessions' ? { hosts: sessionHostStates(sessions) } : {}),
      }));
      if (v.json) return printJson(rows);
      for (const r of rows) {
        if (r.listed === false) { console.log(`${r.source.padEnd(11)} not collected — ${notListed(r.connector)}`); continue; }
        const creds = Object.entries(r.credentials || {}).map(([k, s]) => `${k} ${s}`).join(', ');
        const where = {
          sessions: `agent transcripts on this machine: ${r.hosts?.map(hostLine).join(', ')}`,
          team: 'only with --source team: git authors per repository (--repos), Jira projects where jira is listed',
        }[r.source] || (r.connector ? 'listed' : 'local clones (--repos <a repository or a folder of repositories>)');
        console.log(`${r.source.padEnd(11)} ${where}${creds ? `; ${creds}` : ''}\n${' '.repeat(12)}identity: ${r.identity}`);
      }
    },
  },

  identify: {
    help: 'who a person is in each source (--name "Ada Lovelace" [--repos dir …]): git authors, GitLab, Jira and Confluence users, GitHub users by public name; '
      + 'or who the user is (--me [--repos dir …]): each credential\'s own account, the installation\'s and each repository\'s git user.email',
    options: { name: { type: 'string' }, me: { type: 'boolean' }, repos: { type: 'string', multiple: true } },
    async run(v) {
      if (!v.me) required(v, 'name');
      if (v.me && v.name) throw new UsageError('identify takes --name or --me, not both');
      const repos = v.repos?.length ? findRepos(v.repos) : [];
      const results = await Promise.all(v.me ? [
        attempt('git', async () => ({
          source: 'git', candidates: identifyGitMe(repos, installationGitEmail()),
          note: 'the installation\'s git user.email and each repository\'s own; their commits counted in --repos',
        })),
        attempt('gitlab', async () => ({ source: 'gitlab', candidates: await identifyGitlabMe(CLIENTS.gitlab()) })),
        attempt('jira', async () => ({ source: 'jira', candidates: await identifyJiraMe(CLIENTS.jira()) })),
        attempt('confluence', async () => ({ source: 'confluence', candidates: await identifyConfluenceMe(CLIENTS.confluence(), optionalJira()) })),
        attempt('github', async () => ({ source: 'github', candidates: await identifyGithubMe(CLIENTS.github()) })),
      ] : [
        attempt('git', async () => ({ source: 'git', candidates: identifyGit(repos, v.name) })),
        attempt('gitlab', async () => ({ source: 'gitlab', candidates: await identifyGitlab(CLIENTS.gitlab(), v.name) })),
        attempt('jira', async () => ({ source: 'jira', candidates: await identifyJira(CLIENTS.jira(), v.name) })),
        attempt('confluence', async () => ({ source: 'confluence', candidates: await identifyConfluence(CLIENTS.confluence(), v.name) })),
        attempt('github', async () => ({
          source: 'github', candidates: await identifyGithub(CLIENTS.github(), v.name),
          note: 'GitHub searches the public profile name only: a person without one is not found',
        })),
      ]);
      if (v.json) return printJson(results);
      const line = {
        git: (c) => (c.commits === null ? `${'—'.padStart(6)} commit(s)  ${c.name ? `${c.name} ` : ''}<${c.email}>  ${repos.length ? 'in no repository searched' : '(no --repos: not counted)'}`
          : `${String(c.commits).padStart(6)} commit(s)  ${c.name} <${c.email}>  in ${c.repositories} repositor${c.repositories === 1 ? 'y' : 'ies'}`),
        gitlab: (c) => `@${c.username}  ${c.name}  ${c.state}  ${c.url}`,
        jira: (c) => `${c.accountId}  ${c.name}${c.email ? `  ${c.email}` : ''}${c.active ? '' : '  (inactive)'}`,
        confluence: (c) => `${c.accountId}  ${c.name}${c.email ? `  ${c.email}` : ''}`,
        github: (c) => `${c.login}  ${c.url}`,
      };
      for (const r of results) {
        if (r.skipped) { console.log(`${r.source}: not searched — ${r.skipped}`); continue; }
        console.log(`${r.source}: ${r.candidates.length ? '' : 'none found'}`);
        for (const c of r.candidates) console.log(`  ${line[r.source](c)}`);
        if (r.note) console.log(`  (${r.note})`);
      }
      console.log(v.me ? 'collect --me takes these; pass another with --email/--name (git), --github, --gitlab, --atlassian (jira, confluence).'
        : 'Pass the right ones to collect: --email/--name (git), --github, --gitlab, --atlassian (jira, confluence).');
    },
  },

  collect: {
    help: 'the footprint of a person over a period, markdown on stdout (--since YYYY-MM-DD [--until, default today] [--tz IANA] '
      + '[--me | --email a@x … --name "git author" --github login --gitlab username --atlassian accountId|name|email (Confluence: an email through Jira)] '
      + '[--repos dir …] [--source git,github,gitlab,jira,confluence,sessions,team (default: all but team)] [--hours file.csv …] [--by day|week] [--person "display name"] '
      + '[--purpose "what the report is for"] [--uncommitted (git: the clones\' uncommitted and untracked lines, as a fact)] '
      + '[--no-save (the events are saved into .local/footprint/events/<person>/ for `slice` unless this is given)] '
      + '[--config file.yaml (default .local/footprint/config.yaml)] [--place label=pattern[,pattern] …] [--default-place label] [--day-starts HH:MM]); '
      + 'a place pattern is a case-insensitive substring of a repository\'s path or remote, owner/repo, a GitLab project path, a Jira project key or a space key, '
      + '--place tried before the file\'s places; what none names is the default place (else organization.name); '
      + 'sessions (the agent transcripts on this machine) runs with --me and reads --repos to name each session\'s repository; '
      + 'team (facts about a team, never a ranking) runs only when --source names it',
    options: {
      since: { type: 'string' }, until: { type: 'string' }, tz: { type: 'string' },
      me: { type: 'boolean' }, email: { type: 'string', multiple: true }, name: { type: 'string' },
      github: { type: 'string' }, gitlab: { type: 'string' }, atlassian: { type: 'string' },
      repos: { type: 'string', multiple: true }, source: { type: 'string' }, hours: { type: 'string', multiple: true },
      by: { type: 'string' }, person: { type: 'string' }, purpose: { type: 'string' },
      uncommitted: { type: 'boolean' }, 'no-save': { type: 'boolean' },
      config: { type: 'string' }, place: { type: 'string', multiple: true }, 'default-place': { type: 'string' }, 'day-starts': { type: 'string' },
    },
    async run(v) {
      required(v, 'since');
      const tz = timeZone(v.tz);
      const since = isoDate(v.since, 'since');
      const until = v.until ? isoDate(v.until, 'until') : localParts(Date.now(), tz).date;
      if (until < since) throw new UsageError(`--until ${until} is before --since ${since}`);
      if (v.by && !['day', 'week'].includes(v.by)) throw new UsageError(`--by takes day or week; got: ${v.by}`);
      const wanted = sourceList(v.source);
      const timesheets = readTimesheets(v.hours || []);
      // The user's settings, read once here: places, skipped commits, generated paths, pipeline repositories, the working day.
      const settings = footprintSettings({
        file: v.config, places: v.place || [], defaultPlace: v['default-place'], dayStarts: v['day-starts'],
      });
      // --repos is looked into only when a source that reads the clones is collected.
      const repos = wanted.some((s) => READS_CLONES.includes(s)) && v.repos?.length ? findRepos(v.repos) : [];
      const period = { since, until, tz };
      // Every source keeps an action by its working day (day_starts), as the report lays it.
      const sourcePeriod = { ...period, dayStartsMin: settings.dayStartsMin };
      const { skipCommits, generated, pipelineRepos, decisionDirs, decisionCodes, decisionHeadings, releases, team } = settings;
      const tasks = {
        git: () => collectGit(repos, {
          authors: gitAuthors(v), meEmails: Boolean(v.me), skipCommits, generated, pipelineRepos,
          decisionDirs, codes: decisionCodes, uncommitted: Boolean(v.uncommitted), ...sourcePeriod,
        }),
        github: () => collectGithub(CLIENTS.github(), { login: v.github, me: v.me, org: envValue('GITHUB_ORG') || null, releases, ...sourcePeriod }),
        gitlab: () => collectGitlab(CLIENTS.gitlab(), { username: v.gitlab, me: v.me, ...sourcePeriod }),
        jira: () => collectJira(CLIENTS.jira(), { who: v.atlassian, me: v.me, ...sourcePeriod }),
        confluence: () => collectConfluence(CLIENTS.confluence(), {
          who: v.atlassian, me: v.me, jira: v.atlassian?.includes('@') ? optionalJira() : null, ...sourcePeriod,
        }),
        sessions: () => collectSessions({
          hosts: settings.sessions, repos, headings: decisionHeadings, codes: decisionCodes, skipPrompts: settings.sessionsSkipPrompts, ...sourcePeriod,
        }, { env: process.env, home: homedir() }),
        team: () => collectTeam({ jira: optionalJira(), repos, members: team.members, projects: team.projects, ...sourcePeriod }),
      };
      const run = (source) => attempt(source, async () => {
        if (!hasIdentity[source](v)) throw new UsageError(NO_IDENTITY[source] || `no identity: pass ${IDENTITY[source]}`);
        return tasks[source]();
      });
      // The transcript reader grows memory while git's synchronous child processes run in the same
      // process, which slowed both several times over: it runs after the other sources, not beside them.
      const byName = new Map(await Promise.all(wanted.filter((s) => s !== 'sessions').map(async (s) => [s, await run(s)])));
      if (wanted.includes('sessions')) byName.set('sessions', await run('sessions'));
      const results = wanted.map((source) => byName.get(source));
      const scopes = Object.fromEntries(wanted.map((source) => [source, { repos: READS_CLONES.includes(source) ? repos : null, identity: identityOf(source, v) }]));
      const history = keepEvents(results, sourcePeriod, v, scopes);
      const report = buildReport(results, {
        ...period, timesheets, settings, history,
        factSettings: { readingReference: settings.readingReference, teamRule: teamRule(team) },
      });
      const now = localParts(Date.now(), tz);
      const person = v.person || v.name || v.github || v.gitlab || v.atlassian || v.email?.[0] || (v.me ? 'me' : 'unknown');
      const collectedAt = `${now.date} ${now.time}`;
      const purpose = v.purpose?.trim() || null;
      if (v.json) printJson({ person, purpose, collectedAt, ...report });
      else process.stdout.write(renderMarkdown(report, { person, by: v.by, collectedAt, purpose }));
      if (!report.sources.length) {
        console.error(`${TOOL}: no source ran — the Notes say why for each`);
        return 1;
      }
    },
  },

  slice: {
    help: 'one report per window from the events `collect` saved, without collecting again '
      + '(--window <days|YYYY-MM-DD> …, repeatable and required: a number is that many days ending at --until, a date is that day to --until; '
      + '[--until YYYY-MM-DD, default today] [--tz IANA] [--person "name" (default: the only person in the store, else me)] [--by day|week] '
      + '[--hours file.csv …] [--purpose "what the report is for"] [--config file.yaml] [--place label=pattern[,pattern] …] [--default-place label] [--day-starts HH:MM] '
      + '[--out dir (write <dir>/<person>-<since>-<until>.md per window and print the paths, instead of stdout)] [--json]); '
      + 'places and the working day are read from the settings now, totals per source are counted from the events, '
      + 'and a window no crawl of a source covered is named in the Notes; exits 1 when the store holds no event',
    options: {
      window: { type: 'string', multiple: true }, until: { type: 'string' }, tz: { type: 'string' }, person: { type: 'string' },
      by: { type: 'string' }, hours: { type: 'string', multiple: true }, purpose: { type: 'string' }, out: { type: 'string' },
      config: { type: 'string' }, place: { type: 'string', multiple: true }, 'default-place': { type: 'string' }, 'day-starts': { type: 'string' },
    },
    async run(v) {
      if (!v.window?.length) throw new UsageError('slice needs --window <days|YYYY-MM-DD> (repeatable), e.g. --window 7 --window 30 or --window 2026-01-01');
      const tz = timeZone(v.tz);
      const until = v.until ? isoDate(v.until, 'until') : localParts(Date.now(), tz).date;
      const windows = v.window.map((w) => windowOf(w, until));
      if (v.by && !['day', 'week'].includes(v.by)) throw new UsageError(`--by takes day or week; got: ${v.by}`);
      const timesheets = readTimesheets(v.hours || []);
      const settings = footprintSettings({
        file: v.config, places: v.place || [], defaultPlace: v['default-place'], dayStarts: v['day-starts'],
      });
      const folder = slicePerson(v.person);
      const store = loadStore(folder ? storeDir(folder) : '');
      const stored = [...store.events.values()].flat();
      if (!stored.length) {
        console.error(`${TOOL}: the store holds no event${v.person ? ` for ${v.person}` : ''} — run collect first (events are saved unless --no-save)`);
        return 1;
      }
      if (store.bad) console.error(`${TOOL}: ${store.bad} unreadable line(s) in the store skipped`);
      const person = v.person || folder;
      const factSettings = { readingReference: settings.readingReference, teamRule: teamRule(settings.team) };
      const now = localParts(Date.now(), tz);
      const collectedAt = `${now.date} ${now.time}`;
      const purpose = v.purpose?.trim() || null;
      const reports = windows.map(({ since, until: end }) => {
        const period = { since, until: end, tz, dayStartsMin: settings.dayStartsMin };
        const results = storedSources(store).map((source) => sliceResult(source, store, period));
        if (store.bad) for (const r of results) r.notes.push(`${store.bad} unreadable line(s) in the store skipped`);
        return { since, until: end, report: buildReport(results, { since, until: end, tz, timesheets, settings, history: stored, factSettings }) };
      });
      const render = ({ report }) => (v.json ? { person, purpose, collectedAt, ...report }
        : renderMarkdown(report, { person, by: v.by, collectedAt, purpose }));
      if (v.out) printPaths(writeReports(reports.map((r) => ({ name: `${folder}-${r.since}-${r.until}`, content: render(r) })), v.out), v.json);
      else if (v.json) printJson(reports.map(render));
      else process.stdout.write(reports.map(render).join('\n---\n\n'));
    },
  },
};

/** Write each report into `dir` (made when missing) as `<name>.md`, or `<name>.json` for a report that is an object; the paths. */
function writeReports(reports, dir) {
  mkdirSync(dir, { recursive: true });
  return reports.map(({ name, content }) => {
    const file = join(dir, `${name}.${typeof content === 'string' ? 'md' : 'json'}`);
    writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    return file;
  });
}

/** The paths written: one a line, or a JSON array with --json. */
function printPaths(files, json) {
  if (json) printJson(files);
  else for (const file of files) console.log(file);
}

/**
 * A stray positional is an error here: no footprint command takes one, and `--repos a b c` would
 * otherwise search `a` only, the other values dropped by the parser without a word.
 *
 * @param {string[]} positionals the values the parser left over, in order
 * @throws {UsageError} naming the values
 */
export function rejectPositionals(positionals) {
  if (!positionals.length) return;
  throw new UsageError(`unexpected argument${positionals.length === 1 ? '' : 's'}: ${positionals.join(', ')} — `
    + 'a flag takes one value, so repeat it for each (--repos a --repos b)');
}

/** `table` with each command's run refusing stray positionals first. */
const withoutPositionals = (table) => Object.fromEntries(Object.entries(table).map(([name, command]) => [
  name, { ...command, run: (v, positionals) => { rejectPositionals(positionals); return command.run(v); } },
]));

if (isMain(import.meta.url)) runCli(TOOL, withoutPositionals(commands));
