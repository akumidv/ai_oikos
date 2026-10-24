#!/usr/bin/env node
// GitHub issues as the task tracker (skill task-tracking): issues, search, the organization's
// projects (Projects v2) and their iterations; create, edit, comment, move a status, move to an
// iteration and link, each under guards and each with --dry-run. The status comes from the Status
// field of the project in GITHUB_PROJECT, else from labels.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, required, printJson, UsageError, isMain } from '../common/cli.mjs';
import { guardOutgoing, outgoingRules } from '../common/outgoing.mjs';
import { githubClient, githubEndpoints } from '../common/github.mjs';
import { HttpError } from '../common/http.mjs';
import { envValue } from '../common/env.mjs';

const TOOL = 'node oikos/tools/github-issues/cli.mjs';
const DEFAULT_MAX = 50;
const NOTHING_WRITTEN = 'DRY RUN — nothing written to GitHub.';

// The token help names the write permissions: this connector writes issues and project fields.
const WRITE_HELP = [
  '  Token: fine-grained on the organization — repository Issues read/write, Metadata read; organization Projects read/write (for GITHUB_PROJECT) — or classic: repo + project: https://github.com/settings/tokens',
  '  Or log in once with `gh auth login`, and `gh auth refresh -s project` for Projects.',
];

/** The GitHub client of this tool; a missing credential fails here, before any request. */
const gh = () => githubClient('github-issues', { help: WRITE_HELP });

/** A guard's refusal: the command prints `refused: …` and exits 3 (see `guarded`). */
class Refusal extends Error {}

/** `run` with a guard's refusal turned into exit 3 and its message on stderr, as jira does. */
const guarded = (run) => async (v) => {
  try {
    return await run(v);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(`refused: ${e.message}`);
    return 3;
  }
};

const splitList = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const lower = (s) => String(s ?? '').trim().toLowerCase();

/**
 * The installation's GitHub settings, read at a command's start and passed down: org, repo
 * (GITHUB_REPO as written), project (number or null), the status policy, the public repositories
 * open to writes, and the web server URL.
 */
function readSettings() {
  const project = envValue('GITHUB_PROJECT');
  if (project && !/^\d+$/.test(String(project).trim())) throw new UsageError(`GITHUB_PROJECT must be an organization project number, got: ${project}`);
  return Object.freeze({
    org: envValue('GITHUB_ORG') || null,
    repo: envValue('GITHUB_REPO') || null,
    project: project ? Number(project) : null,
    agent: splitList(envValue('GITHUB_AGENT_STATUSES') || 'Todo, In Progress'),
    review: splitList(envValue('GITHUB_REVIEW_STATUSES') || 'In Review, Review'),
    publicRepos: splitList(envValue('GITHUB_PUBLIC_REPOS')).map(lower),
    serverUrl: githubEndpoints(envValue('GITHUB_API_URL'), envValue('GITHUB_SERVER_URL')).serverUrl,
  });
}

/** `owner/name` for a repository named `owner/name` or `name` (under GITHUB_ORG). */
function qualify(name, { org }) {
  if (name.includes('/')) return name;
  if (!org) throw new UsageError(`repository '${name}' has no owner: write owner/${name}, or set GITHUB_ORG in oikos.yaml settings`);
  return `${org}/${name}`;
}

/** The repository of a command: --repo, else GITHUB_REPO; a usage error without either. */
function targetRepo(v, s) {
  const name = v.repo || s.repo;
  if (!name) throw new UsageError('no repository: pass --repo owner/name, or set GITHUB_REPO in oikos.yaml settings');
  return qualify(name, s);
}

/**
 * An issue reference from `--task`: `owner/repo#12`, `repo#12` (owner = GITHUB_ORG), `#12` or `12`
 * (in GITHUB_REPO), or an issue URL `https://<server>/owner/repo/issues/12`. Returns the frozen
 * { owner, repo, number, full: 'owner/repo', key: 'owner/repo#12' }.
 * @param {string} value
 * @param {{ org?: string|null, repo?: string|null }} defaults GITHUB_ORG and GITHUB_REPO
 */
