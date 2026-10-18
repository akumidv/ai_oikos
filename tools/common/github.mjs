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
 * anything else → HttpError with the joined messages.
 */
export function graphqlError(errors, { status = 200, url } = {}) {
  const messages = errors.map((e) => e.message).join('; ');
  const types = errors.map((e) => e.type);
  if (types.includes('NOT_FOUND')) return new UsageError(`not found, or no access: ${messages}`);
  const refused = types.find((t) => t === 'FORBIDDEN' || t === 'INSUFFICIENT_SCOPES');
  if (refused) return new UsageError(`GitHub refused the request (${refused}): ${messages}`);
  return new HttpError(status, url, messages);
}

/**
 * A GitHub client for `tool` (its User-Agent name): { api, paged, graphql, route, apiUrl,
 * serverUrl }. The credential is looked up at once, so a missing one fails before any request;
 * `help` goes to `githubToken`.
 */
export function githubClient(tool, { help } = {}) {
  const t = githubToken(help ? { help } : {});
  const { apiUrl, serverUrl, graphqlUrl } = githubEndpoints(envValue('GITHUB_API_URL'), envValue('GITHUB_SERVER_URL'));
  const api = async (path, opts = {}) => {
    try {
      const { headers = {}, ...rest } = opts;
      return await request(path.startsWith('http') ? path : `${apiUrl}${path}`, {
        tool,
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
    let url = `${apiUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (url && rows.length < limit) {
      const r = await api(url);
      rows.push(...r.data);
      url = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return rows.slice(0, limit);
  };
  /** One GraphQL call: its `data`, or the mapped error of its `errors`. */
  const graphql = async (query, variables = {}) => {
    const r = await api(graphqlUrl, { method: 'POST', body: { query, variables } });
    if (r.data.errors?.length) throw graphqlError(r.data.errors, { status: r.status, url: graphqlUrl });
    return r.data.data;
  };
  return { api, paged, graphql, route: t.route, apiUrl, serverUrl };
}
