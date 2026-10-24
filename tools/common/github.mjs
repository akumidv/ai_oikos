// GitHub client shared by the GitHub tools: the credential (GITHUB_TOKEN, else the `gh` login),
// REST with Link pagination, GraphQL, and the default organization. GITHUB_API_URL points it at a
// GitHub Enterprise Server (`https://<host>/api/v3`); GITHUB_SERVER_URL overrides the web/git host
// derived from it.
import { execFileSync } from 'node:child_process';
import { UsageError } from './cli.mjs';
import { lookup, envValue, credentialsHelp } from './env.mjs';
import { request, HttpError } from './http.mjs';

const DEFAULT_API = 'https://api.github.com';
const READ_ONLY_HELP = [
  '  Token (fine-grained, read-only Contents + Metadata on the organization): https://github.com/settings/tokens',
  '  Or log in once with `gh auth login`.',
];

/** GITHUB_ORG from the settings; a usage error without one. */
export function defaultOrg() {
  const org = envValue('GITHUB_ORG');
  if (!org) throw new UsageError('no organization: pass --org, a full org/name, or set GITHUB_ORG in oikos.yaml settings');
  return org;
}

/** `org/name` as given, or `name` under the default organization. */
export const repoName = (r) => (r.includes('/') ? r : `${defaultOrg()}/${r}`);

/**
 * GITHUB_TOKEN from the installation / environment, else the `gh` CLI's login: { value, route }.
 * `help` are the lines after the credential rows when there is none (default: the read-only token).
 */
export function githubToken({ help = READ_ONLY_HELP } = {}) {
  const t = lookup('GITHUB_TOKEN');
  if (t.value) return { value: t.value, route: `token (${t.source})` };
  try {
    const value = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (value) return { value, route: 'gh auth token' };
  } catch { /* no gh, or not logged in */ }
  throw new UsageError(`no GitHub credential\n${credentialsHelp(['GITHUB_TOKEN'], { extra: help })}`);
}

/**
 * The endpoints for an API URL (default api.github.com) and an optional explicit server URL:
 * { apiUrl, serverUrl, graphqlUrl }. GitHub Enterprise Server serves REST at `<host>/api/v3` and
 * GraphQL at `<host>/api/graphql`; its web and git host is `<host>`.
 */
export function githubEndpoints(apiUrl, serverUrl) {
  const api = (apiUrl || DEFAULT_API).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(api)) throw new UsageError(`GITHUB_API_URL is not an http(s) URL: ${api}`);
  const enterprise = api.match(/^(.*)\/api\/v3$/);
  let server = serverUrl?.replace(/\/+$/, '');
  if (!server) server = api === DEFAULT_API ? 'https://github.com' : enterprise ? enterprise[1] : new URL(api).origin;
  return { apiUrl: api, serverUrl: server, graphqlUrl: enterprise ? `${enterprise[1]}/api/graphql` : `${api}/graphql` };
}

/**
 * The error for a GraphQL answer's `errors`: NOT_FOUND → usage error "not found, or no access";
 * FORBIDDEN / INSUFFICIENT_SCOPES → usage error with GitHub's message (it names the missing scope);
 * RATE_LIMITED → HttpError saying GitHub limits the rate of requests, with the answer's `headers`
 * (when to retry) and `graphqlTypes`; anything else → HttpError with the joined messages.
 */
export function graphqlError(errors, { status = 200, url, headers = null } = {}) {
  const messages = errors.map((e) => e.message).join('; ');
  const types = errors.map((e) => e.type);
  if (types.includes('NOT_FOUND')) return new UsageError(`not found, or no access: ${messages}`);
  const refused = types.find((t) => t === 'FORBIDDEN' || t === 'INSUFFICIENT_SCOPES');
  if (refused) return new UsageError(`GitHub refused the request (${refused}): ${messages}`);
  if (!types.includes('RATE_LIMITED')) return new HttpError(status, url, messages);
  const limited = new HttpError(status, url, `GitHub limits the rate of requests (RATE_LIMITED): ${messages}`, headers);
  limited.graphqlTypes = types;
  return limited;
}

