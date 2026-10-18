#!/usr/bin/env node
// GitLab (GITLAB_URL): projects, merge requests, pipelines, job logs, files, and where a
// Jira task's code lives — for work that is not sitting in a checkout: the project is always named (--project group/name).
// Every command is a read.
import { runCli, required, printJson, UsageError } from '../common/cli.mjs';
import { gitlabClient, projectPath as proj } from '../common/gitlab.mjs';

const TAIL_LINES = 40;
// Broad on purpose: a missed error line costs a second command, a spurious one costs a line.
const ERROR_RE = /\b(error|fatal|failed|failure|traceback|exception|assert|panic|denied|refused|timeout)\b|^\s*E\s{2,}|##\[error\]/i;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// A task key matches only as a whole token: PROJ-123 never matches PROJ-1234 or XPROJ-123.
const wholeToken = (key, text) => Boolean(text) && new RegExp(`(?<![A-Za-z0-9-])${key.replace(/[-]/g, '\\-')}(?![A-Za-z0-9-])`).test(text);

const gl = () => gitlabClient('gitlab');
const when = (s) => (s ? s.slice(0, 16).replace('T', ' ') : '');
const gist = (s, n = 72) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

function mrLine(mr) {
  const where = mr.references?.full || `${mr.project_id}!${mr.iid}`;
  return `${where} [${mr.state}${mr.draft ? ', draft' : ''}] ${gist(mr.title)}\n    ${mr.source_branch} → ${mr.target_branch} · @${mr.author?.username} · ${when(mr.updated_at)}\n    ${mr.web_url}`;
}

function digest(log, tail, errorsOnly) {
  const lines = log.replace(ANSI_RE, '').split(/\r?\n/);
  const numbered = (n) => `${String(n).padStart(6)}  ${lines[n - 1]}`;
  const flagged = lines.map((l, i) => (ERROR_RE.test(l) ? i + 1 : 0)).filter(Boolean);
  if (errorsOnly) {
    return `# ${flagged.length} error line(s) of ${lines.length}; --full for the whole log\n` +
      (flagged.length ? flagged.map(numbered).join('\n') : '# no line matched an error pattern.');
  }
  const cut = Math.max(0, lines.length - tail);
  const early = flagged.filter((n) => n <= cut);
  const out = [`# ${lines.length} line(s); showing the last ${Math.min(tail, lines.length)} and ${early.length} earlier error line(s). --full for the whole log`];
  if (early.length) out.push(...early.map(numbered), `…${cut - early.length} line(s) not shown…`);
  for (let n = cut + 1; n <= lines.length; n++) out.push(numbered(n));
  return out.join('\n');
}

