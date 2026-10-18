#!/usr/bin/env node
// GitHub: the list of an organization's repositories and the files in them — read-only, by design.
// The organization is GITHUB_ORG (settings in oikos.yaml) or --org. Issues, projects,
// wikis and managing repositories are not here.
import { runCli, required, printJson } from '../common/cli.mjs';
import { defaultOrg, githubClient, repoName } from '../common/github.mjs';

const gh = () => githubClient('github');

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

runCli('github', commands, { connector: 'github' });
