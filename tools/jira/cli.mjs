#!/usr/bin/env node
// Jira: read tasks, search, sprints and boards; comment and transition under guards.
// Also board and sprint reads, goals, and issue create/edit/link/move under the same guards.
// Read-only by default; `comment` and `transition` write, and both have --dry-run.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, required, printJson, nonLatinLetters, UsageError } from '../common/cli.mjs';
import { atlassianCreds, credsComplete, atlassianHelp, atlassianClient, missingCreds } from '../common/atlassian.mjs';
import { adfToText, markdownToAdf, plainAdf } from '../common/adf.mjs';
import { HttpError } from '../common/http.mjs';
import { envValue } from '../common/env.mjs';

const TOOL = 'node oikos/tools/jira/cli.mjs';

// Statuses an agent may move a task among; from review on only a person moves a task, in either
// direction. Both are the organization's workflow: JIRA_AGENT_STATUSES and JIRA_REVIEW_STATUSES
// (comma lists in oikos.yaml settings), compared case-insensitively.
const statusList = (key, fallback) => (envValue(key) || fallback).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const AGENT_STATUSES = statusList('JIRA_AGENT_STATUSES', 'to do, in progress, blocked');
const REVIEW_ON = new Set(statusList('JIRA_REVIEW_STATUSES', 'review, in review'));
const isAgentStatus = (name) => AGENT_STATUSES.includes(String(name).trim().toLowerCase());

const INFO_FIELDS = 'summary,description,status,assignee,reporter,issuetype,priority,parent,labels,components,issuelinks,attachment,comment,subtasks,duedate';
const LIST_FIELDS = 'summary,status,issuetype,assignee,priority';

/**
 * The credentials and the client for a command that would `what`. Missing credentials are a usage
 * error naming each missing key, raised before any request; only an explicit --dry-run whose
 * preview reads nothing from Jira (`offline`) goes on, with a null client.
 */
function client(what, { offline = false } = {}) {
  const c = atlassianCreds();
  if (credsComplete(c)) return { c, jira: atlassianClient(c, 'jira') };
  if (offline) return { c, jira: null };
  throw missingCreds(c, 'Jira', what);
}

/** The closing note of a dry run made without credentials: the write itself will need them. */
function offlineNote(c) {
  console.log(`\n(no Jira credentials — the write itself needs them)\n${atlassianHelp(c)}`);
}

const name = (o, fallback = '') => (o && (o.displayName || o.name)) || fallback;

function issueLine(issue) {
  const f = issue.fields || {};
  const who = f.assignee ? ` @${name(f.assignee)}` : '';
  return `${issue.key} [${name(f.status)}] ${name(f.issuetype)} · ${f.summary || ''}${who}`;
}

function linksLines(f) {
  return (f.issuelinks || []).map((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    const verb = l.outwardIssue ? l.type?.outward : l.type?.inward;
    return other ? `${verb} ${issueLine(other)}` : '';
  }).filter(Boolean);
}

function infoLines(d) {
  const f = d.fields || {};
  const out = [`Task: ${d.key}`, `Summary: ${f.summary || ''}`];
  out.push(`Type: ${name(f.issuetype)}   Status: ${name(f.status)}   Priority: ${name(f.priority, '-')}   ` +
    `Assignee: ${name(f.assignee, 'unassigned')}   Reporter: ${name(f.reporter, '-')}`);
  if (f.duedate) out.push(`Due: ${f.duedate}`);
  if (f.parent) out.push(`Parent: ${f.parent.key} — ${f.parent.fields?.summary || ''}`);
  if (f.labels?.length) out.push(`Labels: ${f.labels.join(', ')}`);
  if (f.components?.length) out.push(`Components: ${f.components.map((x) => x.name).join(', ')}`);
  const links = linksLines(f);
  if (links.length) out.push('Links:', ...links.map((l) => `  ${l}`));
  if (f.subtasks?.length) out.push('Sub-tasks:', ...f.subtasks.map((s) => `  ${issueLine(s)}`));
  const body = f.description ? adfToText(f.description).trim() : '';
  out.push('', 'Description:', body || '(empty — the summary above is the whole specification)');
  const atts = f.attachment || [];
  if (atts.length) {
    out.push('', 'Attachments:');
    for (const a of atts) out.push(`  [${a.id}] ${a.filename} (${a.mimeType}, ${a.size} bytes) — NOT READ`);
    out.push(`  Fetch: ${TOOL} attachment --task ${d.key} --id <id> [--dir DIR]`);
  }
  const comments = f.comment?.comments || [];
  if (comments.length) {
    out.push('', `Comments (${comments.length}):`);
    for (const cm of comments) {
      out.push(`  --- ${name(cm.author, '?')}, ${(cm.created || '').slice(0, 10)}`);
      const text = cm.body ? adfToText(cm.body).trim() : '';
      for (const line of (text || '(empty)').split('\n')) if (line.trim()) out.push(`      ${line.trim()}`);
    }
  }
  if (atts.length || /see Attachments|embedded card/.test(body)) {
    out.push('', 'NOTE — part of this task is not text (images, files, cards). Fetch the attachment ' +
      'and read it; if it stays unclear, ask the user. Do not rebuild it from the surrounding text.');
  }
  return out;
}

