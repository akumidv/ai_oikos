// GitLab client shared by the GitLab tools: GITLAB_URL (the site, from the settings) and
// GITLAB_TOKEN, REST v4 with X-Next-Page pagination, 401/404 named.
import { UsageError } from './cli.mjs';
import { lookup, credentialsHelp } from './env.mjs';
import { request, HttpError } from './http.mjs';

const readTokenHelp = (base) => [`  Token (scope read_api or api): ${base}/-/user_settings/personal_access_tokens`];

/** A project or group path (`group/name`) as one URL segment. */
export const projectPath = (p) => encodeURIComponent(p);

/**
 * A GitLab client for `tool` (its User-Agent name): { base, get, api, paged, post, put }. The site
 * and token are looked up at once, so a missing one fails before any request. `help` are the token
 * lines after the credential rows — an array, or a function of the site's base URL (default: a
 * `read_api` token).
 *
 * `api(path, opts)` answers { status, headers, data }. A 404 is a usage error "not found, or no
 * access" — unless `opts.absentOn404`, for a path whose absence is an answer (a file probed, a
 * feature the tier lacks): then it returns null, and so does `get(path, opts)`. A 403 stays an
 * HttpError with GitLab's body, so the caller can report the role or tier it needs.
 */
export function gitlabClient(tool, { help = readTokenHelp } = {}) {
  const url = lookup('GITLAB_URL').value;
  // Without the site there is no token page to point at either: name the key and stop before any request.
  if (!url) throw new UsageError(`no GITLAB_URL\n${credentialsHelp(['GITLAB_URL', 'GITLAB_TOKEN'])}`);
  const base = url.replace(/\/+$/, '');
  const token = lookup('GITLAB_TOKEN').value;
  const helpText = () => credentialsHelp(['GITLAB_URL', 'GITLAB_TOKEN'], {
    extra: typeof help === 'function' ? help(base) : help,
  });
  if (!token) throw new UsageError(`no GITLAB_TOKEN\n${helpText()}`);
  const api = async (path, opts = {}) => {
    const { absentOn404 = false, ...rest } = opts;
    try {
      return await request(`${base}/api/v4${path}`, { tool, headers: { 'PRIVATE-TOKEN': token }, ...rest });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new UsageError(`GitLab rejected the token (401)\n${helpText()}`);
      if (e instanceof HttpError && e.status === 404) {
        if (absentOn404) return null;
        throw new UsageError(`not found, or no access (GitLab answers 404 for both): ${path}`);
      }
      throw e;
    }
  };
  const get = async (path, opts = {}) => {
    const r = await api(path, opts);
    return r === null ? null : r.data;
  };
  const post = async (path, body) => (await api(path, { method: 'POST', body })).data;
  const put = async (path, body) => (await api(path, { method: 'PUT', body })).data;
  /** Follow X-Next-Page until `limit` rows. */
  const paged = async (path, limit) => {
    const rows = [];
    let page = 1;
    while (page && rows.length < limit) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await api(`${path}${sep}per_page=${Math.min(limit, 100)}&page=${page}`);
      rows.push(...r.data);
      page = Number(r.headers.get('x-next-page')) || 0;
    }
    return rows.slice(0, limit);
  };
  return { base, get, api, paged, post, put };
}

// == merge requests: one by iid, and those whose title or branch carries a text ==
// A merge request record is { url, repo: 'gitlab:<group>/<name>', number, title, branch, state }, the
// state one of open, draft, merged, closed (common/pullrequests.mjs collects and filters them).

const BY_TEXT_LIMIT = 100;

/** The state of a merge request: open, draft, merged or closed (a locked one is being merged: open). */
function mrState(mr) {
  if (mr.state === 'merged' || mr.state === 'closed') return mr.state;
  return mr.draft || mr.work_in_progress ? 'draft' : 'open';
}

