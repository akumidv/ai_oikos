#!/usr/bin/env node
// GitHub: the list of an organization's repositories and the files in them — read-only, by design.
// The organization is GITHUB_ORG (settings in oikos.yaml) or --org. Issues, projects,
// wikis and managing repositories are not here.
import { execFileSync } from 'node:child_process';
import { runCli, required, printJson, UsageError } from '../common/cli.mjs';
import { lookup, envValue, credentialsHelp } from '../common/env.mjs';
import { request, HttpError } from '../common/http.mjs';

const API = 'https://api.github.com';
const defaultOrg = () => {
  const org = envValue('GITHUB_ORG');
  if (!org) throw new UsageError('no organization: pass --org, a full org/name, or set GITHUB_ORG in oikos.yaml settings');
  return org;
};

/** GITHUB_TOKEN from the environment / .local/.env, else the `gh` CLI's login. */
function token() {
  const t = lookup('GITHUB_TOKEN');
  if (t.value) return { value: t.value, route: `token (${t.source})` };
  try {
    const value = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (value) return { value, route: 'gh auth token' };
  } catch { /* no gh, or not logged in */ }
  throw new UsageError(`no GitHub credential\n${credentialsHelp(['GITHUB_TOKEN'], {
    extra: ['  Token (fine-grained, read-only Contents + Metadata on the organization): https://github.com/settings/tokens', '  Or log in once with `gh auth login`.'],
  })}`);
}

function gh() {
  const t = token();
  const api = async (path, opts = {}) => {
    try {
      const { headers = {}, ...rest } = opts;
      return await request(path.startsWith('http') ? path : `${API}${path}`, {
        tool: 'github',
        headers: { Authorization: `Bearer ${t.value}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...headers },
        ...rest,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new UsageError(`GitHub rejected the credential (401, route: ${t.route})`);
      if (e instanceof HttpError && e.status === 404) throw new UsageError(`not found, or no access (GitHub answers 404 for both): ${path}`);
      throw e;
    }
  };
  /** Follow the Link rel="next" header until `limit` rows. */
  const paged = async (path, limit) => {
    const rows = [];
    let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (url && rows.length < limit) {
      const r = await api(url);
      rows.push(...r.data);
      url = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return rows.slice(0, limit);
  };
  return { api, paged, route: t.route };
}

const repoName = (r) => (r.includes('/') ? r : `${defaultOrg()}/${r}`);

const commands = {
  whoami: {
    help: 'check the credential: which GitHub user, which route',
    options: {},
    async run(v) {
      const g = gh();
      const { data } = await g.api('/user');
      if (v.json) return printJson(data);
      console.log(`@${data.login} (${data.name || '-'}) via ${g.route}`);
    },
  },

  repos: {
    help: `repositories of an organisation (--org, default GITHUB_ORG; --search text; --limit)`,
    options: { org: { type: 'string' }, search: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const g = gh();
      const rows = await g.paged(`/orgs/${v.org || defaultOrg()}/repos?sort=pushed&type=all`, Number(v.limit || 200));
      const shown = v.search ? rows.filter((r) => `${r.name} ${r.description || ''}`.toLowerCase().includes(v.search.toLowerCase())) : rows;
      if (v.json) return printJson(shown);
      for (const r of shown) {
        console.log(`${r.full_name.padEnd(44)} ${r.private ? 'private' : 'public '} ${(r.pushed_at || '').slice(0, 10)}  ${r.archived ? '[archived] ' : ''}${r.description || ''}`);
      }
      console.log(`${shown.length} repositor${shown.length === 1 ? 'y' : 'ies'}`);
    },
  },

  ls: {
    help: 'files of a repository (--repo name|org/name, --path dir, --ref branch; --recursive for the whole tree)',
    options: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' }, recursive: { type: 'boolean' } },
    async run(v) {
      required(v, 'repo');
      const g = gh();
      const repo = repoName(v.repo);
      const ref = v.ref || (await g.api(`/repos/${repo}`)).data.default_branch;
      if (v.recursive) {
        const { data } = await g.api(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
        const prefix = v.path ? `${v.path.replace(/\/+$/, '')}/` : '';
        const items = data.tree.filter((t) => t.path.startsWith(prefix));
        if (v.json) return printJson(items);
        for (const t of items) console.log(`${t.type === 'tree' ? 'dir ' : 'file'}  ${t.path}`);
        console.log(`${items.length} entr${items.length === 1 ? 'y' : 'ies'} at ${ref}${data.truncated ? ' — TRUNCATED by GitHub, narrow --path' : ''}`);
        return 0;
      }
      const { data } = await g.api(`/repos/${repo}/contents/${(v.path || '').replace(/^\/+/, '')}?ref=${encodeURIComponent(ref)}`);
      const items = Array.isArray(data) ? data : [data];
      if (v.json) return printJson(items);
      for (const i of items) console.log(`${i.type === 'dir' ? 'dir ' : 'file'}  ${i.path}${i.type === 'file' ? `  (${i.size} bytes)` : ''}`);
      console.log(`${items.length} entr${items.length === 1 ? 'y' : 'ies'} at ${ref}`);
    },
  },

  file: {
    help: 'the content of a file (--repo, --path, --ref default: the default branch)',
    options: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
    async run(v) {
      required(v, 'repo', 'path');
      const g = gh();
      const repo = repoName(v.repo);
      const q = v.ref ? `?ref=${encodeURIComponent(v.ref)}` : '';
      const { data } = await g.api(`/repos/${repo}/contents/${v.path.replace(/^\/+/, '')}${q}`, {
        headers: { Accept: 'application/vnd.github.raw+json' }, as: 'text',
      });
      process.stdout.write(data.endsWith('\n') ? data : `${data}\n`);
    },
  },
};

runCli('github', commands);