async function fetchIssue(jira, key, fields) {
  try {
    return await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new UsageError(`${key}: not found, or this account cannot see it (Jira answers 404 for both).`);
    }
    throw e;
  }
}

/** GET /search/jql following nextPageToken until `limit` issues are in hand. */
async function jqlSearch(jira, jql, limit, fields = LIST_FIELDS) {
  const issues = [];
  let token;
  let more = false;
  for (;;) {
    let url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${Math.min(limit, 100)}`;
    if (token) url += `&nextPageToken=${encodeURIComponent(token)}`;
    const d = await jira.get(url);
    issues.push(...(d.issues || []));
    token = d.nextPageToken;
    if (issues.length >= limit) { more = Boolean(token) || issues.length > limit; break; }
    if (!token || !(d.issues || []).length) break;
  }
  return { issues: issues.slice(0, limit), truncated: more };
}

/** Agile endpoints page with startAt/isLast (boards, sprints) or startAt/total (issues). */
async function agilePaged(jira, path, key, limit) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const d = await jira.get(`${path}${sep}startAt=${startAt}&maxResults=50`);
    const batch = d[key] || [];
    out.push(...batch);
    startAt += batch.length;
    const last = d.isLast ?? (d.total !== undefined ? startAt >= d.total : true);
    if (last || !batch.length || out.length >= limit) break;
  }
  return out.slice(0, limit);
}

async function fieldIdsByName(jira, names) {
  const fields = await jira.get('/rest/api/3/field');
  const out = {};
  for (const f of fields) if (names.includes(f.name) && !out[f.name]) out[f.name] = f.id;
  return out;
}

function readText(values) {
  if (values.file) return readFileSync(values.file, 'utf8');
  return values.text;
}

const commands = {
  whoami: {
    help: 'check the credentials: which Atlassian account the tool acts as',
    options: {},
    async run(v) {
      const { c, jira } = client('check the account');
      const me = await jira.get('/rest/api/3/myself');
      if (v.json) return printJson(me);
      console.log(`${me.displayName} <${me.emailAddress || c.email}> on ${c.baseUrl}`);
      console.log(atlassianHelp(c));
    },
  },

  info: {
    help: 'a task: summary, status, description, links, attachments, comments',
    options: { task: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      const { c, jira } = client(`read ${v.task}`);
      const d = await fetchIssue(jira, v.task, INFO_FIELDS);
      if (v.json) return printJson(d);
      console.log(infoLines(d).join('\n'));
      console.log(`\n${c.baseUrl}/browse/${d.key}`);
    },
  },

  context: {
    help: 'info plus sprint, epic and its other children, and warnings — read before working on a task',
    options: { task: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      const limit = Number(v.limit || 20);
      const { c, jira } = client(`read ${v.task}`);
      const ids = await fieldIdsByName(jira, ['Sprint']);
      const fields = INFO_FIELDS + (ids.Sprint ? `,${ids.Sprint}` : '');
      const d = await fetchIssue(jira, v.task, fields);
      const f = d.fields || {};
      const out = ['## Task', ...infoLines(d)];
      const warnings = [];

      const sprints = (ids.Sprint && f[ids.Sprint]) || [];
      out.push('', '## Sprint');
      if (sprints.length) for (const s of sprints) out.push(`  ${s.name} [${s.state}] (id ${s.id}${s.endDate ? `, ends ${s.endDate.slice(0, 10)}` : ''})`);
      else out.push('  (none)');
      const inActive = sprints.some((s) => s.state === 'active');

      const isEpic = name(f.issuetype).toLowerCase() === 'epic';
      const epicKey = isEpic ? d.key : (f.parent && name(f.parent.fields?.issuetype).toLowerCase() === 'epic' ? f.parent.key : null);
      if (epicKey) {
        const { issues, truncated } = await jqlSearch(jira, `parent = ${epicKey} ORDER BY status, key`, limit);
        out.push('', `## Epic ${epicKey} — children${truncated ? ` (first ${limit})` : ''}`);
        for (const i of issues) if (i.key !== d.key) out.push(`  ${issueLine(i)}`);
      }

      const status = name(f.status).toLowerCase();
      const category = f.status?.statusCategory?.key;
      if (isEpic) warnings.push('this is an epic — work goes into a task created under it.');
      if (!inActive && category !== 'done') warnings.push('the task is not in an active sprint.');
      if (REVIEW_ON.has(status)) warnings.push(`status is ${name(f.status)} — from review on only a person moves the task.`);
      if (category === 'done') warnings.push('the task is closed — closed tasks are not worked on.');
      out.push('', '## Warnings', ...(warnings.length ? warnings.map((w) => `  - ${w}`) : ['  (none)']));
      if (v.json) return printJson(d);
      console.log(out.join('\n'));
      console.log(`\n${c.baseUrl}/browse/${d.key}`);
    },
  },

  search: {
    help: 'read-only JQL search (--jql, --limit default 50)',
    options: { jql: { type: 'string' }, limit: { type: 'string' }, fields: { type: 'string' } },
    async run(v) {
      required(v, 'jql');
      const { jira } = client('search');
      const { issues, truncated } = await jqlSearch(jira, v.jql, Number(v.limit || 50), v.fields || LIST_FIELDS);
      if (v.json) return printJson(issues);
      for (const i of issues) console.log(issueLine(i));
      console.log(`${issues.length} issue(s)${truncated ? ' … more (raise --limit)' : ''}`);
    },
  },

  boards: {
    help: 'agile boards (--project KEY, --name substring)',
    options: { project: { type: 'string' }, name: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const { jira } = client('list boards');
      const q = new URLSearchParams();
      if (v.project) q.set('projectKeyOrId', v.project);
      if (v.name) q.set('name', v.name);
      const boards = await agilePaged(jira, `/rest/agile/1.0/board?${q}`, 'values', Number(v.limit || 100));
      if (v.json) return printJson(boards);
      for (const b of boards) console.log(`${String(b.id).padStart(5)}  ${b.type.padEnd(6)} ${b.name}${b.location?.projectKey ? `  (${b.location.projectKey})` : ''}`);
      console.log(`${boards.length} board(s)`);
    },
  },

  sprints: {
    help: 'sprints of a board (--board ID, --state active,future,closed; default active,future)',
    options: { board: { type: 'string' }, state: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'board');
      const { jira } = client('list sprints');
      const state = v.state || 'active,future';
      const sprints = await agilePaged(jira, `/rest/agile/1.0/board/${v.board}/sprint?state=${state}`, 'values', Number(v.limit || 50));
      if (v.json) return printJson(sprints);
      for (const s of sprints) {
        const dates = [s.startDate, s.endDate].map((x) => (x ? x.slice(0, 10) : '?')).join(' → ');
        console.log(`${String(s.id).padStart(6)}  [${s.state}] ${s.name}  ${dates}${s.goal ? `\n        goal: ${s.goal}` : ''}`);
      }
      console.log(`${sprints.length} sprint(s)`);
    },
  },

  sprint: {
    help: 'one sprint: goal, dates, issues grouped by status, load per assignee (--id, or --board for its active sprint)',
    options: { id: { type: 'string' }, board: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      if (!v.id && !v.board) throw new UsageError('--id or --board is required');
      const { jira } = client('read the sprint');
      let sprint;
      if (v.id) sprint = await jira.get(`/rest/agile/1.0/sprint/${v.id}`);
      else {
        const active = await agilePaged(jira, `/rest/agile/1.0/board/${v.board}/sprint?state=active`, 'values', 10);
        if (!active.length) throw new UsageError(`board ${v.board} has no active sprint`);
        if (active.length > 1) console.log(`# board ${v.board} has ${active.length} active sprints; showing the first. Use --id for another.`);
        sprint = active[0];
      }
      const issues = await agilePaged(jira, `/rest/agile/1.0/sprint/${sprint.id}/issue?fields=${LIST_FIELDS}`, 'issues', Number(v.limit || 500));
      if (v.json) return printJson({ sprint, issues });
      const dates = [sprint.startDate, sprint.endDate].map((x) => (x ? x.slice(0, 10) : '?')).join(' → ');
      console.log(`Sprint ${sprint.id}: ${sprint.name} [${sprint.state}] ${dates}`);
      if (sprint.goal) console.log(`Goal: ${sprint.goal}`);
      const byStatus = new Map();
      const byAssignee = new Map();
      for (const i of issues) {
        const st = name(i.fields.status);
        if (!byStatus.has(st)) byStatus.set(st, []);
        byStatus.get(st).push(i);
        const who = name(i.fields.assignee, 'unassigned');
        const row = byAssignee.get(who) || { total: 0, done: 0 };
        row.total += 1;
        if (i.fields.status?.statusCategory?.key === 'done') row.done += 1;
        byAssignee.set(who, row);
      }
      for (const [st, list] of byStatus) {
        console.log(`\n## ${st} (${list.length})`);
        for (const i of list) console.log(`  ${issueLine(i)}`);
      }
      console.log('\n## Load');
      for (const [who, r] of [...byAssignee].sort((a, b) => b[1].total - a[1].total)) console.log(`  ${who.padEnd(28)} ${r.done}/${r.total} done`);
      const done = issues.filter((i) => i.fields.status?.statusCategory?.key === 'done').length;
      console.log(`\n${issues.length} issue(s), ${done} done`);
    },
  },

  comment: {
    help: 'post a markdown comment (--task, --text or --file; --dry-run, --plain, --show-adf)',
    options: {
      task: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' },
      'dry-run': { type: 'boolean' }, plain: { type: 'boolean' }, 'show-adf': { type: 'boolean' },
      'allow-non-english': { type: 'boolean' },
    },
    async run(v) {
      required(v, 'task');
      const text = readText(v);
      if (!text) throw new UsageError('--text or --file is required');
      const dry = Boolean(v['dry-run']);
      // The preview of a comment reads nothing from Jira, so an explicit --dry-run works without credentials.
      const { c, jira } = client(`comment on ${v.task}`, { offline: dry });
      const foreign = nonLatinLetters(text);
      if (foreign && !dry && !v['allow-non-english']) {
        throw new UsageError(`refusing to post: Jira comments are English, found non-Latin letters: ${foreign}. Translate, or pass --allow-non-english.`);
      }
      const doc = v.plain ? plainAdf(text) : markdownToAdf(text);
      if (dry) {
        if (foreign) console.log(`WARNING: non-Latin letters (${foreign}) — Jira comments are English.`);
        console.log('--- DRY RUN (requested --dry-run) ---');
        console.log(`Task:   ${v.task}\nTarget: ${c.baseUrl || '<JIRA_BASE_URL>'}/browse/${v.task}\nComment that WOULD be posted:`);
        console.log(`${'-'.repeat(40)}\n${text}\n${'-'.repeat(40)}`);
        if (v['show-adf']) console.log(JSON.stringify(doc, null, 2));
        console.log('DRY RUN — nothing written to Jira.');
        if (!jira) offlineNote(c);
        return 0;
      }
      const r = await jira.post(`/rest/api/3/issue/${encodeURIComponent(v.task)}/comment`, { body: doc });
      console.log(`Posted comment to ${v.task} (HTTP ${r.status}): ${c.baseUrl}/browse/${v.task}`);
    },
  },

  transition: {
    help: 'move a task among the statuses open to an agent only (JIRA_AGENT_STATUSES; --task, --to, --dry-run)',
    options: { task: { type: 'string' }, to: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    async run(v) {
      required(v, 'task', 'to');
      const c = atlassianCreds();
      const refuse = () => {
        console.error(`refused: an agent moves a task only among ${AGENT_STATUSES.join(', ')} — move ${v.task} to '${v.to}' yourself: ${c.baseUrl || '<JIRA_BASE_URL>'}/browse/${v.task}`);
        return 3;
      };
      if (!isAgentStatus(v.to)) return refuse();
      // Even the dry run reads the current status and the transitions open from it.
      const { jira } = client(`move ${v.task}`);
      const d = await fetchIssue(jira, v.task, 'status');
      const current = name(d.fields.status);
      if (!isAgentStatus(current)) return refuse();
      const { transitions = [] } = await jira.get(`/rest/api/3/issue/${encodeURIComponent(v.task)}/transitions`);
      const match = transitions.find((t) => name(t.to).toLowerCase() === v.to.toLowerCase());
      if (!match) {
        const reachable = transitions.map((t) => name(t.to)).filter(isAgentStatus);
        throw new UsageError(`no transition to '${v.to}' from ${current}. Reachable: ${reachable.join(', ') || 'none'}`);
      }
      if (v['dry-run']) {
        console.log(`DRY RUN — would move ${v.task}: ${current} → ${name(match.to)} (transition ${match.id})`);
        return 0;
      }
      await jira.post(`/rest/api/3/issue/${encodeURIComponent(v.task)}/transitions`, { transition: { id: match.id } });
      console.log(`${v.task}: ${current} → ${name(match.to)}`);
    },
  },

  attachment: {
    help: 'download one attachment (--task, --id from the Attachments list, --dir default .)',
    options: { task: { type: 'string' }, id: { type: 'string' }, dir: { type: 'string' } },
    async run(v) {
      required(v, 'task', 'id');
      const { jira } = client('download');
      const d = await fetchIssue(jira, v.task, 'attachment');
      const att = (d.fields.attachment || []).find((a) => String(a.id) === String(v.id));
      if (!att) throw new UsageError(`${v.task} has no attachment ${v.id}. Ids: ${(d.fields.attachment || []).map((a) => a.id).join(', ') || 'none'}`);
      const r = await jira.raw('GET', att.content, undefined, { as: 'buffer' });
      const dir = v.dir || '.';
      mkdirSync(dir, { recursive: true });
      const path = join(dir, att.filename);
      writeFileSync(path, r.data);
      console.log(`Saved ${att.filename} (${att.mimeType}, ${r.data.length} bytes) → ${path}`);
    },
  },
};

