#!/usr/bin/env node
// footprint: the traces a person's work left in the organization's resources over a period — local
// git clones, GitHub, GitLab, Jira, Confluence — laid on days and weeks in one time zone, with
// recorded hours (worklogs, timesheets) next to them, as one markdown report. Not a connector: each
// API source runs only where the installation lists its connector, through the shared clients. Every
// command is a read; the report goes to stdout and the caller decides where it is kept. Where the work
// was done (places) and which commits and lines are a tool's output come from the user's settings
// (places.mjs: .local/footprint/config.yaml and the --place, --default-place, --day-starts flags).
import { runCli, required, printJson, isMain, UsageError } from '../common/cli.mjs';
import { listedConnectors } from '../common/config.mjs';
import { lookup, envValue, gitUserEmail } from '../common/env.mjs';
import { githubClient } from '../common/github.mjs';
import { gitlabClient } from '../common/gitlab.mjs';
import { atlassianCreds, atlassianClient, credsComplete, missingCreds } from '../common/atlassian.mjs';
import { HttpError, ChannelError } from '../common/http.mjs';
import { INSTALL_FILE, installRoot } from '../common/paths.mjs';
import { buildReport, renderMarkdown, readTimesheets, isoDate, timeZone, localParts } from './report.mjs';
import { footprintSettings } from './places.mjs';
import { findRepos, collectGit, identifyGit, identifyGitMe } from './sources/git.mjs';
import { collectGithub, identifyGithub, identifyGithubMe } from './sources/github.mjs';
import { collectGitlab, identifyGitlab, identifyGitlabMe } from './sources/gitlab.mjs';
import { collectJira, identifyJira, identifyJiraMe } from './sources/jira.mjs';
import { collectConfluence, identifyConfluence, identifyConfluenceMe } from './sources/confluence.mjs';

const TOOL = 'footprint';
const SOURCES = ['git', 'github', 'gitlab', 'jira', 'confluence'];
/** The connector an API source needs listed in `oikos.yaml`; git reads local clones and needs none. */
const CONNECTOR = { github: 'github', gitlab: 'gitlab', jira: 'jira', confluence: 'confluence' };
/** The flags that name the person for each source. */
const IDENTITY = {
  git: '--email or --name (or --me: the installation\'s and each repository\'s git user.email, and the Atlassian email)',
  github: '--github <login> (or --me: the credential\'s user)',
  gitlab: '--gitlab <username> (or --me: the token\'s user)',
  jira: '--atlassian <accountId|email|name> (or --me: the credential\'s account)',
  confluence: '--atlassian <accountId|name|email — an email through Jira, where jira is listed> (or --me: the credential\'s account)',
};
const hasIdentity = {
  git: (v) => Boolean(v.me || v.email?.length || v.name),
  github: (v) => Boolean(v.me || v.github),
  gitlab: (v) => Boolean(v.me || v.gitlab),
  jira: (v) => Boolean(v.me || v.atlassian),
  confluence: (v) => Boolean(v.me || v.atlassian),
};

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
 * The Jira client that resolves an email for the confluence source (Confluence finds no one by
 * email; the site's accounts are shared): only where jira is listed and its credentials are complete.
 */
function jiraForEmail() {
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

/** The sources --source names (comma-separated), every one by default. */
function sourceList(value) {
  if (!value) return SOURCES;
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

const commands = {
  sources: {
    help: 'what each source needs here: its connector listed, credentials present (never their values), the identity flags — no request',
    options: {},
    async run(v) {
      const listed = listedConnectors();
      const rows = SOURCES.map((source) => ({
        source,
        connector: CONNECTOR[source] || null,
        listed: CONNECTOR[source] ? listed.has(CONNECTOR[source]) : null,
        // A source that is not collected is not looked into: none of its credentials is read.
        credentials: CONNECTOR[source] && !listed.has(CONNECTOR[source]) ? null : credentialStates(source),
        identity: IDENTITY[source],
      }));
      if (v.json) return printJson(rows);
      for (const r of rows) {
        if (r.listed === false) { console.log(`${r.source.padEnd(11)} not collected — ${notListed(r.connector)}`); continue; }
        const creds = Object.entries(r.credentials).map(([k, s]) => `${k} ${s}`).join(', ');
        const where = r.connector ? 'listed' : 'local clones (--repos <a repository or a folder of repositories>)';
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
        attempt('confluence', async () => ({ source: 'confluence', candidates: await identifyConfluenceMe(CLIENTS.confluence(), jiraForEmail()) })),
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
      + '[--repos dir …] [--source git,github,gitlab,jira,confluence] [--hours file.csv …] [--by day|week] [--person "display name"] '
      + '[--purpose "what the report is for"] '
      + '[--config file.yaml (default .local/footprint/config.yaml)] [--place label=pattern[,pattern] …] [--default-place label] [--day-starts HH:MM]); '
      + 'a place pattern is a case-insensitive substring of a repository\'s path or remote, owner/repo, a GitLab project path, a Jira project key or a space key, '
      + '--place tried before the file\'s places; what none names is the default place (else organization.name)',
    options: {
      since: { type: 'string' }, until: { type: 'string' }, tz: { type: 'string' },
      me: { type: 'boolean' }, email: { type: 'string', multiple: true }, name: { type: 'string' },
      github: { type: 'string' }, gitlab: { type: 'string' }, atlassian: { type: 'string' },
      repos: { type: 'string', multiple: true }, source: { type: 'string' }, hours: { type: 'string', multiple: true },
      by: { type: 'string' }, person: { type: 'string' }, purpose: { type: 'string' },
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
      // --repos is looked into only when git is collected.
      const repos = wanted.includes('git') && v.repos?.length ? findRepos(v.repos) : [];
      const period = { since, until, tz };
      // Every source keeps an action by its working day (day_starts), as the report lays it.
      const sourcePeriod = { ...period, dayStartsMin: settings.dayStartsMin };
      const { skipCommits, generated, pipelineRepos } = settings;
      const tasks = {
        git: () => collectGit(repos, { authors: gitAuthors(v), meEmails: Boolean(v.me), skipCommits, generated, pipelineRepos, ...sourcePeriod }),
        github: () => collectGithub(CLIENTS.github(), { login: v.github, me: v.me, org: envValue('GITHUB_ORG') || null, ...sourcePeriod }),
        gitlab: () => collectGitlab(CLIENTS.gitlab(), { username: v.gitlab, me: v.me, ...sourcePeriod }),
        jira: () => collectJira(CLIENTS.jira(), { who: v.atlassian, me: v.me, ...sourcePeriod }),
        confluence: () => collectConfluence(CLIENTS.confluence(), {
          who: v.atlassian, me: v.me, jira: v.atlassian?.includes('@') ? jiraForEmail() : null, ...sourcePeriod,
        }),
      };
      const results = await Promise.all(wanted.map((source) => attempt(source, async () => {
        if (!hasIdentity[source](v)) throw new UsageError(`no identity: pass ${IDENTITY[source]}`);
        return tasks[source]();
      })));
      const report = buildReport(results, { ...period, timesheets, settings });
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
};

if (isMain(import.meta.url)) runCli(TOOL, commands);