/**
 * A GitHub client for `tool` (its User-Agent name): { api, paged, graphql, route, apiUrl,
 * serverUrl }. The credential is looked up at once, so a missing one fails before any request;
 * `help` goes to `githubToken`.
 *
 * `api(path, opts)` answers { status, headers, data }. A 404 is a usage error "not found, or no
 * access" — unless `opts.absentOn404`, for a path whose absence is an answer (a file probed, a
 * branch without protection): then it returns null. A 403 stays an HttpError with GitHub's body, so
 * the caller can report what the token lacks.
 */
export function githubClient(tool, { help } = {}) {
  const t = githubToken(help ? { help } : {});
  const { apiUrl, serverUrl, graphqlUrl } = githubEndpoints(envValue('GITHUB_API_URL'), envValue('GITHUB_SERVER_URL'));
  const api = async (path, opts = {}) => {
    const { headers = {}, absentOn404 = false, ...rest } = opts;
    try {
      return await request(path.startsWith('http') ? path : `${apiUrl}${path}`, {
        tool,
        headers: { Authorization: `Bearer ${t.value}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...headers },
        ...rest,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new UsageError(`GitHub rejected the credential (401, route: ${t.route})`);
      if (e instanceof HttpError && e.status === 404) {
        if (absentOn404) return null;
        throw new UsageError(`not found, or no access (GitHub answers 404 for both): ${path}`);
      }
      throw e;
    }
  };
  /** Follow the Link rel="next" header until `limit` rows. */
  const paged = async (path, limit) => {
    const rows = [];
    let url = `${apiUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (url && rows.length < limit) {
      const r = await api(url);
      rows.push(...r.data);
      url = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return rows.slice(0, limit);
  };
  /**
   * One GraphQL call: its `data`, or the mapped error of its `errors`. An answer with neither (a
   * gateway that gave up on a slow query answers 200 with an empty body) is an HttpError of its status.
   */
  const graphql = async (query, variables = {}) => {
    const r = await api(graphqlUrl, { method: 'POST', body: { query, variables } });
    if (r.data?.errors?.length) throw graphqlError(r.data.errors, { status: r.status, url: graphqlUrl, headers: r.headers });
    if (!r.data?.data) throw new HttpError(r.status, graphqlUrl, 'GitHub returned no data for the query (neither data nor errors)');
    return r.data.data;
  };
  return { api, paged, graphql, route: t.route, apiUrl, serverUrl };
}

// == pull requests: one by number, and those whose title or branch carries a text ==
// A pull request record is { url, repo: 'github:<owner>/<name>', number, title, branch, state }, the
// state one of open, draft, merged, closed (common/pullrequests.mjs collects and filters them).

const PR_FIELDS = 'url number title state isDraft headRefName';
const BY_TEXT_LIMIT = 50;

/** The state of a pull request as the REST API returns it: open, draft, merged or closed. */
const restState = (pr) => (pr.merged_at ? 'merged' : pr.state === 'open' && pr.draft ? 'draft' : pr.state);
/** The state of a pull request as GraphQL returns it (OPEN, CLOSED, MERGED; isDraft). */
const graphqlState = (pr) => (pr.state === 'OPEN' && pr.isDraft ? 'draft' : String(pr.state).toLowerCase());

const graphqlRecord = (repo, pr) => ({
  url: pr.url, repo: `github:${repo}`, number: pr.number, title: pr.title, branch: pr.headRefName || null, state: graphqlState(pr),
});

const restRecord = (repo, pr) => ({
  url: pr.html_url, repo: `github:${repo}`, number: pr.number, title: pr.title, branch: pr.head?.ref || null, state: restState(pr),
});

/**
 * One pull request of `repo` (`owner/name`) by number, read through the REST API.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} repo `owner/name`
 * @param {number} number the pull request's number
 * @returns {Promise<{url: string, repo: string, number: number, title: string, branch: string|null, state: string}>}
 */
export async function githubPullRequest(g, repo, number) {
  const { data } = await g.api(`/repos/${repo}/pulls/${number}`);
  return restRecord(repo, data);
}

const COMMIT_SEARCH_LIMIT = 100;

/**
 * The commits of `repo` (`owner/name`) that GitHub's commit search finds for `text` — REST, since
 * GraphQL has none; it reads the default branch only and shares the search rate limit — at most the
 * first 100: each { sha, message, url }. The caller keeps those whose message carries a key or a
 * pattern as a whole token. `truncated` when GitHub found more.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} repo `owner/name`
 * @param {string} text what to look for: a task key, or a bare number
 * @returns {Promise<{ commits: {sha: string, message: string, url: string}[], truncated: boolean }>}
 */
export async function githubCommitsByText(g, repo, text) {
  const q = `repo:${repo} "${String(text).replace(/"/g, '')}"`;
  const { data } = await g.api(`/search/commits?${new URLSearchParams({ q, per_page: String(COMMIT_SEARCH_LIMIT) })}`);
  const commits = (data.items || []).map((c) => ({ sha: c.sha, message: c.commit?.message || '', url: c.html_url || null }));
  return { commits, truncated: (data.total_count || 0) > COMMIT_SEARCH_LIMIT };
}

/**
 * The pull requests of `repo` (`owner/name`) that hold the commit `sha`.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} repo `owner/name`
 * @param {string} sha the commit
 * @returns {Promise<object[]>} pull request records
 */
export async function githubCommitPullRequests(g, repo, sha) {
  const { data } = await g.api(`/repos/${repo}/commits/${encodeURIComponent(sha)}/pulls`);
  return (Array.isArray(data) ? data : []).map((pr) => restRecord(repo, pr));
}

/**
 * The pull requests and branches of `repo` whose title or branch name contains one of `texts`
 * (GitHub matches a branch by substring, case-insensitively, and a title by search words), in one
 * GraphQL request: the branches with their pull requests, and the pull requests found by title.
 * The caller keeps those that carry a text as a whole token. `truncated` names a list GitHub cut at
 * its first page.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} repo `owner/name`
 * @param {string[]} texts what to look for, e.g. task keys
 * @returns {Promise<{ pullRequests: object[], branches: {repo: string, branch: string}[], truncated: string[] }>}
 */
export async function githubByText(g, repo, texts) {
  const [owner, name] = repo.split('/');
  const params = ['$owner: String!', '$name: String!'];
  const refs = [];
  const searches = [];
  const variables = { owner, name };
  texts.forEach((text, i) => {
    params.push(`$ref${i}: String!`, `$search${i}: String!`);
    variables[`ref${i}`] = text;
    variables[`search${i}`] = `is:pr repo:${repo} in:title "${text.replace(/"/g, '')}"`;
    refs.push(`ref${i}: refs(refPrefix: "refs/heads/", query: $ref${i}, first: ${BY_TEXT_LIMIT}) {
      totalCount nodes { name associatedPullRequests(first: 5) { nodes { ${PR_FIELDS} } } } }`);
    searches.push(`search${i}: search(query: $search${i}, type: ISSUE, first: ${BY_TEXT_LIMIT}) {
      issueCount nodes { ... on PullRequest { ${PR_FIELDS} } } }`);
  });
  const query = `query(${params.join(', ')}) { repository(owner: $owner, name: $name) { ${refs.join('\n')} }\n${searches.join('\n')} }`;
  const data = await g.graphql(query, variables);
  const pullRequests = [];
  const branches = [];
  const truncated = [];
  texts.forEach((text, i) => {
    const found = data.repository?.[`ref${i}`];
    if (found?.totalCount > BY_TEXT_LIMIT) truncated.push(`branches of github:${repo} matching ${text}`);
    for (const ref of found?.nodes || []) {
      const prs = ref.associatedPullRequests?.nodes || [];
      if (!prs.length) branches.push({ repo: `github:${repo}`, branch: ref.name });
      for (const pr of prs) pullRequests.push(graphqlRecord(repo, pr));
    }
    const search = data[`search${i}`];
    if (search?.issueCount > BY_TEXT_LIMIT) truncated.push(`pull requests of github:${repo} titled ${text}`);
    for (const pr of search?.nodes || []) if (pr?.url) pullRequests.push(graphqlRecord(repo, pr));
  });
  return { pullRequests, branches, truncated };
}

// == project setup: pull requests across an owner, an owner's repositories, a repository's recent names ==

const OWNER_SEARCH_LIMIT = 100;
const OWNER_REPOS_LIMIT = 1000;
const RECENT_LIMIT = 100;

/**
 * The pull requests under `owner` (a user or an organization) that GitHub's search finds for `text`
 * and that were updated on or after `since`, newest first, at most the first 100: each as
 * { repo: 'github:<owner>/<name>', url, title, branch }. The caller keeps those that carry a key as
 * a whole token (the search also matches bodies). `truncated` when GitHub found more.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} owner the user or organization login
 * @param {string} text the search words, e.g. a project key
 * @param {string} since a date, YYYY-MM-DD
 * @returns {Promise<{ pullRequests: object[], truncated: boolean }>}
 */
export async function githubOwnerPullRequests(g, owner, text, since) {
  const query = `query OikosOwnerPulls($q: String!) { search(query: $q, type: ISSUE, first: ${OWNER_SEARCH_LIMIT}) {
    issueCount nodes { ... on PullRequest { url title headRefName repository { nameWithOwner } } } } }`;
  const q = `is:pr user:${owner} updated:>=${since} sort:updated-desc "${String(text).replace(/"/g, '')}"`;
  const data = await g.graphql(query, { q });
  const pullRequests = (data.search?.nodes || []).filter((pr) => pr?.url).map((pr) => ({
    repo: `github:${pr.repository?.nameWithOwner}`, url: pr.url, title: pr.title, branch: pr.headRefName || null,
  }));
  return { pullRequests, truncated: (data.search?.issueCount || 0) > OWNER_SEARCH_LIMIT };
}

/**
 * The repositories of `owner` (a user or an organization) as `github:<owner>/<name>`, archived ones
 * left out, at most the first 1000. `truncated` when the owner has more.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} owner the user or organization login
 * @returns {Promise<{ repos: string[], truncated: boolean }>}
 */
export async function githubOwnerRepos(g, owner) {
  const query = `query OikosOwnerRepos($owner: String!, $after: String) { repositoryOwner(login: $owner) {
    repositories(first: 100, after: $after, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor } nodes { nameWithOwner isArchived } } } }`;
  const repos = [];
  let after = null;
  for (;;) {
    const data = await g.graphql(query, { owner, after });
    if (!data.repositoryOwner) throw new UsageError(`github:${owner}: no such user or organization, or no access`);
    const page = data.repositoryOwner.repositories;
    repos.push(...page.nodes.filter((r) => !r.isArchived).map((r) => `github:${r.nameWithOwner}`));
    if (!page.pageInfo.hasNextPage || repos.length >= OWNER_REPOS_LIMIT) return { repos: repos.slice(0, OWNER_REPOS_LIMIT), truncated: page.pageInfo.hasNextPage };
    after = page.pageInfo.endCursor;
  }
}

/**
 * The names recently used in `repo` (`owner/name`): the titles and branches of its last 100 pull
 * requests by update, and the names of its first 100 branches — what key aliases are looked for in.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} repo `owner/name`
 * @returns {Promise<{ pullRequests: {repo: string, title: string, branch: string|null}[], branches: string[] }>}
 */
export async function githubRecentNames(g, repo) {
  const [owner, name] = repo.split('/');
  const query = `query OikosRecentNames($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    pullRequests(first: ${RECENT_LIMIT}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { title headRefName } }
    refs(refPrefix: "refs/heads/", first: ${RECENT_LIMIT}) { nodes { name } } } }`;
  const data = await g.graphql(query, { owner, name });
  if (!data.repository) throw new UsageError(`github:${repo}: not found, or no access`);
  return {
    pullRequests: (data.repository.pullRequests?.nodes || []).map((pr) => ({ repo: `github:${repo}`, title: pr.title, branch: pr.headRefName || null })),
    branches: (data.repository.refs?.nodes || []).map((ref) => ref.name),
  };
}
