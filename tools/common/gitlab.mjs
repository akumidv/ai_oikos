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
    try {
      return await request(`${base}/api/v4${path}`, { tool, headers: { 'PRIVATE-TOKEN': token }, ...opts });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new UsageError(`GitLab rejected the token (401)\n${helpText()}`);
      if (e instanceof HttpError && e.status === 404) throw new UsageError(`not found, or no access (GitLab answers 404 for both): ${path}`);
      throw e;
    }
  };
  const get = async (path) => (await api(path)).data;
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
