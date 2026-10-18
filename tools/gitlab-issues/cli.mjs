#!/usr/bin/env node
// GitLab issues for the skill task-tracking (connector gitlab-issues): read tasks, search, boards,
// milestones or iterations as sprints; create, edit, comment, link, move between sprints and among
// the status labels open to an agent — every write under --dry-run first.
// The status of an issue is a label: GITLAB_AGENT_STATUSES lists the labels an agent may move a task
// among, GITLAB_REVIEW_STATUSES those from which on only a person moves it. There is no default, so
// without the first `transition` is refused. An agent never closes or reopens an issue.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runCli, required, printJson, nonLatinLetters, isMain, UsageError } from '../common/cli.mjs';
import { gitlabClient, projectPath as pp } from '../common/gitlab.mjs';
import { HttpError } from '../common/http.mjs';
import { envValue, credentialsHelp } from '../common/env.mjs';

const TOOL = 'node oikos/tools/gitlab-issues/cli.mjs';
const DEFAULT_MAX = 50;
const WRITE_COMMANDS = 'create, edit, comment, transition, move-to-sprint, link';
const LINK_TYPES = ['relates_to', 'blocks', 'is_blocked_by'];
const BLOCKING = new Set(['blocks', 'is_blocked_by']);
// Iterations report their state as a number in REST (TV); newer versions may send the name.
const ITERATION_STATE = { 1: 'upcoming', 2: 'current', 3: 'closed' };

/** A guard's refusal: printed as `refused: …`, exit 3 (see `guarded`). */
export class Refusal extends Error {}

const writeHelp = (base) => [
  `  Token: scope api for the writes (${WRITE_COMMANDS}); read_api is enough for reads: ${base}/-/user_settings/personal_access_tokens`,
];

/** The GitLab client of this tool; a missing site or token is a usage error before any request. */
const gl = () => gitlabClient('gitlab-issues', { help: writeHelp });

/** GITLAB_URL without a trailing slash, for links printed without a client; a placeholder when unset. */
const siteUrl = () => (envValue('GITLAB_URL') || '<GITLAB_URL>').replace(/\/+$/, '');

/** A command's run that turns a Refusal into `refused: …` on stderr and exit 3. */
function guarded(run) {
  return async (v, positionals) => {
    try {
      return await run(v, positionals);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      console.error(`refused: ${e.message}`);
      return 3;
    }
  };
}

// == task references ==

/**
 * A task reference as { project, iid }: `group/sub/project#12`, `#12` or `12` in the default
 * `project` (GITLAB_PROJECT), or an issue URL on the site `base` (`<base>/group/project/-/issues/12`,
 * also `/-/work_items/12`). Anything else is a usage error that names the accepted forms.
 */