const mrRecord = (path, mr) => ({
  url: mr.web_url, repo: `gitlab:${path}`, number: mr.iid, title: mr.title, branch: mr.source_branch || null, state: mrState(mr),
});

/**
 * One merge request of the project `path` by its iid.
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} path the project, `group/name`
 * @param {number} iid the merge request's number in the project
 * @returns {Promise<{url: string, repo: string, number: number, title: string, branch: string|null, state: string}>}
 */
export async function gitlabMergeRequest(g, path, iid) {
  return mrRecord(path, await g.get(`/projects/${projectPath(path)}/merge_requests/${iid}`));
}

const COMMIT_SEARCH_LIMIT = 100;

/**
 * The commits of the project `path` that GitLab's project search finds for `text`
 * (`search?scope=commits`), at most the first 100: each { sha, message, url }. The caller keeps those
 * whose message carries a key or a pattern as a whole token. `truncated` when the first 100 are full.
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} path the project, `group/name`
 * @param {string} text what to look for: a task key, or a bare number
 * @returns {Promise<{ commits: {sha: string, message: string, url: string}[], truncated: boolean }>}
 */
export async function gitlabCommitsByText(g, path, text) {
  const rows = await g.paged(`/projects/${projectPath(path)}/search?${new URLSearchParams({ scope: 'commits', search: text })}`, COMMIT_SEARCH_LIMIT);
  const commits = rows.map((c) => ({ sha: c.id, message: c.message || c.title || '', url: c.web_url || null }));
  return { commits, truncated: rows.length >= COMMIT_SEARCH_LIMIT };
}

/**
 * The merge requests of the project `path` that hold the commit `sha`.
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} path the project, `group/name`
 * @param {string} sha the commit
 * @returns {Promise<object[]>} merge request records
 */
export async function gitlabCommitMergeRequests(g, path, sha) {
  const rows = await g.get(`/projects/${projectPath(path)}/repository/commits/${encodeURIComponent(sha)}/merge_requests`);
  return (Array.isArray(rows) ? rows : []).map((mr) => mrRecord(path, mr));
}

/**
 * The merge requests and branches of the project `path` whose title or branch name contains one of
 * `texts` (GitLab's `search`, a substring): the merge requests by title, the branches, and the merge
 * requests of each branch `keep` accepts (one request per branch, so the caller narrows them first).
 * The caller keeps those that carry a text as a whole token.
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} path the project, `group/name`
 * @param {string[]} texts what to look for, e.g. task keys
 * @param {{ keep?: (branch: string) => boolean }} [options] which found branches to follow
 * @returns {Promise<{ pullRequests: object[], branches: {repo: string, branch: string}[], truncated: string[] }>}
 */
export async function gitlabByText(g, path, texts, { keep = () => true } = {}) {
  const project = `/projects/${projectPath(path)}`;
  const pullRequests = [];
  const branches = [];
  const truncated = [];
  for (const text of texts) {
    const titled = await g.paged(`${project}/merge_requests?${new URLSearchParams({ state: 'all', in: 'title', search: text })}`, BY_TEXT_LIMIT);
    if (titled.length >= BY_TEXT_LIMIT) truncated.push(`merge requests of gitlab:${path} titled ${text}`);
    pullRequests.push(...titled.map((mr) => mrRecord(path, mr)));
    const named = await g.paged(`${project}/repository/branches?${new URLSearchParams({ search: text })}`, BY_TEXT_LIMIT);
    if (named.length >= BY_TEXT_LIMIT) truncated.push(`branches of gitlab:${path} matching ${text}`);
    for (const b of named.filter((x) => keep(x.name))) {
      const own = await g.paged(`${project}/merge_requests?${new URLSearchParams({ state: 'all', source_branch: b.name })}`, 5);
      if (!own.length) branches.push({ repo: `gitlab:${path}`, branch: b.name });
      pullRequests.push(...own.map((mr) => mrRecord(path, mr)));
    }
  }
  return { pullRequests, branches, truncated };
}