// Goals (Atlassian Home / Townsquare) live behind the GraphQL gateway. `goals_search` ignores its
// search string in practice, so the list is paged in full and filtered here.
// Goals are planned per quarter; the quarter is a tag on the goal: `q3-26` = Q3 2026.
const GOAL_FIELDS = 'id key name url isArchived state{label value} owner{ accountId name } targetDate{ dateRange{ end } } parentGoal{ key name } tags{ edges{ node{ name } } }';
const goalTags = (g) => (g.tags?.edges || []).map((e) => e.node.name);

/** `current` / `next` / `previous` → the quarter tag (q3-26); anything else passes as is. */
function quarterTag(value, now = new Date()) {
  const shift = { current: 0, next: 1, previous: -1, prev: -1 }[value];
  if (shift === undefined) return value;
  const q = Math.floor(now.getMonth() / 3) + shift;
  const year = now.getFullYear() + Math.floor(q / 4);
  return `q${((q % 4) + 4) % 4 + 1}-${String(year).slice(-2)}`;
}
let cloudIdCache;

async function graphql(jira, query, variables) {
  const { data } = await jira.post('/gateway/api/graphql', { query, variables });
  if (!data?.data && data?.errors) throw new UsageError(`goals API: ${data.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  return data?.data;
}

async function goalsContainer(jira) {
  cloudIdCache ??= (await jira.get('/_edge/tenant_info')).cloudId;
  return `ari:cloud:townsquare::site/${cloudIdCache}`;
}

async function allGoals(jira) {
  const container = await goalsContainer(jira);
  const out = [];
  let after = null;
  for (let page = 0; page < 50; page++) {
    const d = await graphql(jira, `query OikosGoalList($c:ID!,$after:String){ goals_search(containerId:$c, searchString:"", first:100, after:$after){ pageInfo{ hasNextPage endCursor } edges{ node{ ${GOAL_FIELDS} } } } }`, { c: container, after });
    const conn = d.goals_search;
    out.push(...conn.edges.map((e) => e.node));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function goalByKey(jira, key, extra = '') {
  const d = await graphql(jira, `query OikosGoalByKey($c:ID!,$k:String!){ goals_byKey(containerId:$c, goalKey:$k){ ${GOAL_FIELDS} ${extra} } }`, { c: await goalsContainer(jira), k: key });
  if (!d?.goals_byKey) throw new UsageError(`goal ${key}: not found, or not visible to this account`);
  return d.goals_byKey;
}

function goalLine(g) {
  const due = g.targetDate?.dateRange?.end ? ` · due ${g.targetDate.dateRange.end.slice(0, 10)}` : '';
  const parent = g.parentGoal ? ` · under ${g.parentGoal.key}` : '';
  const tags = goalTags(g).length ? ` · #${goalTags(g).join(' #')}` : '';
  return `${g.key} ${g.name.trim()} — ${g.state?.label || '?'} · ${g.owner?.name || 'no owner'}${due}${parent}${tags}${g.isArchived ? ' [archived]' : ''}`;
}

// == writes beyond comment/transition: create, edit (one or bulk), sprint moves, links ==
// Every one prints what it would do under --dry-run, and needs credentials even then: the
// preview resolves users, goals, sprints and JQL on the site (only `link` previews offline).
// Bulk selection by JQL is capped (--max, default 50) so a wide query never edits more than
// the user saw.

const DEFAULT_MAX = 50;

async function accountId(jira, who) {
  if (!who || who === 'none') return null;
  if (who === 'me') return (await jira.get('/rest/api/3/myself')).accountId;
  if (/^[0-9a-f:-]{20,}$/i.test(who)) return who;
  const users = await jira.get(`/rest/api/3/user/search?query=${encodeURIComponent(who)}`);
  const active = users.filter((u) => u.active !== false && u.accountType === 'atlassian');
  if (active.length !== 1) {
    throw new UsageError(`'${who}' matches ${active.length} users${active.length ? `: ${active.map((u) => u.displayName).join(', ')}` : ''} — use the email`);
  }
  return active[0].accountId;
}

const splitList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

function englishOnly(v, ...texts) {
  const foreign = nonLatinLetters(texts.filter(Boolean).join(' '));
  if (foreign && !v['allow-non-english']) {
    throw new UsageError(`Jira content is English, found non-Latin letters: ${foreign}. Translate, or pass --allow-non-english.`);
  }
}

/** Keys from --task A,B or --jql (capped by --max). */
async function selectKeys(jira, v) {
  if (v.task) return splitList(v.task);
  if (!v.jql) throw new UsageError('--task KEY[,KEY…] or --jql is required');
  const max = Number(v.max || DEFAULT_MAX);
  const { issues, truncated } = await jqlSearch(jira, v.jql, max + 1);
  if (issues.length > max || truncated) throw new UsageError(`the JQL selects more than --max ${max} issues; narrow it or raise --max`);
  return issues.map((i) => i.key);
}

/** The `fields` object for create/edit from the common options. */
async function fieldsFrom(jira, v) {
  const f = {};
  const description = v.file ? readFileSync(v.file, 'utf8') : v.description;
  if (v.summary) f.summary = v.summary;
  if (description) f.description = markdownToAdf(description);
  if (v.priority) f.priority = { name: v.priority };
  if (v.parent) f.parent = { key: v.parent };
  if (v.due) f.duedate = v.due === 'none' ? null : v.due;
  if (v.labels !== undefined) f.labels = splitList(v.labels);
  if (v.assignee) f.assignee = { accountId: await accountId(jira, v.assignee) };
  if (v.assignee === 'none') f.assignee = null;
  if (v.goals !== undefined) {
    const ids = await fieldIdsByName(jira, ['Goals']);
    if (!ids.Goals) throw new UsageError('this Jira site has no Goals field');
    f[ids.Goals] = [];
    for (const k of splitList(v.goals)) f[ids.Goals].push({ id: (await goalByKey(jira, k)).id });
  }
  englishOnly(v, v.summary, description);
  return f;
}

const COMMON_FIELDS = {
  summary: { type: 'string' }, description: { type: 'string' }, file: { type: 'string' },
  priority: { type: 'string' }, parent: { type: 'string' }, due: { type: 'string' },
  labels: { type: 'string' }, assignee: { type: 'string' }, goals: { type: 'string' },
  'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' },
};