export function parseTask(value, { org = null, repo = null } = {}) {
  const s = String(value ?? '').trim();
  const make = (owner, name, number) => Object.freeze({ owner, repo: name, number: Number(number), full: `${owner}/${name}`, key: `${owner}/${name}#${Number(number)}` });
  let m = s.match(/^https?:\/\/[^/\s]+\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?(?:[?#]\S*)?$/);
  if (m) return make(m[1], m[2], m[3]);
  m = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (m) return make(m[1], m[2], m[3]);
  m = s.match(/^([\w.-]+)#(\d+)$/);
  if (m) {
    if (!org) throw new UsageError(`--task ${s}: a repository without its owner needs GITHUB_ORG in oikos.yaml settings (or write owner/${m[1]}#${m[2]})`);
    return make(org, m[1], m[2]);
  }
  m = s.match(/^#?(\d+)$/);
  if (m) {
    if (!repo) throw new UsageError(`--task ${s}: an issue number alone needs GITHUB_REPO in oikos.yaml settings (or write owner/repo#${m[1]})`);
    const [owner, name] = qualify(repo, { org }).split('/');
    return make(owner, name, m[1]);
  }
  throw new UsageError(`--task ${s}: expected owner/repo#12, repo#12, #12 or an issue URL`);
}

/** The references of --task A,B,… (each parsed, duplicates dropped). */
function taskRefs(value, s) {
  const seen = new Map();
  for (const t of splitList(value)) { const ref = parseTask(t, s); seen.set(ref.key, ref); }
  if (!seen.size) throw new UsageError('--task is empty');
  return [...seen.values()];
}

const issueUrl = (s, ref) => `${s.serverUrl}/${ref.full}/issues/${ref.number}`;

/** `owner/repo` from an API `repository_url` (`…/repos/owner/repo`). */
const repoOfApiUrl = (url) => String(url || '').split('/').slice(-2).join('/');

/** The key `owner/repo#12` of a REST issue. */
const restKey = (i) => `${repoOfApiUrl(i.repository_url)}#${i.number}`;

const logins = (list) => (list || []).map((u) => `@${u.login}`).join(', ');

/** One line per REST issue: key, state, title, assignees, labels. */
function issueLine(i) {
  const who = i.assignees?.length ? ` ${logins(i.assignees)}` : '';
  const labels = i.labels?.length ? `  {${i.labels.map((l) => l.name || l).join(', ')}}` : '';
  return `${restKey(i)} [${i.state}] ${i.title}${who}${labels}`;
}

/** One line per GraphQL issue node (`BRIEF`). */
function briefLine(n) {
  if (!n) return '';
  const who = n.assignees?.nodes?.length ? ` ${logins(n.assignees.nodes)}` : '';
  return `${n.repository?.nameWithOwner}#${n.number} [${lower(n.state)}] ${n.title}${who}`;
}

/** The REST issue of `ref`; a pull request is a usage error. */
async function getIssue(g, ref) {
  const { data } = await g.api(`/repos/${ref.full}/issues/${ref.number}`);
  if (data.pull_request) throw new UsageError(`${ref.key} is a pull request, not an issue — the code-hosting skill reads it`);
  return data;
}

/** GET a REST list that pages with `Link`, the `paged` of the client but for search answers. */
async function searchIssues(g, q, limit) {
  let url = `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(100, Math.max(1, limit))}`;
  const items = [];
  let total = 0;
  let incomplete = false;
  while (url && items.length < limit) {
    const r = await g.api(url);
    total = r.data.total_count ?? 0;
    incomplete ||= Boolean(r.data.incomplete_results);
    items.push(...(r.data.items || []));
    url = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  const shown = items.slice(0, limit);
  return { items: shown, total, truncated: total > shown.length || incomplete };
}

/**
 * The GitHub search query for `query`: `is:issue` added when the query names no type, and the
 * scope (`repo:` from GITHUB_REPO, else `org:` from GITHUB_ORG) when it names none. Returns
 * { q, added } — what was added is said in the output.
 */
export function searchQuery(query, s) {
  let q = String(query).trim();
  const added = [];
  if (!/(^|\s)-?(is|type):(issue|issues|pr|pull-request)\b/i.test(q)) added.push('is:issue');
  if (!/(^|\s)-?(repo|org|user|owner):/i.test(q)) {
    if (s.repo) added.push(`repo:${qualify(s.repo, s)}`);
    else if (s.org) added.push(`org:${s.org}`);
  }
  if (added.length) q = `${q} ${added.join(' ')}`.trim();
  return { q, added };
}

/**
 * The issues a bulk write acts on: --task A,B, or --query (GitHub search, scoped as `search`)
 * capped by --max (default 50) — a query that selects more is a usage error.
 */
async function selectIssues(g, v, s) {
  if (v.task) return taskRefs(v.task, s);
  if (!v.query) throw new UsageError('--task ISSUE[,ISSUE…] or --query is required');
  const max = Number(v.max || DEFAULT_MAX);
  const { q } = searchQuery(v.query, s);
  const { items, truncated } = await searchIssues(g, q, max + 1);
  if (items.length > max || truncated) throw new UsageError(`the query selects more than --max ${max} issues; narrow it or raise --max (query: ${q})`);
  if (!items.length) throw new UsageError(`the query selects no issue (query: ${q})`);
  return items.map((i) => parseTask(`${restKey(i)}`, s));
}

// == status policy ==============================================================================
// An agent moves a task only among GITHUB_AGENT_STATUSES; from GITHUB_REVIEW_STATUSES on only a
// person moves it, and an agent never closes or reopens an issue (F7 Q3).

const CLOSING = /^(close|closed|done|complete|completed|resolved|reopen|reopened|open|not planned|won'?t (do|fix)|wontfix)$/i;

/** The status policy of the settings: which names are open to an agent, which are review. */
function statusPolicy(s) {
  const agent = s.agent.map(lower);
  const review = s.review.map(lower);
  return {
    agent,
    review,
    isAgent: (n) => agent.includes(lower(n)),
    isKnown: (n) => agent.includes(lower(n)) || review.includes(lower(n)),
    names: [...s.agent, ...s.review],
  };
}

/** The labels of an issue that are a known status (agent or review). */
const statusLabels = (labels, policy) => (labels || []).map((l) => l.name || l).filter((n) => policy.isKnown(n));

// == Projects v2 ================================================================================

const PROJECT_QUERY = 'query OikosProject($org:String!,$number:Int!){ organization(login:$org){ projectV2(number:$number){ id number title url closed '
  + 'fields(first:50){ nodes{ __typename ... on ProjectV2FieldCommon{ id name } ... on ProjectV2SingleSelectField{ options{ id name } } '
  + '... on ProjectV2IterationField{ configuration{ iterations{ id title startDate duration } completedIterations{ id title startDate duration } } } } } } } }';

const VALUES = 'fieldValues(first:30){ nodes{ __typename ... on ProjectV2ItemFieldSingleSelectValue{ name optionId field{ ... on ProjectV2FieldCommon{ id name } } } '
  + '... on ProjectV2ItemFieldIterationValue{ title iterationId startDate duration field{ ... on ProjectV2FieldCommon{ id name } } } } }';

const ITEMS_QUERY = `query OikosIssueItems($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){ id databaseId number title state url projectItems(first:20){ nodes{ id project{ id number } ${VALUES} } } } } }`;

const BRIEF = 'number title state url repository{ nameWithOwner } assignees(first:5){ nodes{ login } }';
const RELATIONS_QUERY = `query OikosIssueRelations($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ issue(number:$number){ parent{ ${BRIEF} subIssues(first:50){ nodes{ ${BRIEF} } } } subIssues(first:50){ totalCount nodes{ ${BRIEF} } } blockedBy(first:20){ nodes{ ${BRIEF} } } blocking(first:20){ nodes{ ${BRIEF} } } } } }`;

/**
 * The project of GITHUB_PROJECT (an organization project, owner GITHUB_ORG): { id, number, title,
 * url, status: the Status single-select field or null, iteration: the first iteration field or
 * null }. Null when GITHUB_PROJECT is not set.
 */
async function loadProject(g, s) {
  if (!s.project) return null;
  if (!s.org) throw new UsageError('GITHUB_PROJECT is an organization project number: set GITHUB_ORG too');
  const d = await g.graphql(PROJECT_QUERY, { org: s.org, number: s.project });
  const p = d?.organization?.projectV2;
  if (!p) throw new UsageError(`project ${s.project} of ${s.org}: not found, or no access (the token needs the project scope)`);
  const fields = (p.fields?.nodes || []).filter(Boolean);
  const status = fields.find((f) => Array.isArray(f.options) && lower(f.name) === 'status') || null;
  const it = fields.find((f) => f.configuration) || null;
  const iteration = it && { id: it.id, name: it.name, iterations: it.configuration.iterations || [], completed: it.configuration.completedIterations || [] };
  return { id: p.id, number: p.number, title: p.title, url: p.url, status, iteration };
}

/** "the project's Iteration field" needs GITHUB_PROJECT: a usage error that says so. */
function requireProject(s, what) {
  if (!s.project) throw new UsageError(`${what} come from the Iteration field of a GitHub project: set GITHUB_PROJECT (the organization project number, owner GITHUB_ORG) in oikos.yaml settings`);
}

/**
 * The issue `ref` and its item in `project`: { node: { id, databaseId, title, state, url }, item:
 * { id, status, iteration } or null when the issue is not in the project }.
 */
async function issueInProject(g, ref, project) {
  const d = await g.graphql(ITEMS_QUERY, { owner: ref.owner, repo: ref.repo, number: ref.number });
  const node = d?.repository?.issue;
  if (!node) throw new UsageError(`${ref.key}: not found, or no access`);
  const raw = (node.projectItems?.nodes || []).find((n) => n?.project?.id === project.id);
  if (!raw) return { node, item: null };
  return { node, item: { id: raw.id, ...itemValues(raw, project) } };
}

/** The Status and iteration of a project item (`VALUES`): { status: name|null, iteration|null }. */
function itemValues(raw, project) {
  const values = (raw.fieldValues?.nodes || []).filter(Boolean);
  const status = values.find((x) => project.status && x.field?.id === project.status.id)?.name || null;
  const itv = values.find((x) => project.iteration && x.field?.id === project.iteration.id);
  const iteration = itv ? { id: itv.iterationId, title: itv.title, startDate: itv.startDate, duration: itv.duration } : null;
  return { status, iteration };
}

/** The relations of an issue (parent and its sub-issues, sub-issues, blocked by, blocking), best effort. */
async function relations(g, ref) {
  try {
    const d = await g.graphql(RELATIONS_QUERY, { owner: ref.owner, repo: ref.repo, number: ref.number });
    return d?.repository?.issue || {};
  } catch (e) {
    if (e instanceof UsageError || e instanceof HttpError) return { error: e.message };
    throw e;
  }
}

const DAY = 86_400_000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/** active | future | closed for an iteration, by its dates (completed ones are closed). */
function iterationState(it, now = today()) {
  if (now >= addDays(it.startDate, it.duration)) return 'closed';
  return now >= it.startDate ? 'active' : 'future';
}

const iterationDates = (it) => `${it.startDate} → ${addDays(it.startDate, it.duration - 1)}`;

/** Every iteration of the field, each with its state. */
function allIterations(field) {
  return [...field.iterations, ...field.completed.map((x) => ({ ...x, completed: true }))]
    .map((x) => ({ ...x, state: x.completed ? 'closed' : iterationState(x) }));
}

// == text guards ================================================================================

/** The text of --text or --file. */
const readText = (v) => (v.file ? readFileSync(v.file, 'utf8') : v.text);

/** The content check (common/outgoing.mjs) of a write's texts, in its dry run and its real run. */
function checkContent(v, texts) {
  guardOutgoing(texts, v, outgoingRules());
}

/** The @mentions of a markdown text outside code (users and `org/team`): each one notifies. */
export function mentions(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = new Set();
  for (const m of prose.matchAll(/(^|[^\w`/@.-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_-]+)?)/g)) found.add(m[2]);
  return [...found];
}

/** The `will notify @x` line of a dry run, when the texts mention anyone. */
function notifyLine(...texts) {
  const who = mentions(texts.filter(Boolean).join('\n'));
  if (who.length) console.log(`will notify ${who.map((w) => `@${w}`).join(', ')}`);
}

/** The links in a markdown text that point at files uploaded to GitHub (images, attachments). */
export function attachmentUrls(text, serverUrl) {
  const host = new URL(serverUrl).host;
  const out = [];
  for (const [u] of String(text || '').matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
    let url;
    try { url = new URL(u); } catch { continue; }
    const uploaded = (url.host === host && /^\/user-attachments\//.test(url.pathname)) || /(^|\.)githubusercontent\.com$/.test(url.host);
    if (uploaded && !out.includes(u)) out.push(u);
  }
  return out;
}

// == reads ======================================================================================

/** The lines of `info` for a REST issue, its comments, its relations and its status. */
function infoLines(s, i, comments, rel, status) {
  const out = [`Task: ${restKey(i)}`, `Title: ${i.title}`];
  out.push(`State: ${i.state}${i.state_reason ? ` (${i.state_reason})` : ''}   Status: ${status}   Assignees: ${logins(i.assignees) || 'unassigned'}   Author: @${i.user?.login || '?'}`);
  if (i.milestone) out.push(`Milestone: ${i.milestone.title} (#${i.milestone.number}, ${i.milestone.state}${i.milestone.due_on ? `, due ${i.milestone.due_on.slice(0, 10)}` : ''})`);
  if (i.labels?.length) out.push(`Labels: ${i.labels.map((l) => l.name || l).join(', ')}`);
  if (rel.error) out.push(`(relations not read: ${rel.error})`);
  if (rel.parent) out.push(`Parent: ${briefLine(rel.parent)}`);
  const subs = rel.subIssues?.nodes || [];
  if (subs.length) out.push(`Sub-issues (${rel.subIssues.totalCount ?? subs.length}):`, ...subs.map((n) => `  ${briefLine(n)}`));
  const blockedBy = rel.blockedBy?.nodes || [];
  if (blockedBy.length) out.push('Blocked by:', ...blockedBy.map((n) => `  ${briefLine(n)}`));
  const blocking = rel.blocking?.nodes || [];
  if (blocking.length) out.push('Blocking:', ...blocking.map((n) => `  ${briefLine(n)}`));
  const body = (i.body || '').trim();
  out.push('', 'Description:', body || '(empty — the title above is the whole specification)');
  const files = attachmentUrls([i.body, ...comments.map((c) => c.body)].join('\n'), s.serverUrl);
  if (files.length) {
    out.push('', 'Attachments (links in the description and comments):');
    files.forEach((u, n) => out.push(`  [${n + 1}] ${u} — NOT READ`));
    out.push(`  Fetch: ${TOOL} attachment --task ${restKey(i)} --id <n> [--dir DIR]`);
  }
  if (comments.length) {
    out.push('', `Comments (${comments.length}):`);
    for (const c of comments) {
      out.push(`  --- @${c.user?.login || '?'}, ${(c.created_at || '').slice(0, 10)}`);
      for (const line of (c.body || '(empty)').split('\n')) if (line.trim()) out.push(`      ${line.trim()}`);
    }
  }
  if (files.length) {
    out.push('', 'NOTE — part of this task is not text (images, files). Fetch the attachment and read it; '
      + 'if it stays unclear, ask the user. Do not rebuild it from the surrounding text.');
  }
  return out;
}

/**
 * The status of an issue as a line and its parts: from the project's Status field when a project
 * is configured, else from the issue's status labels.
 */
async function statusOf(g, s, ref, issue) {
  if (!s.project) {
    const found = statusLabels(issue.labels, statusPolicy(s));
    return { line: `${found.join(', ') || '(no status label)'} (labels)`, labels: found };
  }
  try {
    const project = await loadProject(g, s);
    const { item } = await issueInProject(g, ref, project);
    if (!item) return { line: `(not in project ${project.number})`, project, item };
    return { line: `${item.status || '(empty)'} (project ${project.number} field Status)`, project, item };
  } catch (e) {
    if (e instanceof UsageError || e instanceof HttpError) return { line: `(not read: ${e.message})` };
    throw e;
  }
}

/** An issue with its comments, relations and status — what `info` and `context` read. */
async function readIssue(g, s, ref, limit = 200) {
  const issue = await getIssue(g, ref);
  const comments = issue.comments ? await g.paged(`/repos/${ref.full}/issues/${ref.number}/comments`, limit) : [];
  const rel = await relations(g, ref);
  const status = await statusOf(g, s, ref, issue);
  return { issue, comments, rel, status };
}

const commands = {
  whoami: {
    help: 'check the credential: which GitHub user, which route, the visible scopes, the settings',
    options: {},
    async run(v) {
      const s = readSettings();
      const g = gh();
      const r = await g.api('/user');
      const raw = r.headers.get('x-oauth-scopes');
      if (v.json) return printJson({ user: r.data, scopes: raw === null ? null : splitList(raw) });
      console.log(`@${r.data.login} (${r.data.name || '-'}) via ${g.route} on ${g.apiUrl}`);
      if (raw === null) console.log('Scopes: not reported — fine-grained token or gh');
      else {
        const scopes = splitList(raw);
        console.log(`Scopes: ${scopes.join(', ') || '(none)'}`);
        if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
          console.log('WARNING: writes configured, token read-only — create, edit, comment, transition and link need the repo scope');
        }
        if (s.project && !scopes.includes('project')) {
          console.log('WARNING: GITHUB_PROJECT is set but the token lacks the project scope — Status, iterations and boards need it (`gh auth refresh -s project`)');
        }
      }
      console.log(`Settings: GITHUB_ORG ${s.org || '(unset)'} · GITHUB_REPO ${s.repo || '(unset)'} · GITHUB_PROJECT ${s.project ?? '(unset)'}`);
      console.log(`Status: ${s.project ? `the Status field of project ${s.project}` : 'labels (no GITHUB_PROJECT)'} · agent moves among: ${s.agent.join(', ')} · from review on (a person's): ${s.review.join(', ')}`);
      console.log(`Public repositories open to writes (GITHUB_PUBLIC_REPOS): ${s.publicRepos.join(', ') || 'none'}`);
    },
  },

  info: {
    help: 'an issue: title, state, status, labels, relations, description, attachments, comments (--task)',
    options: { task: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      const s = readSettings();
      const ref = parseTask(v.task, s);
      const g = gh();
      const d = await readIssue(g, s, ref);
      if (v.json) return printJson(d);
      console.log(infoLines(s, d.issue, d.comments, d.rel, d.status.line).join('\n'));
      console.log(`\n${d.issue.html_url || issueUrl(s, ref)}`);
    },
  },

  context: {
    help: 'info plus the project Status / iteration, the parent and its other sub-issues, and warnings — read before working on a task (--task)',
    options: { task: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      const s = readSettings();
      const ref = parseTask(v.task, s);
      const g = gh();
      const d = await readIssue(g, s, ref);
      if (v.json) return printJson(d);
      const { issue, rel, status } = d;
      const policy = statusPolicy(s);
      const out = ['## Task', ...infoLines(s, issue, d.comments, rel, status.line)];
      const warnings = [];
      if (s.project) {
        out.push('', '## Project');
        if (!status.project) out.push(`  ${status.line}`);
        else if (!status.item) {
          out.push(`  not in project ${status.project.number} "${status.project.title}"`);
          warnings.push(`the issue is not in project ${status.project.number} — it has no Status or iteration.`);
        } else {
          out.push(`  ${status.project.number} "${status.project.title}" · Status: ${status.item.status || '(empty)'}`);
          const it = status.item.iteration;
          if (status.project.iteration) {
            out.push(`  ${status.project.iteration.name}: ${it ? `${it.title} [${iterationState(it)}] ${iterationDates(it)}` : '(none)'}`);
            if (!it || iterationState(it) !== 'active') warnings.push('the issue is not in the active iteration.');
          }
        }
      }
      const current = status.item?.status ? [status.item.status] : (status.labels || []);
      for (const c of current) if (!policy.isAgent(c)) warnings.push(`status is ${c} — from review on only a person moves the task.`);
      const siblings = (rel.parent?.subIssues?.nodes || []).filter((n) => !(n.number === issue.number && n.repository?.nameWithOwner === ref.full));
      if (rel.parent) out.push('', `## Parent ${rel.parent.repository?.nameWithOwner}#${rel.parent.number} — its other sub-issues`, ...(siblings.length ? siblings.map((n) => `  ${briefLine(n)}`) : ['  (none)']));
      if (issue.state === 'closed') warnings.push('the issue is closed — closed tasks are not worked on.');
      if (rel.subIssues?.nodes?.length) warnings.push('the issue has sub-issues — work usually goes into one of them.');
      if ((rel.blockedBy?.nodes || []).some((n) => lower(n.state) === 'open')) warnings.push('the issue is blocked by an open issue.');
      out.push('', '## Warnings', ...(warnings.length ? warnings.map((w) => `  - ${w}`) : ['  (none)']));
      console.log(out.join('\n'));
      console.log(`\n${issue.html_url || issueUrl(s, ref)}`);
    },
  },

  search: {
    help: 'read-only issue search in GitHub search syntax (--query; is:issue and the repo:/org: scope added when absent; --limit default 50)',
    options: { query: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'query');
      const s = readSettings();
      const g = gh();
      const { q, added } = searchQuery(v.query, s);
      const { items, total, truncated } = await searchIssues(g, q, Number(v.limit || 50));
      if (v.json) return printJson(items);
      if (added.length) console.log(`# added to the query: ${added.join(' ')}  (query: ${q})`);
      for (const i of items) console.log(issueLine(i));
      console.log(`${items.length} issue(s)${truncated ? ` of ${total} … more (raise --limit, or narrow the query)` : ''}`);
    },
  },

  mine: {
    help: 'open issues assigned to a person in the organization (--user me|<login>, default me; --all to include closed; --limit)',
    options: { user: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const s = readSettings();
      const g = gh();
      // "me" is the owner of the token, or the `gh` login.
      const who = !v.user || v.user === 'me' ? (await g.api('/user')).data.login : v.user.replace(/^@/, '');
      const scope = s.repo ? `repo:${qualify(s.repo, s)}` : s.org ? `org:${s.org}` : '';
      const q = `is:issue assignee:${who}${v.all ? '' : ' is:open'}${scope ? ` ${scope}` : ''}`;
      const { items, total, truncated } = await searchIssues(g, q, Number(v.limit || 100));
      if (v.json) return printJson(items);
      console.log(`@${who}${!v.user || v.user === 'me' ? ' (the owner of the credential)' : ''} — ${scope || 'every repository the credential sees (no GITHUB_ORG)'}`);
      const byRepo = new Map();
      for (const i of items) {
        const repo = repoOfApiUrl(i.repository_url);
        if (!byRepo.has(repo)) byRepo.set(repo, []);
        byRepo.get(repo).push(i);
      }
      for (const [repo, list] of byRepo) {
        console.log(`\n## ${repo} (${list.length})`);
        for (const i of list) console.log(`  ${issueLine(i)}`);
      }
      console.log(`\n${items.length} issue(s)${v.all ? '' : ', open'}${truncated ? ` of ${total} (raise --limit)` : ''}`);
    },
  },
};

// == boards and sprints: the organization's projects and the iterations of GITHUB_PROJECT ========

const BOARDS_QUERY = 'query OikosBoards($org:String!,$after:String){ organization(login:$org){ projectsV2(first:50, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ number title closed url shortDescription } } } }';

const ITEMS_PAGE_QUERY = 'query OikosProjectItems($id:ID!,$after:String){ node(id:$id){ ... on ProjectV2{ items(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id content{ __typename '
  + `... on Issue{ ${BRIEF} } ... on PullRequest{ ${BRIEF} } ... on DraftIssue{ title assignees(first:5){ nodes{ login } } } } ${VALUES} } } } } }`;

/** The items of a project, up to `limit`: { items: [{ line, done, assignees, status, iteration }], truncated }. */
async function projectItems(g, project, limit) {
  const items = [];
  let after = null;
  let more = false;
  while (items.length < limit) {
    const d = await g.graphql(ITEMS_PAGE_QUERY, { id: project.id, after });
    const conn = d?.node?.items;
    if (!conn) break;
    for (const raw of conn.nodes.filter(Boolean)) {
      const c = raw.content || {};
      const line = c.__typename === 'DraftIssue' ? `draft: ${c.title}` : `${c.__typename === 'PullRequest' ? 'PR ' : ''}${briefLine(c)}`;
      const values = itemValues(raw, project);
      const done = lower(values.status) === 'done' || ['closed', 'merged'].includes(lower(c.state));
      items.push({ line, done, assignees: (c.assignees?.nodes || []).map((u) => u.login), ...values });
    }
    more = conn.pageInfo.hasNextPage;
    if (!more) break;
    after = conn.pageInfo.endCursor;
  }
  return { items: items.slice(0, limit), truncated: more || items.length > limit };
}

/** Issue lines grouped under `## <group> (n)`, then the load per assignee. */
function groupedReport(rows, groupOf) {
  const groups = new Map();
  const load = new Map();
  for (const r of rows) {
    const key = groupOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
    for (const who of r.assignees.length ? r.assignees.map((a) => `@${a}`) : ['unassigned']) {
      const row = load.get(who) || { total: 0, done: 0 };
      row.total += 1;
      if (r.done) row.done += 1;
      load.set(who, row);
    }
  }
  for (const [key, list] of groups) {
    console.log(`\n## ${key} (${list.length})`);
    for (const r of list) console.log(`  ${r.line}`);
  }
  console.log('\n## Load');
  for (const [who, r] of [...load].sort((a, b) => b[1].total - a[1].total)) console.log(`  ${who.padEnd(28)} ${r.done}/${r.total} done`);
  console.log(`\n${rows.length} issue(s), ${rows.filter((r) => r.done).length} done`);
}

/** `sprints` of a project without an iteration field: the milestones of the repository. */
async function milestoneSprints(g, s, v, project, states) {
  const repo = targetRepo(v, s);
  const want = new Set(states.map((x) => (x === 'closed' ? 'closed' : 'open')));
  const state = want.size === 1 ? [...want][0] : 'all';
  const list = await g.paged(`/repos/${repo}/milestones?state=${state}&sort=due_on`, Number(v.limit || 100));
  if (v.json) return printJson(list);
  console.log(`# project ${project.number} "${project.title}" has no iteration field — the milestones of ${repo} instead`);
  for (const m of list) {
    console.log(`${String(m.number).padStart(6)}  [${m.state}] ${m.title}${m.due_on ? `  due ${m.due_on.slice(0, 10)}` : ''}  ${m.closed_issues}/${m.open_issues + m.closed_issues} closed`);
  }
  console.log(`${list.length} milestone(s)`);
}

/** `sprint` of a project without an iteration field: one milestone of the repository. */
async function milestoneSprint(g, s, v, project) {
  const repo = targetRepo(v, s);
  if (!v.id) throw new UsageError(`--id MILESTONE is required: project ${project.number} has no iteration field, so sprints are the milestones of ${repo} (sprints lists them)`);
  const { data: m } = await g.api(`/repos/${repo}/milestones/${encodeURIComponent(v.id)}`);
  const issues = (await g.paged(`/repos/${repo}/issues?milestone=${m.number}&state=all`, Number(v.limit || 1000))).filter((i) => !i.pull_request);
  if (v.json) return printJson({ milestone: m, issues });
  console.log(`# project ${project.number} "${project.title}" has no iteration field — milestone ${m.number} of ${repo} instead; grouped by state`);
  console.log(`Milestone ${m.number}: ${m.title} [${m.state}]${m.due_on ? ` due ${m.due_on.slice(0, 10)}` : ''}`);
  if (m.description) console.log(`Description: ${m.description}`);
  const rows = issues.map((i) => ({ line: issueLine(i), done: i.state === 'closed', assignees: (i.assignees || []).map((u) => u.login), state: i.state }));
  groupedReport(rows, (r) => r.state);
}

Object.assign(commands, {
  boards: {
    help: "the organization's projects (Projects v2; --org default GITHUB_ORG, --closed to include closed ones, --limit)",
    options: { org: { type: 'string' }, closed: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const s = readSettings();
      const org = v.org || s.org;
      if (!org) throw new UsageError('no organization: pass --org, or set GITHUB_ORG in oikos.yaml settings');
      const limit = Number(v.limit || 100);
      const g = gh();
      const projects = [];
      let after = null;
      for (let page = 0; page < 20 && projects.length < limit; page++) {
        const conn = (await g.graphql(BOARDS_QUERY, { org, after }))?.organization?.projectsV2;
        if (!conn) break;
        projects.push(...conn.nodes.filter(Boolean));
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      const shown = projects.filter((p) => v.closed || !p.closed).slice(0, limit);
      if (v.json) return printJson(shown);
      for (const p of shown) console.log(`${p.number === s.project ? '*' : ' '}${String(p.number).padStart(5)}  ${p.title}${p.closed ? ' [closed]' : ''}  ${p.url}`);
      console.log(`${shown.length} project(s) of ${org}${v.closed ? '' : ' (closed hidden; --closed to include)'}${s.project ? ` · * = GITHUB_PROJECT` : ''}`);
    },
  },

  sprints: {
    help: 'the iterations of the project in GITHUB_PROJECT (--state active,future,closed; default active,future); the milestones of --repo|GITHUB_REPO when the project has no iteration field',
    options: { state: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const s = readSettings();
      requireProject(s, 'sprints');
      const states = splitList(v.state || 'active,future').map(lower);
      const g = gh();
      const project = await loadProject(g, s);
      if (!project.iteration) return milestoneSprints(g, s, v, project, states);
      const list = allIterations(project.iteration).filter((x) => states.includes(x.state)).slice(0, Number(v.limit || 100));
      if (v.json) return printJson(list);
      console.log(`# project ${project.number} "${project.title}" — field ${project.iteration.name}`);
      for (const x of list) console.log(`${String(x.id).padEnd(10)}  [${x.state}] ${x.title}  ${iterationDates(x)}`);
      console.log(`${list.length} iteration(s)`);
    },
  },

  sprint: {
    help: 'one iteration of GITHUB_PROJECT: issues grouped by Status, load per assignee (--id ITERATION or its title, default the active one; a milestone number with --repo when the project has no iteration field; --limit items scanned, default 1000)',
    options: { id: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const s = readSettings();
      requireProject(s, 'sprints');
      const g = gh();
      const project = await loadProject(g, s);
      if (!project.iteration) return milestoneSprint(g, s, v, project);
      const its = allIterations(project.iteration);
      let it;
      if (v.id) {
        it = its.find((x) => x.id === v.id || lower(x.title) === lower(v.id));
        if (!it) throw new UsageError(`no iteration '${v.id}' in project ${project.number}; iterations: ${its.map((x) => `${x.id} "${x.title}"`).join(', ') || 'none'}`);
      } else {
        const active = its.filter((x) => x.state === 'active');
        if (!active.length) throw new UsageError(`project ${project.number} has no active iteration — pass --id (sprints lists them)`);
        it = active[0];
      }
      const { items, truncated } = await projectItems(g, project, Number(v.limit || 1000));
      const rows = items.filter((x) => x.iteration?.id === it.id);
      if (v.json) return printJson({ iteration: it, items: rows });
      console.log(`Iteration ${it.id}: ${it.title} [${it.state}] ${iterationDates(it)} — project ${project.number} "${project.title}"`);
      if (truncated) console.log(`# only the first ${items.length} items of the project were scanned (raise --limit)`);
      groupedReport(rows, (r) => r.status || '(no Status)');
    },
  },
});

// == write guards ===============================================================================
// Every write: the repositories it touches are read first — a public one is refused unless listed
// in GITHUB_PUBLIC_REPOS (F7 Q8), on a dry run too; a dry run makes no request but GETs and
// GraphQL queries, never a mutation.

/**
 * The visibility of each repository a write touches: [{ full, isPublic, url }]. A public
 * repository not listed in GITHUB_PUBLIC_REPOS is refused.
 */
async function guardRepos(g, s, fulls) {
  const out = [];
  for (const full of [...new Set(fulls)]) {
    const { data } = await g.api(`/repos/${full}`);
    const isPublic = data.visibility ? data.visibility === 'public' : data.private === false;
    if (isPublic && !s.publicRepos.includes(lower(full))) {
      throw new Refusal(`${full} is a PUBLIC repository — everything written is visible to anyone; a write to it needs it listed in GITHUB_PUBLIC_REPOS (oikos.yaml settings, comma separated owner/repo): ${data.html_url || `${s.serverUrl}/${full}`}`);
    }
    out.push({ full, isPublic, url: data.html_url });
  }
  return out;
}

/** The first lines of a dry run: the frame, and the banner of each public repository. */
function dryHeader(repos = []) {
  console.log('--- DRY RUN (requested --dry-run) ---');
  for (const r of repos) if (r.isPublic) console.log(`PUBLIC repository ${r.full} — everything written is visible to anyone`);
}

/**
 * The labels of a repository that `names` mean: { canon(name) → the existing spelling, missing }.
 * GitHub creates an unknown label silently when it is used, so one is refused unless --create-labels.
 */
async function labelPlan(g, full, names, create) {
  if (!names.length) return { canon: (n) => n, missing: [] };
  const existing = (await g.paged(`/repos/${full}/labels`, 1000)).map((l) => l.name);
  const find = (n) => existing.find((e) => lower(e) === lower(n));
  const missing = [...new Set(names.filter((n) => !find(n)))];
  if (missing.length && !create) {
    throw new Refusal(`unknown label(s) in ${full}: ${missing.join(', ')} — GitHub would create them silently; pass --create-labels to create them, or use an existing one: ${existing.slice(0, 30).join(', ') || 'none'}${existing.length > 30 ? ' …' : ''}`);
  }
  return { canon: (n) => find(n) || n, missing };
}

async function createLabels(g, full, missing) {
  for (const name of missing) await g.api(`/repos/${full}/labels`, { method: 'POST', body: { name } });
}

/**
 * In label mode the status labels move only through `transition`: an edit that adds, removes or
 * (by --labels) changes a status label is refused. A new issue may carry an agent status only.
 */
function statusLabelGuard(s, ref, current, { set, add = [], remove = [] }) {
  if (s.project) return;
  const policy = statusPolicy(s);
  const touched = [...add, ...remove].filter((n) => policy.isKnown(n));
  if (set) {
    const before = statusLabels(current, policy).map(lower).sort().join();
    const after = set.filter((n) => policy.isKnown(n)).map(lower).sort().join();
    if (before !== after) touched.push(...set.filter((n) => policy.isKnown(n)), ...statusLabels(current, policy));
  }
  if (touched.length) {
    throw new Refusal(`${[...new Set(touched)].join(', ')}: a status label — the status moves through transition, and an agent only among ${s.agent.join(', ')}: ${issueUrl(s, ref)}`);
  }
}

/** The logins of --assignee me|login[,…]|none: undefined when not given, [] for none. */
async function assigneesFrom(g, value) {
  if (value === undefined) return undefined;
  if (value === 'none' || value === '') return [];
  const out = [];
  for (const a of splitList(value)) out.push(a === 'me' ? (await g.api('/user')).data.login : a.replace(/^@/, ''));
  return out;
}

/** The milestone of --milestone N|title|none in a repository: { number|null, title }, or undefined. */
async function milestoneFrom(g, full, value) {
  if (value === undefined) return undefined;
  if (value === 'none') return { number: null, title: 'none' };
  if (/^\d+$/.test(value)) {
    const { data } = await g.api(`/repos/${full}/milestones/${value}`);
    return { number: data.number, title: data.title, state: data.state };
  }
  const open = await g.paged(`/repos/${full}/milestones?state=open`, 500);
  const hit = open.find((m) => lower(m.title) === lower(value));
  if (!hit) throw new UsageError(`no open milestone '${value}' in ${full}; open: ${open.map((m) => `${m.number} "${m.title}"`).join(', ') || 'none'}`);
  return { number: hit.number, title: hit.title, state: hit.state };
}

/** The iteration --sprint names (id or title) in the project, open (active or future) only. */
function openIteration(project, value) {
  if (!project.iteration) throw new UsageError(`project ${project.number} has no iteration field — its sprints are milestones: use --milestone`);
  const its = allIterations(project.iteration);
  const it = its.find((x) => x.id === value || lower(x.title) === lower(value));
  if (!it) throw new UsageError(`no iteration '${value}' in project ${project.number}; open: ${its.filter((x) => x.state !== 'closed').map((x) => `${x.id} "${x.title}"`).join(', ') || 'none'}`);
  if (it.state === 'closed') throw new UsageError(`iteration "${it.title}" is closed; issues cannot be moved into it`);
  return it;
}

/** The Status option of the project that `name` means. */
function statusOption(project, name, policy) {
  if (!project.status) throw new UsageError(`project ${project.number} has no Status field`);
  const option = project.status.options.find((o) => lower(o.name) === lower(name));
  if (!option) throw new UsageError(`project ${project.number} has no Status '${name}'. Open to an agent: ${project.status.options.map((o) => o.name).filter(policy.isAgent).join(', ') || 'none'}`);
  return option;
}

const UPDATE_FIELD = 'mutation OikosSetField($input:UpdateProjectV2ItemFieldValueInput!){ updateProjectV2ItemFieldValue(input:$input){ projectV2Item{ id } } }';
const CLEAR_FIELD = 'mutation OikosClearField($input:ClearProjectV2ItemFieldValueInput!){ clearProjectV2ItemFieldValue(input:$input){ projectV2Item{ id } } }';
const ADD_ITEM = 'mutation OikosAddItem($input:AddProjectV2ItemByIdInput!){ addProjectV2ItemById(input:$input){ item{ id } } }';

/** Add the issue (its GraphQL node id) to the project; the new item's id. */
async function addToProject(g, project, contentId) {
  const d = await g.graphql(ADD_ITEM, { input: { projectId: project.id, contentId } });
  return d.addProjectV2ItemById.item.id;
}

const setField = (g, project, itemId, fieldId, value) => g.graphql(UPDATE_FIELD, { input: { projectId: project.id, itemId, fieldId, value } });

/** A sub-issue under `parent`: the REST endpoint takes the child's database id, not its number. */
const addSubIssue = (g, parent, childId) => g.api(`/repos/${parent.full}/issues/${parent.number}/sub_issues`, { method: 'POST', body: { sub_issue_id: childId } });

/**
 * The plan of a status move: from the project's Status field, or from labels. Refused from a
 * status not open to an agent; the labels are added first, then the old one removed — two
 * statuses for a moment rather than none if the second call fails.
 */
async function movePlan(g, s, ref, issue, to, policy) {
  const url = issueUrl(s, ref);
  const notOpen = (from) => new Refusal(`${ref.key} is '${from}', not a status open to an agent (${s.agent.join(', ')}) — from there only a person moves it: ${url}`);
  if (s.project) {
    const project = await loadProject(g, s);
    const option = statusOption(project, to, policy);
    const { item } = await issueInProject(g, ref, project);
    if (!item) throw new UsageError(`${ref.key} is not in project ${project.number} "${project.title}", so it has no Status there — add it with move-to-sprint --add-to-project, or in GitHub: ${project.url}`);
    if (item.status && !policy.isAgent(item.status)) throw notOpen(item.status);
    return {
      kind: 'project', source: `project ${project.number} "${project.title}" field Status`, from: item.status, to: option.name,
      steps: [`set the Status of item ${item.id} to option ${option.id} (${option.name})`],
      project, itemId: item.id, fieldId: project.status.id, optionId: option.id,
    };
  }
  const current = statusLabels(issue.labels, policy);
  if (current.length > 1) throw new UsageError(`${ref.key} carries several status labels (${current.join(', ')}) — a person settles it: ${url}`);
  const from = current[0] || null;
  if (from && !policy.isAgent(from)) throw notOpen(from);
  const existing = (await g.paged(`/repos/${ref.full}/labels`, 1000)).map((l) => l.name);
  const label = existing.find((n) => lower(n) === lower(to));
  if (!label) throw new UsageError(`no label '${to}' in ${ref.full} — the status comes from labels (no GITHUB_PROJECT), and the status labels are the repository's: a person creates it at ${s.serverUrl}/${ref.full}/labels`);
  const steps = [`1. add label '${label}'`];
  if (from) steps.push(`2. remove label '${from}'`);
  return { kind: 'labels', source: 'labels (no GITHUB_PROJECT)', from, to: label, steps, ref };
}

/** Carry out a status move planned by `movePlan`, in its stated order. */
async function applyMove(g, plan) {
  if (plan.kind === 'project') return setField(g, plan.project, plan.itemId, plan.fieldId, { singleSelectOptionId: plan.optionId });
  const { ref } = plan;
  await g.api(`/repos/${ref.full}/issues/${ref.number}/labels`, { method: 'POST', body: { labels: [plan.to] } });
  if (plan.from) await g.api(`/repos/${ref.full}/issues/${ref.number}/labels/${encodeURIComponent(plan.from)}`, { method: 'DELETE' });
}

/** The connection of a dry run made without credentials: what the write needs. */
function offlineNote(message) {
  console.log(`\n(no GitHub credentials — the write itself needs them, and reads the repository's visibility then)\n${message}`);
}

// == writes =====================================================================================

const TEXT = { 'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' }, 'allow-flagged': { type: 'boolean' } };

/** `move-to-sprint` when the project has no iteration field: the milestone of one repository. */
async function milestoneMove(g, s, v, project, refs, repos) {
  const fulls = [...new Set(refs.map((r) => r.full))];
  if (fulls.length > 1) throw new UsageError(`project ${project.number} has no iteration field, so sprints are milestones — and a milestone belongs to one repository; these issues are in ${fulls.join(', ')}`);
  const milestone = v.backlog ? { number: null, title: 'none' } : await milestoneFrom(g, fulls[0], v.sprint);
  if (milestone.state === 'closed') throw new UsageError(`milestone "${milestone.title}" is closed; issues cannot be moved into it`);
  const target = v.backlog ? 'no milestone (the backlog)' : `milestone ${milestone.number} "${milestone.title}"`;
  const issues = [];
  for (const ref of refs) issues.push({ ref, issue: await getIssue(g, ref) });
  if (v['dry-run']) {
    dryHeader(repos);
    console.log(`# project ${project.number} "${project.title}" has no iteration field — the milestones of ${fulls[0]} instead`);
    console.log(`Target: ${target}\nWould move ${issues.length} issue(s):`);
    for (const { ref, issue } of issues) console.log(`  ${ref.key} — ${issue.title}  [${issue.milestone ? `"${issue.milestone.title}"` : '(no milestone)'} → ${v.backlog ? 'none' : `"${milestone.title}"`}]`);
    console.log(NOTHING_WRITTEN);
    return 0;
  }
  let failed = 0;
  for (const { ref } of issues) {
    try {
      await g.api(`/repos/${ref.full}/issues/${ref.number}`, { method: 'PATCH', body: { milestone: milestone.number } });
    } catch (e) {
      failed += 1;
      console.error(`${ref.key}: ${e.message}`);
    }
  }
  console.log(`Moved ${issues.length - failed}/${issues.length} issue(s) to ${target}`);
  return failed ? 2 : 0;
}

const LINK_TYPES = {
  parent: { says: 'is the parent of', endpoint: 'sub_issues', field: 'sub_issue_id' },
  child: { says: 'is a sub-issue of', endpoint: 'sub_issues', field: 'sub_issue_id' },
  blocks: { says: 'blocks', endpoint: 'dependencies/blocked_by', field: 'issue_id' },
  'blocked-by': { says: 'is blocked by', endpoint: 'dependencies/blocked_by', field: 'issue_id' },
};

/** The issue that holds a link (the parent, or the blocked one) and the one it names, for "A <type> B". */
function linkSides(type, a, b) {
  return { parent: [a, b], child: [b, a], blocks: [b, a], 'blocked-by': [a, b] }[type];
}

/** A file name for a downloaded attachment: its last path segment, with an extension from its type. */
function attachmentName(url, type) {
  const base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'attachment').replace(/[^\w.-]+/g, '_');
  if (/\.\w{1,5}$/.test(base)) return base;
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt' }[String(type).split(';')[0]];
  return `${base}${ext || ''}`;
}

/** A command this connector does not offer: it exists, and says so in one line. */
const notOffered = (name, why, options = {}) => ({
  help: `not offered by this connector: ${why}`,
  options,
  async run() {
    throw new UsageError(`${name} is not offered by this connector — ${why}`);
  },
});

const GOAL_OPTIONS = {
  task: { type: 'string' }, key: { type: 'string' }, tag: { type: 'string' }, tags: { type: 'boolean' }, owner: { type: 'string' },
  search: { type: 'string' }, state: { type: 'string' }, archived: { type: 'boolean' }, limit: { type: 'string' }, comments: { type: 'string' },
  text: { type: 'string' }, file: { type: 'string' },
};
const NO_GOALS = 'GitHub has no goals (OKRs); the organization\'s resource notes say where its goals are kept';

Object.assign(commands, {
  create: {
    help: 'create an issue (--repo default GITHUB_REPO, --summary, --description|--file, --labels, --create-labels, --assignee me|login[,…], --milestone N|title, --parent ISSUE (as its sub-issue), --add-to-project with --status / --sprint ITERATION, --dry-run)',
    options: {
      repo: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, file: { type: 'string' },
      labels: { type: 'string' }, 'create-labels': { type: 'boolean' }, assignee: { type: 'string' }, milestone: { type: 'string' },
      parent: { type: 'string' }, 'add-to-project': { type: 'boolean' }, status: { type: 'string' }, sprint: { type: 'string' }, ...TEXT,
    },
    run: guarded(async (v) => {
      required(v, 'summary');
      const s = readSettings();
      const full = targetRepo(v, s);
      const policy = statusPolicy(s);
      const body = v.file ? readFileSync(v.file, 'utf8') : v.description;
      checkContent(v, [{ label: 'summary', text: v.summary }, { label: 'description', text: body }]);
      if ((v.status || v.sprint) && !v['add-to-project']) throw new UsageError('--status and --sprint set fields of the project: pass --add-to-project too');
      if (v['add-to-project'] && !s.project) throw new UsageError('--add-to-project adds the issue to the project in GITHUB_PROJECT: set it (the organization project number) in oikos.yaml settings');
      if (v.status && (CLOSING.test(v.status.trim()) || !policy.isAgent(v.status))) {
        throw new Refusal(`a new issue starts only in a status open to an agent (${s.agent.join(', ')}), not '${v.status}'`);
      }
      const wanted = splitList(v.labels);
      const parent = v.parent ? parseTask(v.parent, s) : null;
      const g = gh();
      const repos = await guardRepos(g, s, [full, ...(parent ? [parent.full] : [])]);
      const review = s.project ? [] : wanted.filter((n) => policy.isKnown(n) && !policy.isAgent(n));
      if (review.length) throw new Refusal(`${review.join(', ')}: a status label not open to an agent — a new issue starts only in ${s.agent.join(', ')}`);
      const labels = await labelPlan(g, full, wanted, v['create-labels']);
      const assignees = await assigneesFrom(g, v.assignee);
      const milestone = await milestoneFrom(g, full, v.milestone);
      const parentIssue = parent ? await getIssue(g, parent) : null;
      const project = v['add-to-project'] ? await loadProject(g, s) : null;
      const option = project && v.status ? statusOption(project, v.status, policy) : null;
      const iteration = project && v.sprint ? openIteration(project, v.sprint) : null;
      const payload = { title: v.summary };
      if (body) payload.body = body;
      if (wanted.length) payload.labels = wanted.map(labels.canon);
      if (assignees?.length) payload.assignees = assignees;
      if (milestone?.number) payload.milestone = milestone.number;
      if (v['dry-run']) {
        dryHeader(repos);
        console.log(`Repository: ${full}\nWould create:\n  title: ${v.summary}`);
        if (payload.labels) console.log(`  labels: ${payload.labels.join(', ')}${labels.missing.length ? `  (creates label(s) ${labels.missing.join(', ')} first — --create-labels)` : ''}`);
        if (payload.assignees) console.log(`  assignees: ${payload.assignees.map((a) => `@${a}`).join(', ')}`);
        if (payload.milestone) console.log(`  milestone: ${milestone.number} "${milestone.title}"`);
        if (body) console.log(`  description:\n${'-'.repeat(40)}\n${body}\n${'-'.repeat(40)}`);
        if (parentIssue) console.log(`  then as a sub-issue of ${parent.key} — ${parentIssue.title}`);
        if (project) console.log(`  then add to project ${project.number} "${project.title}"${option ? `, Status ${option.name}` : ''}${iteration ? `, ${project.iteration.name} "${iteration.title}" (${iteration.id})` : ''}`);
        notifyLine(body);
        console.log(NOTHING_WRITTEN);
        return 0;
      }
      if (labels.missing.length) await createLabels(g, full, labels.missing);
      const { data: created } = await g.api(`/repos/${full}/issues`, { method: 'POST', body: payload });
      const done = [];
      if (parentIssue) { await addSubIssue(g, parent, created.id); done.push(`sub-issue of ${parent.key}`); }
      if (project) {
        const itemId = await addToProject(g, project, created.node_id);
        if (option) await setField(g, project, itemId, project.status.id, { singleSelectOptionId: option.id });
        if (iteration) await setField(g, project, itemId, project.iteration.id, { iterationId: iteration.id });
        done.push(`in project ${project.number}${option ? `, ${option.name}` : ''}${iteration ? `, ${iteration.title}` : ''}`);
      }
      console.log(`Created ${full}#${created.number}${done.length ? ` (${done.join('; ')})` : ''}: ${created.html_url}`);
    }),
  },

  edit: {
    help: 'edit one issue or many (--task A,B | --query … --max N; --summary, --description|--file, --labels (set), --add-labels, --remove-labels, --create-labels, --assignee me|login[,…]|none (set), --milestone N|title|none, --dry-run); status labels move through transition; --state is refused',
    options: {
      task: { type: 'string' }, query: { type: 'string' }, max: { type: 'string' },
      summary: { type: 'string' }, description: { type: 'string' }, file: { type: 'string' },
      labels: { type: 'string' }, 'add-labels': { type: 'string' }, 'remove-labels': { type: 'string' }, 'create-labels': { type: 'boolean' },
      assignee: { type: 'string' }, milestone: { type: 'string' }, state: { type: 'string' }, ...TEXT,
    },
    run: guarded(async (v) => {
      const s = readSettings();
      if (v.state !== undefined) {
        const links = v.task ? `: ${taskRefs(v.task, s).map((r) => issueUrl(s, r)).join(' ')}` : '';
        throw new Refusal(`--state: an agent never closes or reopens an issue — that is a person's move${links}`);
      }
      const body = v.file ? readFileSync(v.file, 'utf8') : v.description;
      checkContent(v, [{ label: 'summary', text: v.summary }, { label: 'description', text: body }]);
      const setLabels = v.labels !== undefined ? splitList(v.labels) : null;
      const add = splitList(v['add-labels']);
      const remove = splitList(v['remove-labels']);
      if (setLabels && (add.length || remove.length)) throw new UsageError('--labels sets the whole list: do not combine it with --add-labels / --remove-labels');
      if (!v.summary && body === undefined && !setLabels && !add.length && !remove.length && v.assignee === undefined && v.milestone === undefined) {
        throw new UsageError('nothing to change: pass at least one field option');
      }
      const g = gh();
      const refs = await selectIssues(g, v, s);
      const repos = await guardRepos(g, s, refs.map((r) => r.full));
      const assignees = await assigneesFrom(g, v.assignee);
      const perRepo = new Map();
      for (const full of new Set(refs.map((r) => r.full))) {
        perRepo.set(full, { labels: await labelPlan(g, full, [...(setLabels || []), ...add], v['create-labels']), milestone: await milestoneFrom(g, full, v.milestone) });
      }
      const plans = [];
      for (const ref of refs) {
        const issue = await getIssue(g, ref);
        const { labels, milestone } = perRepo.get(ref.full);
        const current = (issue.labels || []).map((l) => l.name || l);
        const has = (n) => current.some((c) => lower(c) === lower(n));
        const patch = {};
        if (v.summary) patch.title = v.summary;
        if (body !== undefined) patch.body = body;
        if (assignees !== undefined) patch.assignees = assignees;
        if (milestone !== undefined) patch.milestone = milestone.number;
        if (setLabels) patch.labels = setLabels.map(labels.canon);
        const adds = add.map(labels.canon).filter((n) => !has(n));
        const removes = remove.map((n) => current.find((c) => lower(c) === lower(n))).filter(Boolean);
        statusLabelGuard(s, ref, current, { set: patch.labels, add: adds, remove: removes });
        plans.push({ ref, issue, patch, adds, removes, current });
      }
      if (v['dry-run']) {
        dryHeader(repos);
        console.log(`Would edit ${plans.length} issue(s) in ${[...perRepo.keys()].join(', ')}:`);
        for (const p of plans) {
          const labelLine = p.patch.labels ? `  {labels ${p.current.join(', ') || '(none)'} → ${p.patch.labels.join(', ') || '(none)'}}` : (p.adds.length || p.removes.length ? `  {${[...p.adds.map((n) => `+${n}`), ...p.removes.map((n) => `-${n}`)].join(' ')}}` : '');
          console.log(`  ${p.ref.key} — ${p.issue.title}${labelLine}`);
        }
        if (v.summary) console.log(`  title: ${v.summary}`);
        if (assignees !== undefined) console.log(`  assignees: ${assignees.length ? assignees.map((a) => `@${a}`).join(', ') : 'none'}`);
        for (const [full, r] of perRepo) {
          if (r.milestone) console.log(`  milestone in ${full}: ${r.milestone.number ? `${r.milestone.number} "${r.milestone.title}"` : 'none'}`);
          if (r.labels.missing.length) console.log(`  creates label(s) in ${full} first: ${r.labels.missing.join(', ')} (--create-labels)`);
        }
        const skipped = remove.filter((n) => !plans.some((p) => p.removes.some((r) => lower(r) === lower(n))));
        if (skipped.length) console.log(`  not on any selected issue, nothing to remove: ${skipped.join(', ')}`);
        if (body !== undefined) console.log(`  description (replaced):\n${'-'.repeat(40)}\n${body}\n${'-'.repeat(40)}`);
        notifyLine(body);
        console.log(NOTHING_WRITTEN);
        return 0;
      }
      for (const [full, r] of perRepo) if (r.labels.missing.length) await createLabels(g, full, r.labels.missing);
      let failed = 0;
      for (const p of plans) {
        const path = `/repos/${p.ref.full}/issues/${p.ref.number}`;
        try {
          if (Object.keys(p.patch).length) await g.api(path, { method: 'PATCH', body: p.patch });
          if (p.adds.length) await g.api(`${path}/labels`, { method: 'POST', body: { labels: p.adds } });
          for (const name of p.removes) await g.api(`${path}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' });
          console.log(`edited ${p.ref.key}`);
        } catch (e) {
          failed += 1;
          console.error(`${p.ref.key}: ${e.message}`);
        }
      }
      console.log(`${plans.length - failed}/${plans.length} edited`);
      return failed ? 2 : 0;
    }),
  },

  comment: {
    help: 'post a markdown comment (--task, --text or --file; --dry-run; the @mentions are listed — they notify)',
    options: { task: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, ...TEXT },
    run: guarded(async (v) => {
      required(v, 'task');
      const s = readSettings();
      const ref = parseTask(v.task, s);
      const text = readText(v);
      if (!text?.trim()) throw new UsageError('--text or --file is required');
      checkContent(v, [{ label: 'comment', text }]);
      const dry = Boolean(v['dry-run']);
      // The preview of a comment needs nothing from GitHub, so an explicit --dry-run runs without
      // credentials; with them it also checks the repository's visibility and the issue.
      let g = null;
      let offline = '';
      try {
        g = gh();
      } catch (e) {
        if (!(dry && e instanceof UsageError)) throw e;
        offline = e.message;
      }
      const repos = g ? await guardRepos(g, s, [ref.full]) : [];
      if (dry) {
        const issue = g ? await getIssue(g, ref) : null;
        dryHeader(repos);
        console.log(`Repository: ${ref.full}`);
        console.log(`Issue:      ${ref.key}${issue ? ` — ${issue.title}${issue.state === 'closed' ? ' [closed]' : ''}` : ''}`);
        console.log(`Target:     ${issueUrl(s, ref)}`);
        notifyLine(text);
        console.log(`Comment that WOULD be posted:\n${'-'.repeat(40)}\n${text}\n${'-'.repeat(40)}`);
        console.log(NOTHING_WRITTEN);
        if (!g) offlineNote(offline);
        return 0;
      }
      const r = await g.api(`/repos/${ref.full}/issues/${ref.number}/comments`, { method: 'POST', body: { body: text } });
      console.log(`Posted comment to ${ref.key} (HTTP ${r.status}): ${r.data.html_url || issueUrl(s, ref)}`);
    }),
  },

  transition: {
    help: 'move an issue among the statuses open to an agent only (GITHUB_AGENT_STATUSES; the project Status field, else labels; --task, --to, --dry-run); never closes or reopens',
    options: { task: { type: 'string' }, to: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    run: guarded(async (v) => {
      required(v, 'task', 'to');
      const s = readSettings();
      const ref = parseTask(v.task, s);
      const policy = statusPolicy(s);
      const url = issueUrl(s, ref);
      if (CLOSING.test(v.to.trim())) throw new Refusal(`an agent never closes or reopens an issue — '${v.to}' is a person's move: ${url}`);
      if (!policy.isAgent(v.to)) throw new Refusal(`an agent moves an issue only among ${s.agent.join(', ')} — move ${ref.key} to '${v.to}' yourself: ${url}`);
      // Even the dry run reads the visibility, the issue and its current status.
      const g = gh();
      const repos = await guardRepos(g, s, [ref.full]);
      const issue = await getIssue(g, ref);
      if (issue.state === 'closed') throw new Refusal(`${ref.key} is closed — reopening is a person's move: ${url}`);
      const plan = await movePlan(g, s, ref, issue, v.to, policy);
      if (plan.from && lower(plan.from) === lower(plan.to)) {
        console.log(`${ref.key} is already ${plan.from} (${plan.source}) — nothing to do`);
        return 0;
      }
      if (v['dry-run']) {
        dryHeader(repos);
        console.log(`Repository: ${ref.full}\nIssue:      ${ref.key} — ${issue.title}\nSource:     ${plan.source}\nWould move: ${plan.from || '(no status)'} → ${plan.to}`);
        for (const step of plan.steps) console.log(`  ${step}`);
        console.log(NOTHING_WRITTEN);
        return 0;
      }
      await applyMove(g, plan);
      console.log(`${ref.key}: ${plan.from || '(no status)'} → ${plan.to} (${plan.source})`);
    }),
  },

  'move-to-sprint': {
    help: 'move issues into an iteration of GITHUB_PROJECT, or out of it (--sprint ITERATION id|title | --backlog; --task A,B | --query … --max N; --add-to-project for issues not in the project yet; milestones when the project has no iteration field; --dry-run)',
    options: {
      sprint: { type: 'string' }, backlog: { type: 'boolean' }, task: { type: 'string' }, query: { type: 'string' }, max: { type: 'string' },
      'add-to-project': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    },
    run: guarded(async (v) => {
      if (!v.sprint === !v.backlog) throw new UsageError('one of --sprint ITERATION or --backlog is required');
      const s = readSettings();
      requireProject(s, 'sprints');
      const g = gh();
      const refs = await selectIssues(g, v, s);
      const repos = await guardRepos(g, s, refs.map((r) => r.full));
      const project = await loadProject(g, s);
      if (!project.iteration) return milestoneMove(g, s, v, project, refs, repos);
      const it = v.backlog ? null : openIteration(project, v.sprint);
      const plans = [];
      for (const ref of refs) {
        const { node, item } = await issueInProject(g, ref, project);
        if (!item && it && !v['add-to-project']) {
          throw new Refusal(`${ref.key} is not in project ${project.number} "${project.title}" — pass --add-to-project to add it, or add it in GitHub: ${project.url}`);
        }
        plans.push({ ref, node, item });
      }
      const target = it ? `${project.iteration.name} "${it.title}" (${it.id}, ${it.state}, ${iterationDates(it)})` : `the backlog (${project.iteration.name} cleared)`;
      if (v['dry-run']) {
        dryHeader(repos);
        console.log(`Project: ${project.number} "${project.title}" — field ${project.iteration.name}\nTarget:  ${target}\nWould move ${plans.length} issue(s):`);
        for (const p of plans) {
          const from = p.item ? (p.item.iteration ? `"${p.item.iteration.title}"` : '(no iteration)') : 'not in the project';
          const note = p.item ? '' : it ? ' — added to the project first (--add-to-project)' : ' — nothing to clear';
          console.log(`  ${p.ref.key} — ${p.node.title}  [${from} → ${it ? `"${it.title}"` : 'backlog'}]${note}`);
        }
        console.log(NOTHING_WRITTEN);
        return 0;
      }
      let failed = 0;
      for (const p of plans) {
        try {
          if (!p.item && !it) { console.log(`${p.ref.key}: not in the project — nothing to clear`); continue; }
          const itemId = p.item?.id || (await addToProject(g, project, p.node.id));
          if (it) await setField(g, project, itemId, project.iteration.id, { iterationId: it.id });
          else await g.graphql(CLEAR_FIELD, { input: { projectId: project.id, itemId, fieldId: project.iteration.id } });
        } catch (e) {
          failed += 1;
          console.error(`${p.ref.key}: ${e.message}`);
        }
      }
      console.log(`Moved ${plans.length - failed}/${plans.length} issue(s) to ${target}`);
      return failed ? 2 : 0;
    }),
  },

  link: {
    help: 'link two issues: --from A --type parent|child|blocks|blocked-by --to B means "A <type> B" (sub-issues and issue dependencies; --dry-run); --types lists the types',
    options: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' }, types: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    run: guarded(async (v) => {
      if (v.types) {
        for (const [name, t] of Object.entries(LINK_TYPES)) console.log(`${name.padEnd(12)} A ${t.says} B`);
        console.log('any other relation: mention it in a comment');
        return 0;
      }
      required(v, 'from', 'to', 'type');
      const type = lower(v.type);
      const spec = LINK_TYPES[type];
      if (!spec) throw new UsageError(`link type '${v.type}' is not offered by GitHub (${Object.keys(LINK_TYPES).join(', ')}) — mention it in a comment: ${TOOL} comment --task ${v.from} --text …`);
      const s = readSettings();
      const a = parseTask(v.from, s);
      const b = parseTask(v.to, s);
      if (a.key === b.key) throw new UsageError(`an issue is not linked to itself: ${a.key}`);
      const [holder, named] = linkSides(type, a, b);
      const g = gh();
      const repos = await guardRepos(g, s, [a.full, b.full]);
      const issues = { [a.key]: await getIssue(g, a), [b.key]: await getIssue(g, b) };
      const namedId = issues[named.key].id;
      const as = spec.endpoint === 'sub_issues' ? `${named.key} becomes a sub-issue of ${holder.key}` : `${holder.key} is blocked by ${named.key} (issue dependency)`;
      if (v['dry-run']) {
        dryHeader(repos);
        console.log(`Would link: ${a.key} —${type}→ ${b.key}`);
        console.log(`  ${a.key} — ${issues[a.key].title}\n  ${b.key} — ${issues[b.key].title}`);
        console.log(`As: ${as} (POST /repos/${holder.full}/issues/${holder.number}/${spec.endpoint}, ${spec.field} ${namedId})`);
        console.log(NOTHING_WRITTEN);
        return 0;
      }
      await g.api(`/repos/${holder.full}/issues/${holder.number}/${spec.endpoint}`, { method: 'POST', body: { [spec.field]: namedId } });
      console.log(`Linked ${a.key} —${type}→ ${b.key}: ${as}`);
    }),
  },

  attachment: {
    help: 'download a file linked in an issue, best effort (--task, --id n from the Attachments list of info, or --url; --dir default .)',
    options: { task: { type: 'string' }, id: { type: 'string' }, url: { type: 'string' }, dir: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      if (!v.id && !v.url) throw new UsageError('--id (from the Attachments list of info) or --url is required');
      const s = readSettings();
      const ref = parseTask(v.task, s);
      const g = gh();
      const issue = await getIssue(g, ref);
      const comments = issue.comments ? await g.paged(`/repos/${ref.full}/issues/${ref.number}/comments`, 200) : [];
      const files = attachmentUrls([issue.body, ...comments.map((c) => c.body)].join('\n'), s.serverUrl);
      // Only a link the issue itself carries is fetched: the credential goes to GitHub, nowhere else.
      const url = v.url || files[Number(v.id) - 1];
      if (!url || !files.includes(url)) throw new UsageError(`${ref.key} has no attachment ${v.url || v.id}. Attachments: ${files.map((u, n) => `[${n + 1}] ${u}`).join(' ') || 'none'}`);
      let r;
      try {
        r = await g.api(url, { as: 'buffer', headers: { Accept: '*/*' } });
      } catch (e) {
        if (!(e instanceof UsageError || e instanceof HttpError)) throw e;
        throw new UsageError(`could not download ${url} (${e.message}) — GitHub may serve uploaded files only to a signed-in browser; open it there: ${issue.html_url}`);
      }
      const type = r.headers.get('content-type') || 'unknown type';
      const dir = v.dir || '.';
      mkdirSync(dir, { recursive: true });
      const path = join(dir, attachmentName(url, type));
      writeFileSync(path, r.data);
      console.log(`Saved ${url} (${type}, ${r.data.length} bytes) → ${path}`);
    },
  },

  attach: {
    help: 'not offered by this connector: GitHub has no API to upload a file to an issue (F2) — prints the route a person takes (--task)',
    options: { task: { type: 'string' }, file: { type: 'string' } },
    async run(v) {
      const s = readSettings();
      const where = v.task ? `: ${issueUrl(s, parseTask(v.task, s))}` : '';
      throw new UsageError(`attach is not offered by this connector — GitHub has no API to upload a file to an issue (F2); a person drags the file into a comment in the browser${where}`);
    },
  },

  goals: notOffered('goals', NO_GOALS, GOAL_OPTIONS),
  goal: notOffered('goal', NO_GOALS, GOAL_OPTIONS),
  'goal-comment': notOffered('goal-comment', NO_GOALS, GOAL_OPTIONS),
});

if (isMain(import.meta.url)) runCli('github-issues', commands, { connector: 'github-issues' });