const commands = {
  whoami: {
    help: 'check the token: which GitLab user the tool acts as',
    options: {},
    async run(v) {
      const g = gl();
      const me = await g.get('/user');
      if (v.json) return printJson(me);
      console.log(`@${me.username} (${me.name}) on ${g.base}`);
    },
  },

  projects: {
    help: 'projects you can see (--search text, --group path, --limit)',
    options: { search: { type: 'string' }, group: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const g = gl();
      const q = new URLSearchParams({ order_by: 'last_activity_at', simple: 'true' });
      if (v.search) q.set('search', v.search);
      const path = v.group ? `/groups/${proj(v.group)}/projects?include_subgroups=true&${q}` : `/projects?membership=true&${q}`;
      const rows = await g.paged(path, Number(v.limit || 50));
      if (v.json) return printJson(rows);
      for (const p of rows) console.log(`${p.path_with_namespace.padEnd(48)} ${when(p.last_activity_at)}  ${p.web_url}`);
      console.log(`${rows.length} project(s)`);
    },
  },

  mrs: {
    help: 'merge requests (--project or --group, else all visible; --state opened|merged|closed|all, --author/--reviewer/--assignee username|me, --limit)',
    options: {
      project: { type: 'string' }, group: { type: 'string' }, state: { type: 'string' },
      author: { type: 'string' }, reviewer: { type: 'string' }, assignee: { type: 'string' },
      search: { type: 'string' }, limit: { type: 'string' },
    },
    async run(v) {
      const g = gl();
      const q = new URLSearchParams({ state: v.state || 'opened', order_by: 'updated_at' });
      // "me" is the owner of GITLAB_TOKEN.
      let meName;
      const user = async (u) => (u === 'me' ? (meName ??= (await g.get('/user')).username) : u);
      if (v.author) q.set('author_username', await user(v.author));
      if (v.reviewer) q.set('reviewer_username', await user(v.reviewer));
      if (v.assignee) q.set('assignee_username', await user(v.assignee));
      if (v.search) q.set('search', v.search);
      let path = `/merge_requests?scope=all&${q}`;
      if (v.project) path = `/projects/${proj(v.project)}/merge_requests?${q}`;
      else if (v.group) path = `/groups/${proj(v.group)}/merge_requests?${q}`;
      const rows = await g.paged(path, Number(v.limit || 30));
      if (v.json) return printJson(rows);
      for (const mr of rows) console.log(mrLine(mr));
      console.log(`${rows.length} merge request(s)`);
    },
  },

  pipelines: {
    help: 'recent pipelines of a project (--project, --ref, --status, --limit)',
    options: { project: { type: 'string' }, ref: { type: 'string' }, status: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'project');
      const g = gl();
      const q = new URLSearchParams();
      if (v.ref) q.set('ref', v.ref);
      if (v.status) q.set('status', v.status);
      const rows = await g.paged(`/projects/${proj(v.project)}/pipelines?${q}`, Number(v.limit || 10));
      if (v.json) return printJson(rows);
      for (const p of rows) console.log(`${String(p.id).padStart(8)}  ${p.status.padEnd(9)} ${p.ref.padEnd(32)} ${p.sha.slice(0, 8)}  ${when(p.created_at)}`);
      console.log(`${rows.length} pipeline(s)`);
    },
  },

  jobs: {
    help: 'jobs of a pipeline (--project, --pipeline ID)',
    options: { project: { type: 'string' }, pipeline: { type: 'string' } },
    async run(v) {
      required(v, 'project', 'pipeline');
      const g = gl();
      const rows = await g.paged(`/projects/${proj(v.project)}/pipelines/${v.pipeline}/jobs?include_retried=false`, 200);
      if (v.json) return printJson(rows);
      for (const j of rows) console.log(`${String(j.id).padStart(8)}  ${j.status.padEnd(9)} ${j.stage.padEnd(14)} ${j.name}`);
    },
  },

  'job-log': {
    help: 'a job log, digested: tail + earlier error lines (--project, --id, --errors | --full | --tail N)',
    options: { project: { type: 'string' }, id: { type: 'string' }, errors: { type: 'boolean' }, full: { type: 'boolean' }, tail: { type: 'string' } },
    async run(v) {
      required(v, 'project', 'id');
      const g = gl();
      const { data } = await g.api(`/projects/${proj(v.project)}/jobs/${v.id}/trace`, { as: 'text' });
      console.log(v.full ? data.replace(ANSI_RE, '') : digest(data, Number(v.tail || TAIL_LINES), v.errors));
    },
  },

  file: {
    help: 'a file from a repository (--project, --path, --ref default: the default branch)',
    options: { project: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
    async run(v) {
      required(v, 'project', 'path');
      const g = gl();
      const ref = v.ref || (await g.get(`/projects/${proj(v.project)}`)).default_branch;
      const { data } = await g.api(`/projects/${proj(v.project)}/repository/files/${encodeURIComponent(v.path)}/raw?ref=${encodeURIComponent(ref)}`, { as: 'text' });
      process.stdout.write(data.endsWith('\n') ? data : `${data}\n`);
    },
  },

  task: {
    help: 'merge requests carrying a Jira key in title or branch, across GitLab (task KEY [--mentions] [--state])',
    options: { mentions: { type: 'boolean' }, state: { type: 'string' }, limit: { type: 'string' } },
    async run(v, positionals) {
      const key = (positionals[0] || '').toUpperCase();
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new UsageError('usage: task <KEY>, e.g. task PROJ-123');
      const g = gl();
      const q = new URLSearchParams({ scope: 'all', state: v.state || 'all', search: key });
      const byText = await g.paged(`/merge_requests?${q}`, Number(v.limit || 100));
      const carries = byText.filter((mr) => wholeToken(key, mr.title) || wholeToken(key, mr.source_branch));
      const mentions = byText.filter((mr) => !carries.includes(mr) && wholeToken(key, mr.description));
      if (v.json) return printJson({ carries, mentions });
      console.log(`# ${key} on ${g.base}: ${carries.length} merge request(s) carry it, ${mentions.length} only mention it`);
      for (const mr of carries) console.log(mrLine(mr));
      if (v.mentions) for (const mr of mentions) console.log(`(mention) ${mrLine(mr)}`);
      else if (mentions.length) console.log(`# --mentions to list the ${mentions.length} that only mention it`);
      console.log('# GitLab only; GitHub-hosted repositories are not searched by this tool.');
    },
  },
};

runCli('gitlab', commands, { connector: 'gitlab' });