function dryHeader() {
  console.log('--- DRY RUN (requested --dry-run) ---');
}

function showFields(fields) {
  for (const [k, val] of Object.entries(fields)) {
    const shown = k === 'description' ? `\n${adfToText(val).trim()}` : JSON.stringify(val);
    console.log(`  ${k}: ${shown}`);
  }
}

Object.assign(commands, {
  create: {
    help: 'create an issue (--project, --type, --summary, --description|--file, --parent, --assignee me|email, --labels, --priority, --due, --goals GOAL-1,…, --sprint ID, --dry-run)',
    options: { project: { type: 'string' }, type: { type: 'string' }, sprint: { type: 'string' }, ...COMMON_FIELDS },
    async run(v) {
      required(v, 'project', 'summary');
      const { c, jira } = client(`create an issue in ${v.project}`);
      const fields = { project: { key: v.project }, issuetype: { name: v.type || 'Task' }, ...(await fieldsFrom(jira, v)) };
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would create in ${v.project}:`);
        showFields(fields);
        if (v.sprint) console.log(`  then add to sprint ${v.sprint}`);
        console.log('DRY RUN — nothing written to Jira.');
        return 0;
      }
      const { data } = await jira.post('/rest/api/3/issue', { fields });
      if (v.sprint) await jira.post(`/rest/agile/1.0/sprint/${v.sprint}/issue`, { issues: [data.key] });
      console.log(`Created ${data.key}${v.sprint ? ` in sprint ${v.sprint}` : ''}: ${c.baseUrl}/browse/${data.key}`);
    },
  },

  edit: {
    help: 'edit fields of one issue or many (--task A,B | --jql … --max N; --summary, --description|--file, --assignee, --labels (set), --add-labels, --remove-labels, --priority, --parent, --due, --goals GOAL-1,… (set; "" clears), --dry-run)',
    options: { task: { type: 'string' }, jql: { type: 'string' }, max: { type: 'string' }, 'add-labels': { type: 'string' }, 'remove-labels': { type: 'string' }, ...COMMON_FIELDS },
    async run(v) {
      const { jira } = client('edit issues');
      const keys = await selectKeys(jira, v);
      const fields = await fieldsFrom(jira, v);
      const update = {};
      const labelOps = [...splitList(v['add-labels']).map((l) => ({ add: l })), ...splitList(v['remove-labels']).map((l) => ({ remove: l }))];
      if (labelOps.length) update.labels = labelOps;
      if (!Object.keys(fields).length && !labelOps.length) throw new UsageError('nothing to change: pass at least one field option');
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would edit ${keys.length} issue(s): ${keys.join(', ')}`);
        showFields(fields);
        if (labelOps.length) console.log(`  labels: ${labelOps.map((o) => (o.add ? `+${o.add}` : `-${o.remove}`)).join(' ')}`);
        console.log('DRY RUN — nothing written to Jira.');
        return 0;
      }
      let failed = 0;
      for (const key of keys) {
        try {
          await jira.raw('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields, update });
          console.log(`edited ${key}`);
        } catch (e) {
          failed += 1;
          console.error(`${key}: ${e.message}`);
        }
      }
      console.log(`${keys.length - failed}/${keys.length} edited`);
      return failed ? 2 : 0;
    },
  },

  'move-to-sprint': {
    help: 'move issues into a sprint, or back to the backlog (--sprint ID | --backlog; --task A,B | --jql … --max N; --dry-run)',
    options: { sprint: { type: 'string' }, backlog: { type: 'boolean' }, task: { type: 'string' }, jql: { type: 'string' }, max: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    async run(v) {
      if (!v.sprint && !v.backlog) throw new UsageError('--sprint ID or --backlog is required');
      const { jira } = client('move issues');
      const keys = await selectKeys(jira, v);
      let target = v.backlog ? 'the backlog' : `sprint ${v.sprint}`;
      if (v.sprint) {
        const s = await jira.get(`/rest/agile/1.0/sprint/${v.sprint}`);
        if (s.state === 'closed') throw new UsageError(`sprint ${s.name} is closed; issues cannot be moved into it`);
        target = `sprint ${s.id} "${s.name}" [${s.state}]`;
      }
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would move ${keys.length} issue(s) to ${target}: ${keys.join(', ')}`);
        console.log('DRY RUN — nothing written to Jira.');
        return 0;
      }
      for (let i = 0; i < keys.length; i += 50) {
        const issues = keys.slice(i, i + 50);
        const path = v.backlog ? '/rest/agile/1.0/backlog/issue' : `/rest/agile/1.0/sprint/${v.sprint}/issue`;
        await jira.post(path, { issues });
      }
      console.log(`Moved ${keys.length} issue(s) to ${target}`);
    },
  },

  link: {
    help: 'link two issues: --from A --type Blocks --to B means "A blocks B" (--dry-run); --types lists link types',
    options: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' }, types: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    async run(v) {
      if (v.types) {
        const { jira } = client('list link types');
        const { issueLinkTypes = [] } = await jira.get('/rest/api/3/issueLinkType');
        for (const t of issueLinkTypes) console.log(`${t.name.padEnd(16)} A ${t.outward} B  /  B ${t.inward} A`);
        return 0;
      }
      required(v, 'from', 'to', 'type');
      const body = { type: { name: v.type }, outwardIssue: { key: v.from }, inwardIssue: { key: v.to } };
      // The preview of a link reads nothing from Jira, so an explicit --dry-run works without credentials.
      const { c, jira } = client(`link ${v.from} to ${v.to}`, { offline: v['dry-run'] });
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would link: ${v.from} —${v.type}→ ${v.to}\nDRY RUN — nothing written to Jira.`);
        if (!jira) offlineNote(c);
        return 0;
      }
      await jira.post('/rest/api/3/issueLink', body);
      console.log(`Linked ${v.from} —${v.type}→ ${v.to}`);
    },
  },

  goals: {
    help: 'goals (OKRs): of a task (--task), or the list (--tag q3-26|current|next|previous, --owner me|email, --search text, --state on_track|at_risk|off_track|pending|done|…, --archived, --limit); --tags lists the tags',
    options: { task: { type: 'string' }, owner: { type: 'string' }, tag: { type: 'string' }, tags: { type: 'boolean' }, search: { type: 'string' }, state: { type: 'string' }, archived: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const { jira } = client('read goals');
      if (v.tags) {
        const counts = new Map();
        for (const g of await allGoals(jira)) for (const t of goalTags(g)) counts.set(t, (counts.get(t) || 0) + 1);
        if (v.json) return printJson(Object.fromEntries(counts));
        for (const [t, n] of [...counts].sort()) console.log(`${t.padEnd(16)} ${n} goal(s)`);
        console.log(`current quarter: ${quarterTag('current')}`);
        return 0;
      }
      if (!v.task) {
        let goals = await allGoals(jira);
        if (!v.archived) goals = goals.filter((g) => !g.isArchived);
        if (v.tag) {
          const want = splitList(v.tag).map((t) => quarterTag(t).toLowerCase());
          goals = goals.filter((g) => goalTags(g).some((t) => want.includes(t.toLowerCase())));
        }
        if (v.state) goals = goals.filter((g) => g.state?.value === v.state);
        if (v.owner) {
          const id = await accountId(jira, v.owner);
          goals = goals.filter((g) => g.owner?.accountId === id);
        }
        if (v.search) {
          const needle = v.search.toLowerCase();
          goals = goals.filter((g) => `${g.key} ${g.name} ${g.owner?.name || ''}`.toLowerCase().includes(needle));
        }
        goals = goals.slice(0, Number(v.limit || 200));
        if (v.json) return printJson(goals);
        for (const g of goals) console.log(goalLine(g));
        console.log(`${goals.length} goal(s)${v.tag ? ` tagged ${splitList(v.tag).map((t) => quarterTag(t)).join(', ')}` : ''}${v.archived ? '' : ' (archived hidden; --archived to include)'}`);
        return 0;
      }
      const ids = await fieldIdsByName(jira, ['Goals']);
      if (!ids.Goals) { console.log('this Jira site has no Goals field'); return 0; }
      const d = await fetchIssue(jira, v.task, `parent,${ids.Goals}`);
      const own = (d.fields[ids.Goals] || []).map((g) => g.id).filter(Boolean);
      let fromEpic = [];
      if (d.fields.parent) {
        const p = await fetchIssue(jira, d.fields.parent.key, ids.Goals);
        fromEpic = (p.fields[ids.Goals] || []).map((g) => g.id).filter((a) => a && !own.includes(a));
      }
      if (!own.length && !fromEpic.length) { console.log(`${v.task}: no goals on the task or its parent`); return 0; }
      for (const [ari, onEpic] of [...own.map((a) => [a, false]), ...fromEpic.map((a) => [a, true])]) {
        const goal = (await graphql(jira, `query OikosGoalById($a:ID!){ goals_byId(goalId:$a){ ${GOAL_FIELDS} } }`, { a: ari }))?.goals_byId;
        console.log(`${goal ? goalLine(goal) : `${ari} (goal not readable with these credentials)`}${onEpic ? '  (on parent)' : ''}`);
      }
    },
  },

  goal: {
    help: 'one goal: state, owner, due, tags, parent, sub-goals, comments, and the Jira issues attached to it (--key GOAL-42, --limit, --comments N)',
    options: { key: { type: 'string' }, limit: { type: 'string' }, comments: { type: 'string' } },
    async run(v) {
      required(v, 'key');
      const { jira } = client('read goals');
      const goal = await goalByKey(jira, v.key, `subGoals{ edges{ node{ key name isArchived state{label value} } } } comments(first:${Number(v.comments || 10)}){ edges{ node{ commentText creationDate creator{ name } } } }`);
      const { issues, truncated } = await jqlSearch(jira, `Goals = ${goal.key} ORDER BY status, key`, Number(v.limit || 100));
      if (v.json) return printJson({ goal, issues });
      console.log(goalLine(goal));
      console.log(`  ${goal.url}`);
      const subs = (goal.subGoals?.edges || []).map((e) => e.node).filter((g) => !g.isArchived);
      if (subs.length) console.log('\nSub-goals:', ...subs.map((g) => `\n  ${g.key} ${g.name.trim()} — ${g.state?.label || '?'}`));
      const comments = (goal.comments?.edges || []).map((e) => e.node);
      if (comments.length) {
        console.log(`\nComments (${comments.length}):`);
        for (const cm of comments) {
          let text = cm.commentText || '';
          try { text = adfToText(JSON.parse(text)); } catch { /* plain text */ }
          console.log(`  --- ${cm.creator?.name || '?'}, ${(cm.creationDate || '').slice(0, 10)}`);
          for (const line of text.trim().split('\n')) if (line.trim()) console.log(`      ${line.trim()}`);
        }
      }
      console.log(`\nJira issues attached (${issues.length}${truncated ? '+' : ''}):`);
      for (const i of issues) console.log(`  ${issueLine(i)}`);
      if (!issues.length) console.log('  (none — tasks may reach it through their epic: check the epics above)');
    },
  },

  mine: {
    help: "what is assigned to a person — open issues and this quarter's goals they own (--user me|email, default me; --tag current|q3-26; --all to include done issues)",
    options: { user: { type: 'string' }, tag: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const { jira } = client('read assignments');
      // "me" is the account of the API token — the person in JIRA_EMAIL.
      const who = v.user || 'me';
      const id = await accountId(jira, who);
      const user = await jira.get(`/rest/api/3/user?accountId=${id}`);
      const done = v.all ? '' : ' AND statusCategory != Done';
      const { issues, truncated } = await jqlSearch(jira, `assignee = "${id}"${done} ORDER BY status, priority DESC, updated DESC`, Number(v.limit || 100));
      const inSprint = new Set((await jqlSearch(jira, `assignee = "${id}"${done} AND sprint in openSprints()`, 500, 'summary')).issues.map((i) => i.key));
      const tag = quarterTag(v.tag || 'current');
      const goals = (await allGoals(jira)).filter((g) => !g.isArchived && g.owner?.accountId === id && goalTags(g).some((t) => t.toLowerCase() === tag.toLowerCase()));
      if (v.json) return printJson({ user, issues, goals });
      console.log(`${user.displayName}${user.emailAddress ? ` <${user.emailAddress}>` : ''}${who === 'me' ? ' (the account of JIRA_EMAIL)' : ''}`);
      console.log(`\n## Issues assigned${v.all ? '' : ', open'} (${issues.length}${truncated ? '+' : ''}; ${inSprint.size} in an active sprint)`);
      const byStatus = new Map();
      for (const i of issues) {
        const st = name(i.fields.status);
        if (!byStatus.has(st)) byStatus.set(st, []);
        byStatus.get(st).push(i);
      }
      for (const [st, list] of byStatus) {
        console.log(`\n### ${st} (${list.length})`);
        for (const i of list) console.log(`  ${inSprint.has(i.key) ? '*' : ' '} ${issueLine(i)}`);
      }
      if (inSprint.size) console.log('\n  * = in an active sprint');
      console.log(`\n## Goals owned, ${tag} (${goals.length})`);
      for (const g of goals) console.log(`  ${goalLine(g)}`);
      if (!goals.length) console.log('  (none)');
    },
  },

  'goal-comment': {
    help: 'add a markdown comment to a goal (--key GOAL-42, --text|--file, --dry-run)',
    options: { key: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'allow-non-english': { type: 'boolean' } },
    async run(v) {
      required(v, 'key');
      const text = readText(v);
      if (!text) throw new UsageError('--text or --file is required');
      englishOnly(v, text);
      const { jira } = client(`comment on goal ${v.key}`);
      const goal = await goalByKey(jira, v.key);
      if (v['dry-run']) {
        dryHeader();
        console.log(`Goal: ${goalLine(goal)}\nComment that WOULD be added:\n${'-'.repeat(40)}\n${text}\n${'-'.repeat(40)}`);
        console.log('DRY RUN — nothing written to Atlassian Home.');
        return 0;
      }
      const d = await graphql(jira, 'mutation OikosGoalComment($i:TownsquareGoalsCreateCommentInput!){ goals_createComment(input:$i){ success errors{ message } comment{ url } } }', {
        i: { entityId: goal.id, commentText: JSON.stringify(markdownToAdf(text)) },
      });
      const r = d?.goals_createComment;
      if (!r?.success) throw new UsageError(`comment not added: ${(r?.errors || []).map((e) => e.message).join('; ') || 'unknown error'}`);
      console.log(`Commented on ${goal.key}: ${r.comment?.url || goal.url}`);
    },
  },
});

runCli('jira', commands, { connector: 'jira' });