export function parseTask(ref, { project, base } = {}) {
  const s = String(ref ?? '').trim();
  const bare = s.match(/^#?(\d+)$/);
  if (bare) {
    if (!project) throw new UsageError(`'${s}' names no project: use group/project#${bare[1]}, or set GITLAB_PROJECT in oikos.yaml settings`);
    return { project, iid: Number(bare[1]) };
  }
  const full = s.match(/^([\w.-]+(?:\/[\w.-]+)+)#(\d+)$/);
  if (full) return { project: full[1], iid: Number(full[2]) };
  if (/^https?:\/\//i.test(s)) return parseIssueUrl(s, base);
  throw new UsageError(`not a task reference: '${s}' — use group/project#12, #12 with GITLAB_PROJECT, or an issue URL`);
}

function parseIssueUrl(s, base) {
  const url = new URL(s);
  const site = base ? new URL(base) : null;
  if (site && url.host !== site.host) throw new UsageError(`${s} is not on GITLAB_URL (${site.host})`);
  let path = decodeURIComponent(url.pathname);
  // A site served under a path (https://example.com/gitlab) prefixes every project path.
  const prefix = site ? site.pathname.replace(/\/+$/, '') : '';
  if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
  const m = path.match(/^\/(.+?)\/-\/(?:issues|work_items)\/(\d+)\/?$/);
  if (!m) throw new UsageError(`not an issue URL: ${s} — expected …/group/project/-/issues/12`);
  if (m[1].startsWith('groups/')) throw new UsageError(`${s} is a group work item (an epic): not offered by this connector`);
  return { project: m[1], iid: Number(m[2]) };
}

const refText = (ref) => `${ref.project}#${ref.iid}`;
const issueApi = (ref) => `/projects/${pp(ref.project)}/issues/${ref.iid}`;
const issueUrl = (base, ref) => `${base}/${ref.project}/-/issues/${ref.iid}`;

/** The reference of an issue payload: its full reference, else derived from its web URL. */
function refOf(issue) {
  const full = issue.references?.full;
  if (full && /#\d+$/.test(full)) return parseTask(full);
  const web = issue.web_url && issue.web_url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/(?:issues|work_items)\/(\d+)/);
  if (web) return { project: web[1], iid: Number(web[2]) };
  return { project: String(issue.project_id), iid: issue.iid };
}

const splitList = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

/** Every task reference in `--task A,B`, resolved against the default project and the site. */
const taskRefs = (value, base) => splitList(value).map((t) => parseTask(t, { project: envValue('GITLAB_PROJECT'), base }));

// == status labels ==

/**
 * The status policy from the settings: { agent, review } — label names, comma separated in
 * GITLAB_AGENT_STATUSES and GITLAB_REVIEW_STATUSES, compared case-insensitively. No defaults.
 */
export function statusPolicy() {
  return { agent: splitList(envValue('GITLAB_AGENT_STATUSES')), review: splitList(envValue('GITLAB_REVIEW_STATUSES')) };
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const inList = (list, name) => list.some((x) => same(x, name));
const labelNames = (issue) => (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

/** An issue's status: `closed`, its first status label (agent or review), else `open`. */
export function statusOf(issue, policy) {
  if (issue.state === 'closed') return 'closed';
  return labelNames(issue).find((l) => inList(policy.agent, l) || inList(policy.review, l)) || 'open';
}

// == text guards ==

/** The users an @mention in markdown notifies (code spans and fences do not notify). */
export function mentions(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out = new Set();
  for (const m of prose.matchAll(/(?<![\w.@/])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g)) out.add(m[1]);
  return [...out];
}

function notifyLine(...texts) {
  const who = mentions(texts.filter(Boolean).join('\n'));
  return who.length ? `will notify ${who.map((u) => `@${u}`).join(', ')}` : null;
}

function englishOnly(v, ...texts) {
  const foreign = nonLatinLetters(texts.filter(Boolean).join(' '));
  if (foreign && !v['allow-non-english']) {
    throw new UsageError(`GitLab content is English, found non-Latin letters: ${foreign}. Translate, or pass --allow-non-english.`);
  }
}

const readText = (v) => (v.file ? readFileSync(v.file, 'utf8') : v.text);
const readDescription = (v) => (v.file ? readFileSync(v.file, 'utf8') : v.description);

// == output ==

const day = (s) => (s ? String(s).slice(0, 10) : '?');
const people = (list) => (list || []).map((a) => `@${a.username}`).join(' ');

function issueLine(issue, policy) {
  const who = people(issue.assignees);
  const ms = issue.milestone ? ` %${issue.milestone.title}` : '';
  return `${refText(refOf(issue))} [${statusOf(issue, policy)}] ${issue.title || ''}${who ? ` ${who}` : ''}${ms}`;
}

function dryHeader() {
  console.log('--- DRY RUN (requested --dry-run) ---');
}

const dryFooter = () => console.log('DRY RUN — nothing written to GitLab.');

/** `/uploads/<secret>/<file>` links in the description and the comments, in order, once each. */
export function uploadsIn(...texts) {
  const seen = new Map();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/\/uploads\/([0-9a-f]{8,64})\/([^\s)"'<>\]]+)/gi)) {
      const key = `${m[1]}/${m[2]}`;
      if (!seen.has(key)) seen.set(key, { secret: m[1], file: m[2], name: safeDecode(m[2]) });
    }
  }
  return [...seen.values()];
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// == reads shared by the commands ==

async function fetchIssue(g, ref) {
  return g.get(issueApi(ref));
}

async function fetchNotes(g, ref, limit = 500) {
  return g.paged(`${issueApi(ref)}/notes?sort=asc&order_by=created_at`, limit);
}

/** Rows of a list endpoint and whether there were more than `limit`. */
async function pagedCut(g, path, limit) {
  const rows = await g.paged(path, limit + 1);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Where a list of issues is read: { project } from --project, { group } from --group, else the
 * defaults GITLAB_PROJECT, GITLAB_GROUP; {} means every issue the token sees.
 */
function scopeOf(v) {
  if (v.project) return { project: v.project };
  if (v.group) return { group: v.group };
  const project = envValue('GITLAB_PROJECT');
  if (project) return { project };
  const group = envValue('GITLAB_GROUP');
  return group ? { group } : {};
}

function issuesPath(scope, query) {
  if (scope.project) return `/projects/${pp(scope.project)}/issues?${query}`;
  if (scope.group) return `/groups/${pp(scope.group)}/issues?${query}`;
  query.set('scope', 'all');
  return `/issues?${query}`;
}

const scopeText = (scope) => (scope.project ? `project ${scope.project}` : scope.group ? `group ${scope.group}` : 'every project the token sees');

/** The list filter of `search`: `--query` (GitLab's own parameters) with the filter flags on top. */
async function searchQuery(g, v) {
  const q = new URLSearchParams(v.query || '');
  for (const k of ['page', 'per_page']) q.delete(k);
  const state = v.state || q.get('state') || 'opened';
  if (!['opened', 'closed', 'all'].includes(state)) throw new UsageError(`--state is opened, closed or all, not '${state}'`);
  q.set('state', state);
  if (v.labels) q.set('labels', v.labels);
  if (v.milestone) q.set('milestone', v.milestone);
  if (v.search) q.set('search', v.search);
  if (v.iteration) q.set('iteration_id', v.iteration);
  if (v.assignee === 'none') q.set('assignee_id', 'None');
  else if (v.assignee) q.set('assignee_username', await username(g, v.assignee));
  if (!q.has('order_by')) q.set('order_by', 'updated_at');
  return q;
}

/** `me` → the token owner's username; `@name` → `name`. */
async function username(g, who) {
  if (who === 'me') return (await g.get('/user')).username;
  return who.replace(/^@/, '');
}

/** A user id for `me` or a username. */
async function userId(g, who) {
  if (who === 'me') return (await g.get('/user')).id;
  const name = who.replace(/^@/, '');
  const users = await g.get(`/users?username=${encodeURIComponent(name)}`);
  if (!users.length) throw new UsageError(`no GitLab user @${name}`);
  return users[0].id;
}

/**
 * The issues a bulk write acts on: `--task A,B` or `--query` (GitLab list parameters, read in the
 * scope of --project / --group / the defaults). More than `max` is a usage error: a wide selection
 * never changes more than the user saw.
 */
async function selectIssues(g, v) {
  const max = Number(v.max || DEFAULT_MAX);
  let issues;
  if (v.task) {
    const refs = taskRefs(v.task, g.base);
    if (refs.length > max) throw new UsageError(`--task names ${refs.length} issues, more than --max ${max}; raise --max if that is meant`);
    issues = [];
    for (const ref of refs) issues.push(await fetchIssue(g, ref));
  } else if (v.query) {
    const q = new URLSearchParams(v.query);
    for (const k of ['page', 'per_page']) q.delete(k);
    if (!q.has('state')) q.set('state', 'opened');
    const rows = await g.paged(issuesPath(scopeOf(v), q), max + 1);
    if (rows.length > max) throw new UsageError(`the query selects more than --max ${max} issues; narrow it or raise --max`);
    issues = rows;
  } else {
    throw new UsageError('--task REF[,REF…] or --query is required');
  }
  if (!issues.length) throw new UsageError('the selection is empty: nothing to change');
  return issues;
}

/** The labels a project can use (its own and its groups'), cached per project. */
async function projectLabels(g, project, cache) {
  if (!cache.has(project)) {
    const rows = await g.paged(`/projects/${pp(project)}/labels?include_ancestor_groups=true`, 2000);
    cache.set(project, rows.map((l) => l.name));
  }
  return cache.get(project);
}

/**
 * Refuse labels a project does not have: GitLab creates an unknown label silently on write, so a
 * typo would become a new label. With --create-labels they are allowed and returned to be shown.
 */
async function guardLabels(g, project, names, v, cache) {
  if (!names.length) return [];
  const known = await projectLabels(g, project, cache);
  const unknown = names.filter((n) => !known.includes(n));
  if (!unknown.length || v['create-labels']) return unknown;
  const near = unknown.map((n) => known.find((k) => same(k, n))).filter(Boolean);
  throw new Refusal(`unknown label(s) in ${project}: ${unknown.join(', ')} — GitLab would create them. `
    + `${near.length ? `Did you mean ${near.join(', ')}? ` : ''}Pass --create-labels if new labels are meant.`);
}

// == sprints: milestones or iterations ==

/** GITLAB_SPRINTS: `milestones` (default) or `iterations`. */
function sprintMode() {
  const mode = (envValue('GITLAB_SPRINTS') || 'milestones').trim().toLowerCase();
  if (!['milestones', 'iterations'].includes(mode)) throw new UsageError(`GITLAB_SPRINTS is milestones or iterations, not '${mode}'`);
  return mode;
}

/**
 * Milestone `id` (its global id) as one the issues of `project` can take: the project's own, else
 * its group's. { milestone, owner, issuesPath }.
 */
async function projectMilestone(g, project, id) {
  try {
    const milestone = await g.get(`/projects/${pp(project)}/milestones/${id}`);
    return { milestone, owner: `project ${project}`, issuesPath: `/projects/${pp(project)}/milestones/${id}/issues` };
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
  }
  const ns = (await g.get(`/projects/${pp(project)}`)).namespace;
  if (ns?.kind === 'group') {
    try {
      return await groupMilestone(g, ns.full_path, id);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
    }
  }
  throw new UsageError(`milestone ${id} is neither a milestone of ${project} nor of its group — \`sprints\` lists them (the id, not the title)`);
}

async function groupMilestone(g, group, id) {
  const milestone = await g.get(`/groups/${pp(group)}/milestones/${id}`);
  return { milestone, owner: `group ${group}`, issuesPath: `/groups/${pp(group)}/milestones/${id}/issues` };
}

/** The group that holds the iterations: --group, GITLAB_GROUP, else the group of `project`. */
async function iterationGroup(g, v, project) {
  const group = v.group || envValue('GITLAB_GROUP');
  if (group) return group;
  if (project) {
    const ns = (await g.get(`/projects/${pp(project)}`)).namespace;
    if (ns?.kind === 'group') return ns.full_path;
  }
  throw new UsageError('iterations belong to a group: pass --group or set GITLAB_GROUP in oikos.yaml settings');
}

async function findIteration(g, group, id) {
  const rows = await g.paged(`/groups/${pp(group)}/iterations?state=all&include_ancestors=true`, 1000);
  const it = rows.find((r) => String(r.id) === String(id));
  if (!it) throw new UsageError(`iteration ${id} is not an iteration of group ${group} — \`sprints\` lists them`);
  return it;
}

const iterationState = (it) => ITERATION_STATE[it.state] || String(it.state || '?');
const iterationTitle = (it) => it.title || it.iteration_cadence?.title || `iteration ${it.iid ?? it.id}`;
const milestoneText = (m) => `milestone ${m.id} "${m.title}" [${m.state}] ${day(m.start_date)} → ${day(m.due_date)}`;
const iterationText = (it) => `iteration ${it.id} "${iterationTitle(it)}" [${iterationState(it)}] ${day(it.start_date)} → ${day(it.due_date)}`;
const ITERATION_TV = 'iteration_id through PUT /issues is unverified until checked live — check the issue after the write';

// == info and context ==

function infoLines(issue, notes, links, policy) {
  const ref = refOf(issue);
  const out = [`Task: ${refText(ref)}`, `Title: ${issue.title || ''}`];
  out.push(`Type: ${issue.issue_type || issue.type || 'issue'}   State: ${issue.state}   Status: ${statusOf(issue, policy)}   `
    + `Assignees: ${people(issue.assignees) || 'unassigned'}   Author: ${issue.author ? `@${issue.author.username}` : '-'}`);
  if (issue.milestone) out.push(`Milestone: ${milestoneText(issue.milestone)}`);
  if (issue.iteration) out.push(`Iteration: ${iterationText(issue.iteration)}`);
  if (issue.due_date) out.push(`Due: ${issue.due_date}`);
  if (issue.confidential) out.push('Confidential: yes');
  const labels = labelNames(issue);
  if (labels.length) out.push(`Labels: ${labels.join(', ')}`);
  if (links.length) out.push('Links:', ...links.map((l) => `  ${l.link_type || 'relates_to'} ${issueLine(l, policy)}`));
  out.push('', 'Description:', (issue.description || '').trim() || '(empty — the title above is the whole specification)');
  const comments = notes.filter((n) => !n.system);
  const uploads = uploadsIn(issue.description, ...comments.map((n) => n.body));
  if (uploads.length) {
    out.push('', 'Attachments:');
    uploads.forEach((u, i) => out.push(`  [${i + 1}] ${u.name} — NOT READ`));
    out.push(`  Fetch: ${TOOL} attachment --task ${refText(ref)} --id <n> [--dir DIR]`);
  }
  if (comments.length) {
    out.push('', `Comments (${comments.length}${notes.length > comments.length ? `; ${notes.length - comments.length} system notes not shown` : ''}):`);
    for (const n of comments) {
      out.push(`  --- @${n.author?.username || '?'}, ${day(n.created_at)}`);
      for (const line of (n.body || '(empty)').split('\n')) if (line.trim()) out.push(`      ${line.trim()}`);
    }
  }
  if (uploads.length) {
    out.push('', 'NOTE — part of this task is in files (images, documents). Fetch the attachment and read it; '
      + 'if it stays unclear, ask the user. Do not rebuild it from the surrounding text.');
  }
  return out;
}

async function readIssue(g, v) {
  const ref = parseTask(v.task, { project: envValue('GITLAB_PROJECT'), base: g.base });
  const issue = await fetchIssue(g, ref);
  const notes = await fetchNotes(g, ref);
  const links = await g.get(`${issueApi(ref)}/links`);
  return { ref, issue, notes, links };
}

function contextWarnings(issue, policy, mode) {
  const warnings = [];
  const labels = labelNames(issue);
  const status = labels.filter((l) => inList(policy.agent, l) || inList(policy.review, l));
  if (issue.state === 'closed') warnings.push('the issue is closed — closed tasks are not worked on, and only a person reopens one.');
  if (labels.some((l) => inList(policy.review, l))) warnings.push(`status is ${status.join(', ')} — from review on only a person moves the task.`);
  if (!policy.agent.length) warnings.push('GITLAB_AGENT_STATUSES is not set — `transition` is refused until the status labels are configured.');
  else if (issue.state !== 'closed' && !status.length) warnings.push('the issue carries no status label.');
  if (status.length > 1) warnings.push(`the issue carries ${status.length} status labels (${status.join(', ')}).`);
  const sprint = mode === 'iterations' ? issue.iteration : issue.milestone;
  if (!sprint && issue.state !== 'closed') warnings.push(`the issue is in no ${mode === 'iterations' ? 'iteration' : 'milestone'}.`);
  if (issue.milestone?.state === 'closed') warnings.push('its milestone is closed.');
  if (issue.confidential) warnings.push('the issue is confidential — what is written to it stays visible to project members only.');
  return warnings;
}

// == commands ==

const FILTERS = {
  project: { type: 'string' }, group: { type: 'string' }, labels: { type: 'string' }, milestone: { type: 'string' },
  state: { type: 'string' }, search: { type: 'string' }, assignee: { type: 'string' }, iteration: { type: 'string' },
  query: { type: 'string' }, limit: { type: 'string' },
};

const commands = {
  whoami: {
    help: 'check the token: which GitLab user the tool acts as, the token scopes, the settings',
    options: {},
    async run(v) {
      const g = gl();
      const me = await g.get('/user');
      let token = null;
      try {
        token = await g.get('/personal_access_tokens/self');
      } catch (e) {
        if (!(e instanceof UsageError || e instanceof HttpError)) throw e;
      }
      if (v.json) return printJson({ user: me, token });
      console.log(`@${me.username} (${me.name}) on ${g.base}`);
      if (Array.isArray(token?.scopes)) {
        console.log(`Token scopes: ${token.scopes.join(', ') || '(none)'}${token.expires_at ? `   expires ${token.expires_at}` : ''}`);
        if (!token.scopes.includes('api')) console.log(`WARNING: writes need scope api — this token reads only (${WRITE_COMMANDS} would be rejected).`);
      } else {
        console.log('Token scopes: not reported (GET /personal_access_tokens/self failed — not a personal access token, or an older GitLab)');
      }
      console.log('Settings:');
      for (const key of ['GITLAB_PROJECT', 'GITLAB_GROUP', 'GITLAB_SPRINTS', 'GITLAB_AGENT_STATUSES', 'GITLAB_REVIEW_STATUSES']) {
        console.log(`  ${key.padEnd(24)} ${envValue(key) ?? '(not set)'}`);
      }
      console.log(credentialsHelp(['GITLAB_URL', 'GITLAB_TOKEN']));
    },
  },

  info: {
    help: 'a task: title, state, status label, labels, milestone, links, description, attachments, comments (--task)',
    options: { task: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      const g = gl();
      const { issue, notes, links } = await readIssue(g, v);
      if (v.json) return printJson({ issue, notes, links });
      console.log(infoLines(issue, notes, links, statusPolicy()).join('\n'));
      console.log(`\n${issue.web_url}`);
    },
  },

  context: {
    help: 'info plus the sprint (milestone or iteration) and warnings — read before working on a task (--task)',
    options: { task: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      const mode = sprintMode();
      const g = gl();
      const { issue, notes, links } = await readIssue(g, v);
      if (v.json) return printJson({ issue, notes, links });
      const policy = statusPolicy();
      const out = ['## Task', ...infoLines(issue, notes, links, policy), '', `## Sprint (${mode})`];
      const sprint = mode === 'iterations' ? issue.iteration : issue.milestone;
      out.push(sprint ? `  ${mode === 'iterations' ? iterationText(sprint) : milestoneText(sprint)}` : '  (none)');
      const warnings = contextWarnings(issue, policy, mode);
      out.push('', '## Warnings', ...(warnings.length ? warnings.map((w) => `  - ${w}`) : ['  (none)']));
      console.log(out.join('\n'));
      console.log(`\n${issue.web_url}`);
    },
  },

  search: {
    help: 'issues by filter (--labels a,b, --milestone TITLE, --state opened|closed|all, --search text, --assignee me|<username>|none, --iteration ID; --query "GitLab list parameters"; in --project / --group / GITLAB_PROJECT / GITLAB_GROUP, else every visible project; --limit default 50)',
    options: FILTERS,
    async run(v) {
      const g = gl();
      const scope = scopeOf(v);
      const limit = Number(v.limit || 50);
      const { rows, truncated } = await pagedCut(g, issuesPath(scope, await searchQuery(g, v)), limit);
      if (v.json) return printJson(rows);
      const policy = statusPolicy();
      for (const i of rows) console.log(issueLine(i, policy));
      console.log(`${rows.length} issue(s) in ${scopeText(scope)}${truncated ? ' … more (raise --limit)' : ''}`);
    },
  },

  mine: {
    help: 'open issues assigned to a person, by status (--user me|<username>, default me; --all to include closed; --limit)',
    options: { user: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const g = gl();
      const who = v.user || 'me';
      const state = v.all ? 'all' : 'opened';
      let user;
      let path;
      if (who === 'me') {
        user = await g.get('/user');
        path = `/issues?scope=assigned_to_me&state=${state}&order_by=updated_at`;
      } else {
        const name = who.replace(/^@/, '');
        [user] = await g.get(`/users?username=${encodeURIComponent(name)}`);
        if (!user) throw new UsageError(`no GitLab user @${name}`);
        path = `/issues?scope=all&assignee_username=${encodeURIComponent(name)}&state=${state}&order_by=updated_at`;
      }
      const limit = Number(v.limit || 100);
      const { rows, truncated } = await pagedCut(g, path, limit);
      if (v.json) return printJson({ user, issues: rows });
      const policy = statusPolicy();
      console.log(`@${user.username} (${user.name})${who === 'me' ? ' — the owner of GITLAB_TOKEN' : ''}`);
      console.log(`\n## Issues assigned${v.all ? '' : ', open'} (${rows.length}${truncated ? '+' : ''})`);
      for (const [status, list] of groupBy(rows, (i) => statusOf(i, policy))) {
        console.log(`\n### ${status} (${list.length})`);
        for (const i of list) console.log(`  ${issueLine(i, policy)}`);
      }
      if (truncated) console.log(`\n… more (raise --limit above ${limit})`);
    },
  },

  boards: {
    help: 'issue boards and their lists (--project or --group, default GITLAB_PROJECT / GITLAB_GROUP); read-only',
    options: { project: { type: 'string' }, group: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const scope = scopeOf(v);
      if (!scope.project && !scope.group) throw new UsageError('--project or --group is required (or GITLAB_PROJECT / GITLAB_GROUP in oikos.yaml settings)');
      const g = gl();
      const path = scope.project ? `/projects/${pp(scope.project)}/boards` : `/groups/${pp(scope.group)}/boards`;
      const boards = await g.paged(path, Number(v.limit || 100));
      if (v.json) return printJson(boards);
      for (const b of boards) {
        console.log(`${String(b.id).padStart(6)}  ${b.name}${b.milestone ? `  (scoped to %${b.milestone.title})` : ''}`);
        for (const l of b.lists || []) console.log(`        ${l.position}. ${listName(l)}`);
      }
      console.log(`${boards.length} board(s) in ${scopeText(scope)}; every board also has its Open and Closed lists`);
    },
  },

  sprints: {
    help: 'the sprints by GITLAB_SPRINTS: milestones of the project and its group (--state active|closed|all, default active), or iterations of the group (--state opened|upcoming|current|closed|all, default opened); --project, --group',
    options: { project: { type: 'string' }, group: { type: 'string' }, state: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const mode = sprintMode();
      const scope = scopeOf(v);
      const limit = Number(v.limit || 100);
      const g = gl();
      if (mode === 'iterations') {
        const group = await iterationGroup(g, v, scope.project);
        const rows = await g.paged(`/groups/${pp(group)}/iterations?state=${encodeURIComponent(v.state || 'opened')}`, limit);
        if (v.json) return printJson(rows);
        for (const it of rows) console.log(`  ${iterationText(it)}`);
        console.log(`${rows.length} iteration(s) of group ${group}`);
        return 0;
      }
      const state = v.state || 'active';
      if (!['active', 'closed', 'all'].includes(state)) throw new UsageError(`--state is active, closed or all for milestones, not '${state}'`);
      const q = state === 'all' ? '' : `?state=${state}`;
      const group = v.group || envValue('GITLAB_GROUP');
      if (!scope.project && !group) throw new UsageError('--project or --group is required (or GITLAB_PROJECT / GITLAB_GROUP in oikos.yaml settings)');
      const rows = [];
      if (scope.project) rows.push(...(await g.paged(`/projects/${pp(scope.project)}/milestones${q}`, limit)).map((m) => ({ ...m, owner: scope.project })));
      if (group) rows.push(...(await g.paged(`/groups/${pp(group)}/milestones${q}`, limit)).map((m) => ({ ...m, owner: `group ${group}` })));
      if (v.json) return printJson(rows);
      for (const m of rows) console.log(`  ${milestoneText(m)}  (${m.owner})`);
      console.log(`${rows.length} milestone(s); the id is what sprint --id and move-to-sprint --sprint take`);
    },
  },

  sprint: {
    help: 'one sprint (milestone or iteration by GITLAB_SPRINTS): dates, issues grouped by status label, load per assignee (--id, --project / --group, --limit)',
    options: { id: { type: 'string' }, project: { type: 'string' }, group: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'id');
      const mode = sprintMode();
      const scope = scopeOf(v);
      const limit = Number(v.limit || 500);
      const g = gl();
      let header;
      let path;
      let sprint;
      if (mode === 'iterations') {
        const group = await iterationGroup(g, v, scope.project);
        sprint = await findIteration(g, group, v.id);
        header = `${iterationText(sprint)} (group ${group})`;
        path = `/groups/${pp(group)}/issues?iteration_id=${encodeURIComponent(v.id)}&state=all`;
      } else {
        if (!scope.project && !scope.group) throw new UsageError('--project or --group is required (or GITLAB_PROJECT / GITLAB_GROUP in oikos.yaml settings)');
        const found = scope.project ? await projectMilestone(g, scope.project, v.id) : await groupMilestone(g, scope.group, v.id);
        sprint = found.milestone;
        header = `${milestoneText(sprint)} (${found.owner})`;
        path = found.issuesPath;
      }
      const { rows, truncated } = await pagedCut(g, path, limit);
      if (v.json) return printJson({ sprint, issues: rows });
      printSprint(header, sprint.description, rows, truncated);
    },
  },

  attachment: {
    help: 'download a file linked in the description or the comments (--task, --id from the Attachments list of info, --dir default .); best effort',
    options: { task: { type: 'string' }, id: { type: 'string' }, dir: { type: 'string' } },
    async run(v) {
      required(v, 'task', 'id');
      const g = gl();
      const { ref, issue, notes } = await readIssue(g, v);
      const uploads = uploadsIn(issue.description, ...notes.filter((n) => !n.system).map((n) => n.body));
      const pick = uploads[Number(v.id) - 1];
      if (!pick) throw new UsageError(`${refText(ref)} has no attachment ${v.id}. Ids: ${uploads.map((_, i) => i + 1).join(', ') || 'none'}`);
      const web = `${g.base}/${ref.project}/uploads/${pick.secret}/${pick.file}`;
      let data;
      try {
        ({ data } = await g.api(`/projects/${pp(ref.project)}/uploads/${pick.secret}/${pick.file}`, { as: 'buffer' }));
      } catch (e) {
        if (!(e instanceof UsageError || e instanceof HttpError)) throw e;
        throw new UsageError(`could not download ${pick.name} through the API (${e.message.split('\n')[0].slice(0, 120)}) — `
          + `the uploads endpoint is unverified and may need a higher role; open it in the browser: ${web}`);
      }
      const dir = v.dir || '.';
      mkdirSync(dir, { recursive: true });
      const path = join(dir, basename(pick.name));
      writeFileSync(path, data);
      console.log(`Saved ${pick.name} (${data.length} bytes) → ${path}`);
    },
  },

  attach: {
    help: 'not offered: uploading a file to an issue (planned with F2)',
    options: { task: { type: 'string' }, file: { type: 'string' } },
    async run(v) {
      let where = siteUrl();
      try { if (v.task) where = issueUrl(siteUrl(), parseTask(v.task, { project: envValue('GITLAB_PROJECT'), base: envValue('GITLAB_URL') })); } catch { /* the site will do */ }
      throw new UsageError(`attach is not offered by this connector (an upload needs multipart requests, planned with F2) — attach the file in GitLab: ${where}`);
    },
  },
};

function listName(l) {
  if (l.label) return `label ${l.label.name}`;
  if (l.assignee) return `assignee @${l.assignee.username}`;
  if (l.milestone) return `milestone %${l.milestone.title}`;
  if (l.iteration) return `iteration ${iterationTitle(l.iteration)}`;
  return l.list_type || 'list';
}

function groupBy(rows, keyOf) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/** A sprint report as jira's: header, issues by status, closed/total per assignee. */
function printSprint(header, description, issues, truncated) {
  const policy = statusPolicy();
  console.log(header);
  if (description) console.log(`Description: ${description.trim().split('\n')[0].slice(0, 300)}`);
  for (const [status, list] of groupBy(issues, (i) => statusOf(i, policy))) {
    console.log(`\n## ${status} (${list.length})`);
    for (const i of list) console.log(`  ${issueLine(i, policy)}`);
  }
  const load = new Map();
  for (const i of issues) {
    const names = (i.assignees || []).length ? i.assignees.map((a) => `@${a.username}`) : ['unassigned'];
    for (const who of names) {
      const row = load.get(who) || { total: 0, done: 0 };
      row.total += 1;
      if (i.state === 'closed') row.done += 1;
      load.set(who, row);
    }
  }
  console.log('\n## Load');
  for (const [who, r] of [...load].sort((a, b) => b[1].total - a[1].total)) console.log(`  ${who.padEnd(28)} ${r.done}/${r.total} closed`);
  const done = issues.filter((i) => i.state === 'closed').length;
  console.log(`\n${issues.length} issue(s), ${done} closed${truncated ? ' … more (raise --limit)' : ''}`);
}

// == writes: create, edit, comment, transition, move-to-sprint, link ==
// Every one prints what it would do under --dry-run and needs the credentials even then — the
// preview reads the issues, labels and sprints it would touch — except `comment`, whose preview
// reads nothing. A dry run makes no request but GET.

/** The client, or null for an explicit dry run that can preview without the site (`comment`). */
function clientOrOffline(offline) {
  try {
    return gl();
  } catch (e) {
    if (offline && e instanceof UsageError) return null;
    throw e;
  }
}

/** The fields of create/edit from the common options: { body, shown } for the request and the dry run. */
async function issueFields(g, v) {
  const body = {};
  const shown = [];
  const description = readDescription(v);
  englishOnly(v, v.summary, description);
  if (v.summary) { body.title = v.summary; shown.push(`title: ${JSON.stringify(v.summary)}`); }
  if (v.labels !== undefined) { body.labels = splitList(v.labels).join(','); shown.push(`labels (set): ${body.labels || '(none)'}`); }
  if (v.assignee === 'none') { body.assignee_ids = [0]; shown.push('assignees: (none)'); }
  else if (v.assignee) { body.assignee_ids = [await userId(g, v.assignee)]; shown.push(`assignee: @${await username(g, v.assignee)}`); }
  if (v.due) { body.due_date = v.due === 'none' ? null : v.due; shown.push(`due: ${v.due}`); }
  if (description !== undefined) { body.description = description; shown.push(`description:\n${'-'.repeat(40)}\n${description}\n${'-'.repeat(40)}`); }
  return { body, shown, notify: notifyLine(v.summary, description) };
}

const WRITE_TEXT = {
  summary: { type: 'string' }, description: { type: 'string' }, file: { type: 'string' },
  labels: { type: 'string' }, assignee: { type: 'string' }, due: { type: 'string' },
  'create-labels': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' },
};

Object.assign(commands, {
  create: {
    help: 'create an issue (--project, default GITLAB_PROJECT; --summary, --description|--file, --labels, --assignee me|<username>, --due YYYY-MM-DD, --type issue|task|incident, --sprint MILESTONE_ID, --create-labels, --dry-run)',
    options: { project: { type: 'string' }, type: { type: 'string' }, sprint: { type: 'string' }, ...WRITE_TEXT },
    run: guarded(async (v) => {
      required(v, 'summary');
      const project = v.project || envValue('GITLAB_PROJECT');
      if (!project) throw new UsageError('--project is required (or GITLAB_PROJECT in oikos.yaml settings)');
      const g = gl();
      const { body, shown, notify } = await issueFields(g, v);
      if (v.type) { body.issue_type = v.type; shown.push(`type: ${v.type}`); }
      const created = await guardLabels(g, project, splitList(v.labels), v, new Map());
      let target = null;
      if (v.sprint) {
        if (sprintMode() === 'iterations') throw new UsageError('create sets no iteration: create the issue, then move-to-sprint --sprint <iteration id>');
        target = (await projectMilestone(g, project, v.sprint)).milestone;
        if (target.state === 'closed') throw new UsageError(`milestone ${target.title} is closed; issues are not put into it`);
        body.milestone_id = target.id;
      }
      if (v['dry-run']) {
        dryHeader();
        console.log(`Project: ${project}\nWould create an issue:`);
        for (const line of shown) console.log(`  ${line}`);
        if (target) console.log(`  into ${milestoneText(target)}`);
        if (created.length) console.log(`  will create label(s): ${created.join(', ')}`);
        if (notify) console.log(notify);
        dryFooter();
        return 0;
      }
      const issue = await g.post(`/projects/${pp(project)}/issues`, body);
      if (v.json) return printJson(issue);
      console.log(`Created ${refText(refOf(issue))}${target ? ` in milestone ${target.title}` : ''}: ${issue.web_url}`);
    }),
  },

  edit: {
    help: 'edit one issue or many (--task A,B | --query "GitLab list parameters" --max N, default 50; --summary, --description|--file, --labels (set), --add-labels, --remove-labels, --assignee me|<username>|none, --due; --create-labels, --dry-run); never closes or reopens',
    options: {
      task: { type: 'string' }, query: { type: 'string' }, project: { type: 'string' }, group: { type: 'string' }, max: { type: 'string' },
      'add-labels': { type: 'string' }, 'remove-labels': { type: 'string' }, state: { type: 'string' }, ...WRITE_TEXT,
    },
    run: guarded(async (v) => {
      if (v.state !== undefined) {
        const urls = v.task ? taskRefs(v.task, envValue('GITLAB_URL')).map((r) => issueUrl(siteUrl(), r)).join(' ') : siteUrl();
        throw new Refusal(`an agent never closes or reopens an issue — a person does it: ${urls}`);
      }
      const g = gl();
      const { body, shown, notify } = await issueFields(g, v);
      const add = splitList(v['add-labels']);
      const remove = splitList(v['remove-labels']);
      if (add.length) body.add_labels = add.join(',');
      if (remove.length) body.remove_labels = remove.join(',');
      if (!Object.keys(body).length) throw new UsageError('nothing to change: pass at least one field option');
      const issues = await selectIssues(g, v);
      const cache = new Map();
      const created = new Set();
      for (const project of new Set(issues.map((i) => refOf(i).project))) {
        for (const l of await guardLabels(g, project, [...splitList(v.labels), ...add], v, cache)) created.add(l);
      }
      if (v['dry-run']) {
        const policy = statusPolicy();
        dryHeader();
        console.log(`Project(s): ${[...new Set(issues.map((i) => refOf(i).project))].join(', ')}`);
        console.log(`Would edit ${issues.length} issue(s):`);
        for (const i of issues) console.log(`  ${issueLine(i, policy)}`);
        console.log('Changes:');
        for (const line of shown) console.log(`  ${line}`);
        if (add.length || remove.length) console.log(`  labels: ${[...add.map((l) => `+${l}`), ...remove.map((l) => `-${l}`)].join(' ')} (one PUT per issue)`);
        if (created.size) console.log(`  will create label(s): ${[...created].join(', ')}`);
        if (notify) console.log(notify);
        dryFooter();
        return 0;
      }
      let failed = 0;
      for (const i of issues) {
        const ref = refOf(i);
        try {
          await g.put(issueApi(ref), body);
          console.log(`edited ${refText(ref)}`);
        } catch (e) {
          if (!(e instanceof UsageError || e instanceof HttpError)) throw e;
          failed += 1;
          console.error(`${refText(ref)}: ${e.message}`);
        }
      }
      console.log(`${issues.length - failed}/${issues.length} edited`);
      return failed ? 2 : 0;
    }),
  },

  comment: {
    help: 'post a markdown comment (--task, --text or --file; --dry-run, which previews even without credentials)',
    options: { task: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' } },
    run: guarded(async (v) => {
      required(v, 'task');
      const text = readText(v);
      if (!text) throw new UsageError('--text or --file is required');
      const dry = Boolean(v['dry-run']);
      const g = clientOrOffline(dry);
      const ref = parseTask(v.task, { project: envValue('GITLAB_PROJECT'), base: g?.base || envValue('GITLAB_URL') });
      const foreign = nonLatinLetters(text);
      if (foreign && !dry && !v['allow-non-english']) {
        throw new UsageError(`refusing to post: GitLab comments are English, found non-Latin letters: ${foreign}. Translate, or pass --allow-non-english.`);
      }
      const notify = notifyLine(text);
      if (dry) {
        const issue = g ? await fetchIssue(g, ref) : null;
        if (foreign) console.log(`WARNING: non-Latin letters (${foreign}) — GitLab comments are English.`);
        dryHeader();
        console.log(`Project: ${ref.project}\nTask:    ${refText(ref)}${issue ? ` [${statusOf(issue, statusPolicy())}] ${issue.title}` : ''}`);
        console.log(`Target:  ${issue?.web_url || issueUrl(g?.base || siteUrl(), ref)}\nComment that WOULD be posted:`);
        console.log(`${'-'.repeat(40)}\n${text}\n${'-'.repeat(40)}`);
        if (notify) console.log(notify);
        dryFooter();
        if (!g) console.log(`\n(no GitLab credentials — the write itself needs them)\n${credentialsHelp(['GITLAB_URL', 'GITLAB_TOKEN'], { extra: writeHelp(siteUrl()) })}`);
        return 0;
      }
      const note = await g.post(`${issueApi(ref)}/notes`, { body: text });
      if (v.json) return printJson(note);
      console.log(`Posted comment to ${refText(ref)}: ${issueUrl(g.base, ref)}#note_${note.id}`);
    }),
  },

  transition: {
    help: 'move a task among the status labels open to an agent only (GITLAB_AGENT_STATUSES; --task, --to, --dry-run): one PUT with add_labels and remove_labels; never closes or reopens',
    options: { task: { type: 'string' }, to: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    run: guarded(async (v) => {
      required(v, 'task', 'to');
      const policy = statusPolicy();
      const ref = parseTask(v.task, { project: envValue('GITLAB_PROJECT'), base: envValue('GITLAB_URL') });
      const url = issueUrl(siteUrl(), ref);
      if (/^(close|closed|reopen|reopened)$/i.test(v.to.trim())) throw new Refusal(`an agent never closes or reopens an issue — a person does it: ${url}`);
      if (!policy.agent.length) {
        throw new Refusal('GITLAB_AGENT_STATUSES is not set — gitlab-issues has no default status labels. '
          + `Set the labels an agent may move a task among in oikos.yaml settings, or move ${refText(ref)} yourself: ${url}`);
      }
      const refuse = (why) => new Refusal(`${why} — an agent moves a task only among ${policy.agent.join(', ')}; move ${refText(ref)} to '${v.to}' yourself: ${url}`);
      if (!inList(policy.agent, v.to)) throw refuse(`'${v.to}' is not in GITLAB_AGENT_STATUSES`);
      const g = gl();
      const issue = await fetchIssue(g, ref);
      if (issue.state === 'closed') throw new Refusal(`${refText(ref)} is closed; reopening is a person's: ${issue.web_url || url}`);
      const labels = labelNames(issue);
      const review = labels.filter((l) => inList(policy.review, l));
      if (review.length) throw refuse(`${refText(ref)} is in ${review.join(', ')}: from review on only a person moves it`);
      const target = (await projectLabels(g, ref.project, new Map())).find((l) => same(l, v.to));
      if (!target) throw new UsageError(`${ref.project} has no label '${v.to}' — a status label must exist before a task is moved to it (a person creates it)`);
      const current = labels.filter((l) => inList(policy.agent, l));
      const from = current.join(', ') || '(no status label)';
      const remove = current.filter((l) => !same(l, target));
      if (current.some((l) => same(l, target)) && !remove.length) {
        console.log(`${refText(ref)} is already ${target}: nothing to change`);
        return 0;
      }
      const body = { add_labels: target, ...(remove.length ? { remove_labels: remove.join(',') } : {}) };
      if (v['dry-run']) {
        dryHeader();
        console.log(`Project: ${ref.project}\nTask:    ${refText(ref)} ${issue.title}`);
        console.log(`Would move: ${from} → ${target}   (source: labels, GITLAB_AGENT_STATUSES)`);
        console.log(`  labels: +${target}${remove.map((l) => ` -${l}`).join('')} (one PUT, atomic)`);
        dryFooter();
        return 0;
      }
      await g.put(issueApi(ref), body);
      console.log(`${refText(ref)}: ${from} → ${target}`);
    }),
  },

  'move-to-sprint': {
    help: 'put issues into a sprint, or take them out (--sprint ID | --backlog; --task A,B | --query "GitLab list parameters" --max N; --dry-run): a milestone, or an iteration by GITLAB_SPRINTS',
    options: {
      sprint: { type: 'string' }, backlog: { type: 'boolean' }, task: { type: 'string' }, query: { type: 'string' },
      project: { type: 'string' }, group: { type: 'string' }, max: { type: 'string' }, 'dry-run': { type: 'boolean' },
    },
    run: guarded(async (v) => {
      if (!v.sprint === !v.backlog) throw new UsageError('either --sprint ID or --backlog is required');
      const mode = sprintMode();
      const g = gl();
      const issues = await selectIssues(g, v);
      const projects = [...new Set(issues.map((i) => refOf(i).project))];
      let target = mode === 'iterations' ? 'no iteration' : 'no milestone';
      let body;
      if (mode === 'iterations') {
        body = { iteration_id: null };
        if (v.sprint) {
          const it = await findIteration(g, await iterationGroup(g, v, projects[0]), v.sprint);
          if (iterationState(it) === 'closed') throw new UsageError(`iteration ${iterationTitle(it)} is closed; issues are not put into it`);
          target = iterationText(it);
          body = { iteration_id: it.id };
        }
      } else {
        body = { milestone_id: 0 };
        if (v.sprint) {
          // A project milestone is open to that project's issues only: resolve it for each project.
          let m;
          for (const project of projects) m = (await projectMilestone(g, project, v.sprint)).milestone;
          if (m.state === 'closed') throw new UsageError(`milestone ${m.title} is closed; issues are not put into it`);
          target = milestoneText(m);
          body = { milestone_id: m.id };
        }
      }
      const current = (i) => {
        const s = mode === 'iterations' ? i.iteration : i.milestone;
        return s ? `${mode === 'iterations' ? 'iteration' : 'milestone'} ${s.id} "${mode === 'iterations' ? iterationTitle(s) : s.title}"` : '(none)';
      };
      if (v['dry-run']) {
        const policy = statusPolicy();
        dryHeader();
        console.log(`Project(s): ${projects.join(', ')}\nTarget: ${target}\nWould move ${issues.length} issue(s):`);
        for (const i of issues) console.log(`  ${issueLine(i, policy)}   ${current(i)} → ${v.backlog ? '(none)' : `${mode === 'iterations' ? 'iteration' : 'milestone'} ${body[mode === 'iterations' ? 'iteration_id' : 'milestone_id']}`}`);
        if (mode === 'iterations') console.log(`NOTE: ${ITERATION_TV}.`);
        dryFooter();
        return 0;
      }
      let failed = 0;
      for (const i of issues) {
        const ref = refOf(i);
        try {
          await g.put(issueApi(ref), body);
          console.log(`moved ${refText(ref)}`);
        } catch (e) {
          if (!(e instanceof UsageError || e instanceof HttpError)) throw e;
          failed += 1;
          console.error(`${refText(ref)}: ${e.message}`);
        }
      }
      console.log(`${issues.length - failed}/${issues.length} moved to ${target}${mode === 'iterations' ? ` (${ITERATION_TV})` : ''}`);
      return failed ? 2 : 0;
    }),
  },

  link: {
    help: 'link two issues: --from A --type blocks --to B means "A blocks B" (relates_to | blocks | is_blocked_by; --dry-run); --types lists them',
    options: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' }, types: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    run: guarded(async (v) => {
      if (v.types) {
        console.log('relates_to      A relates to B\nblocks          A blocks B\nis_blocked_by   A is blocked by B\n'
          + '(blocks and is_blocked_by depend on the GitLab tier — unverified until checked live)');
        return 0;
      }
      required(v, 'from', 'to', 'type');
      const type = v.type.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/^relates$/, 'relates_to');
      if (!LINK_TYPES.includes(type)) throw new UsageError(`--type is one of ${LINK_TYPES.join(', ')}, not '${v.type}'`);
      const g = gl();
      const [from] = taskRefs(v.from, g.base);
      const [to] = taskRefs(v.to, g.base);
      const source = await fetchIssue(g, from);
      const target = await fetchIssue(g, to);
      const arrow = `${refText(from)} —${type}→ ${refText(to)}`;
      if (v['dry-run']) {
        dryHeader();
        console.log(`Project: ${from.project}${to.project !== from.project ? ` → ${to.project}` : ''}`);
        console.log(`Would link: ${arrow}\n  ${refText(from)} ${source.title}\n  ${refText(to)} ${target.title}`);
        if (BLOCKING.has(type)) console.log('NOTE: blocking links depend on the GitLab tier (unverified until checked live); GitLab answers 403 or 400 where they are not offered.');
        dryFooter();
        return 0;
      }
      try {
        await g.post(`${issueApi(from)}/links`, { target_project_id: target.project_id, target_issue_iid: target.iid, link_type: type });
      } catch (e) {
        if (!(e instanceof HttpError) || ![400, 403, 409, 422].includes(e.status)) throw e;
        const tier = BLOCKING.has(type) && [400, 403].includes(e.status) ? ' — this GitLab tier may not offer blocking links; link as relates_to, or a person links them' : '';
        console.error(`gitlab-issues: GitLab refused the link ${arrow} (HTTP ${e.status}: ${String(e.body).slice(0, 200)})${tier}`);
        return 2;
      }
      console.log(`Linked ${arrow}`);
    }),
  },
});

/** An operation this connector does not offer: one line, and where a person does it. */
function notOffered(what, route) {
  return {
    help: `not offered: ${what}`,
    // The tracker options of the reference connector, so a call ends at this message, not at a parse error.
    options: { task: { type: 'string' }, key: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, tag: { type: 'string' }, owner: { type: 'string' }, search: { type: 'string' }, state: { type: 'string' } },
    async run() {
      throw new UsageError(`${what} is not offered by the gitlab-issues connector (GitLab epics and OKRs are out of F7) — ${route()}`);
    },
  };
}

const epicsRoute = () => {
  const group = envValue('GITLAB_GROUP');
  return `open them in GitLab: ${siteUrl()}${group ? `/groups/${group}/-/epics` : ''}`;
};

Object.assign(commands, {
  goals: notOffered('goals', epicsRoute),
  goal: notOffered('goal', epicsRoute),
  'goal-comment': notOffered('goal-comment', epicsRoute),
});

export { commands };

if (isMain(import.meta.url)) runCli('gitlab-issues', commands, { connector: 'gitlab-issues' });
