#!/usr/bin/env node
// GitHub: the list of an organization's repositories and the files in them — read-only, by design.
// The organization is GITHUB_ORG (settings in oikos.yaml) or --org. Issues, projects,
// wikis and managing repositories are not here. Pull requests are read: one by URL, and those of a
// task key in named repositories (common/pullrequests.mjs). Governance is read too — what guards a
// branch, and the merged pull requests of a period with their reviews (governance.mjs).
import { runCli, required, printJson, UsageError } from '../common/cli.mjs';
import { defaultOrg, githubClient, githubPullRequest, repoName } from '../common/github.mjs';
import { codeHosts, collectPullRequests, parsePullRequestUrl } from '../common/pullrequests.mjs';
import { isDate, mergeLine, mergeTotals, totalsLine } from '../common/governance.mjs';
import { githubGovernance, githubGovernanceLines, githubMerged } from './governance.mjs';

const gh = () => githubClient('github');
const MERGED_LIMIT = 200;

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

  pr: {
    help: 'one pull request by its URL: state (open, draft, merged, closed), branch, title',
    options: { url: { type: 'string' } },
    async run(v) {
      required(v, 'url');
      const parsed = parsePullRequestUrl(v.url);
      if (!parsed || parsed.host !== 'github') throw new UsageError(`not a GitHub pull request URL (…/<owner>/<name>/pull/<n>): ${v.url}`);
      const pr = await githubPullRequest(gh(), parsed.path, parsed.number);
      if (v.json) return printJson(pr);
      console.log(`${pr.state.padEnd(7)} ${pr.repo}#${pr.number}  ${pr.title}\n        ${pr.url}  (branch ${pr.branch || '?'})`);
    },
  },

  prs: {
    help: 'pull requests and branches of a task key in named repositories (--key PROJ-123, --repo name|org/name, repeatable or comma list; --alias PJ for PJ-123): title or branch carries the key as a whole token',
    options: { key: { type: 'string' }, repo: { type: 'string', multiple: true }, alias: { type: 'string', multiple: true } },
    async run(v) {
      required(v, 'key', 'repo');
      const list = (values) => (values || []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
      const repos = list(v.repo).map((r) => `github:${repoName(r)}`);
      const found = await collectPullRequests(v.key, { aliases: list(v.alias), repos, hosts: codeHosts('github') });
      if (v.json) return printJson(found);
      for (const pr of found.pullRequests) console.log(`${pr.state.padEnd(7)} ${pr.repo}#${pr.number}  ${pr.title}\n        ${pr.url}  (branch ${pr.branch || '?'})`);
      for (const b of found.branches) console.log(`branch  ${b.repo}  ${b.branch}  (no pull request)`);
      for (const n of found.notes) console.log(`# ${n}`);
      console.log(`${found.pullRequests.length} pull request(s), ${found.branches.length} branch(es) without one, for ${found.keys.join(', ')} in ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`);
    },
  },

  governance: {
    help: 'what guards a branch (--repo, --branch default: the default branch): rules and rulesets, classic protection, environments, CODEOWNERS',
    options: { repo: { type: 'string' }, branch: { type: 'string' } },
    async run(v) {
      required(v, 'repo');
      const gov = await githubGovernance(gh(), repoName(v.repo), { branch: v.branch });
      if (v.json) return printJson(gov);
      for (const line of githubGovernanceLines(gov)) console.log(line);
    },
  },

  merged: {
    help: 'pull requests merged since a date (--repo, --since YYYY-MM-DD, --limit default 200): author, merger, approvals, open→merge time, totals',
    options: { repo: { type: 'string' }, since: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'repo', 'since');
      if (!isDate(v.since)) throw new UsageError(`--since is not a date YYYY-MM-DD: ${v.since}`);
      const repo = repoName(v.repo);
      const found = await githubMerged(gh(), repo, v.since, Number(v.limit || MERGED_LIMIT));
      const totals = mergeTotals(found.records);
      if (v.json) return printJson({ repo, since: v.since, totals, found: found.found, truncated: found.truncated, pullRequests: found.pullRequests });
      for (const r of found.records) console.log(mergeLine(r));
      console.log(`github:${repo} since ${v.since}: ${totalsLine(totals)}`);
      if (found.truncated) console.log(`# ${found.found} found, ${found.records.length} read — raise --limit for the rest`);
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
