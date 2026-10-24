// Pull requests of a task (ADR 0001 D05): first what the task carries — PR/MR URLs in its text and
// links, and what the tracker's own integration reports (Jira dev-status) — then the project's
// repository pool (`projects.<KEY>.repos`) by the key and its aliases as a whole token; the extended
// set (`projects.<KEY>.extended_repos`, D08) the same way, only when the caller asks. In a
// repository whose bare numbers are the project's (`number_repos`, D11) the number written as a
// `number_patterns` template matches too; when nothing is found, the commits of the same
// repositories are searched the same way. Nothing else: no instance-wide search. A found PR the user
// names with `--skip-pr` (D12) is left out. Shared by the tracker connectors; the parsing, matching,
// merging and wording are pure, `collectPullRequests` reads the code hosts.
//
// A pull request record:
//   { url, repo: 'github:<owner>/<name>' | 'gitlab:<group>/<name>', number, title, branch,
//     state: open | draft | merged | closed | unknown, source: attached | pool | extended, note?,
//     viaCommit?: { sha, message } }
// `note` says why the state is unknown; `viaCommit` is the commit whose search found it (D11), absent
// when its title or branch carries the task itself. A branch without a pull request: { repo, branch }.
import { UsageError } from './cli.mjs';
import { HttpError, ChannelError } from './http.mjs';
import { githubClient, githubPullRequest, githubByText, githubCommitsByText, githubCommitPullRequests } from './github.mjs';
import { gitlabClient, gitlabMergeRequest, gitlabByText, gitlabCommitsByText, gitlabCommitMergeRequests } from './gitlab.mjs';
import { NUMBER } from './transitions.mjs';

/** Where a pull request was found: carried by the task, in the project's pool, or in its extended set (D08). */
export const SOURCES = Object.freeze(['attached', 'pool', 'extended']);

/** The sources whose pull requests the task does not carry: written into the move's comment. */
const FOUND_BY_SEARCH = Object.freeze(['pool', 'extended']);

/** The states a pull request record can have; `unknown` when its host could not be read. */
export const STATES = Object.freeze(['open', 'draft', 'merged', 'closed', 'unknown']);

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lower = (text) => String(text).toLowerCase();

/**
 * The keys a task goes by: its own key and the same number under each alias of its project
 * (`PROJ-123` with aliases `[PJ]` → `PROJ-123`, `PJ-123`), upper case, each once.
 *
 * @param {string} key a task key, e.g. PROJ-123
 * @param {string[]} [aliases] the project's `key_aliases`
 * @returns {string[]}
 */
export function taskKeys(key, aliases = []) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(String(key).trim());
  if (!m) throw new UsageError(`'${key}' is not a task key like PROJ-123`);
  const number = m[2];
  return [...new Set([m[1], ...aliases].map((prefix) => `${String(prefix).trim().toUpperCase()}-${number}`))];
}

/**
 * Whether `text` carries one of `keys` as a whole token, case-insensitively: not preceded by a
 * letter or digit, not followed by a digit or letter — `PROJ-123` is in `feature/proj-123-export`
 * and `[PROJ-123] Fix`, not in `PROJ-1234` or `XPROJ-123`.
 *
 * @param {string|null|undefined} text a title or a branch name
 * @param {string[]} keys from `taskKeys`
 * @returns {boolean}
 */
export function carriesKey(text, keys) {
  if (!text) return false;
  return keys.some((key) => new RegExp(`(?<![A-Za-z0-9])${escaped(key)}(?![A-Za-z0-9])`, 'i').test(text));
}

/**
 * The texts a bare task number is written as (D11): each of `patterns` with `{n}` replaced by the
 * number of `key` (`FIX[{n}]` and PROJ-123 → `FIX[123]`) — matched with `carriesKey`, as a key is.
 *
 * @param {string} key a task key, e.g. PROJ-123
 * @param {string[]} [patterns] the number templates in reach of the project
 * @returns {string[]}
 */
export function numberTokens(key, patterns = []) {
  const number = taskKeys(key)[0].split('-').pop();
  return [...new Set(patterns.map((pattern) => String(pattern).trim().split(NUMBER).join(number)))];
}

/**
 * A pull request URL as `{ host, server, path, number, url }` — GitHub `<server>/<owner>/<name>/pull/<n>`
 * or GitLab `<server>/<group>/<name>/-/merge_requests/<n>`, `url` without what follows the number —
 * or null when `url` is neither.
 *
 * @param {string} url
 * @returns {{ host: string, server: string, path: string, number: number, url: string } | null}
 */
export function parsePullRequestUrl(url) {
  const gitlab = /^(https?:\/\/[^/\s]+)\/([^\s?#]+?)\/-\/merge_requests\/(\d+)(?=[/?#]|$)/.exec(url);
  if (gitlab) {
    const [, server, path, n] = gitlab;
    return { host: 'gitlab', server, path, number: Number(n), url: `${server}/${path}/-/merge_requests/${n}` };
  }
  const github = /^(https?:\/\/[^/\s]+)\/([^/\s?#]+\/[^/\s?#]+)\/pull\/(\d+)(?=[/?#]|$)/.exec(url);
  if (github) {
    const [, server, path, n] = github;
    return { host: 'github', server, path, number: Number(n), url: `${server}/${path}/pull/${n}` };
  }
  return null;
}

/**
 * The repository and branch of a branch URL — GitHub `<server>/<owner>/<name>/tree/<branch>`,
 * GitLab `<server>/<group>/<name>/-/tree/<branch>` — or null.
 *
 * @param {string} url
 * @returns {{ repo: string, branch: string } | null}
 */
export function parseBranchUrl(url) {
  const gitlab = /^https?:\/\/[^/\s]+\/([^\s?#]+?)\/-\/tree\/([^?#\s]+)$/.exec(url);
  if (gitlab) return { repo: `gitlab:${gitlab[1]}`, branch: decodeURIComponent(gitlab[2]) };
  const github = /^https?:\/\/[^/\s]+\/([^/\s?#]+\/[^/\s?#]+)\/tree\/([^?#\s]+)$/.exec(url);
  if (github) return { repo: `github:${github[1]}`, branch: decodeURIComponent(github[2]) };
  return null;
}

/**
 * A pull request URL as URLs are compared — for de-duplication and `--skip-pr` (D12): its canonical
 * form when it parses (no `/files` tail, no query), without a trailing `/`, lower case.
 *
 * @param {string} url
 * @returns {string}
 */
export function pullRequestKey(url) {
  const text = lower(String(url).trim());
  return parsePullRequestUrl(text)?.url ?? text.replace(/\/+$/, '');
}

/** The pull request URLs among `urls`, canonical, each once. */
export function pullRequestUrls(urls) {
  const seen = new Map();
  for (const u of urls) {
    const parsed = parsePullRequestUrl(u);
    if (parsed && !seen.has(lower(parsed.url))) seen.set(lower(parsed.url), parsed);
  }
  return [...seen.values()];
}

/** The pool's repositories (`github:owner/name`, `gitlab:group/name`) as `{ id, host, path }`. */
export function poolRepos(repos = []) {
  return repos.map((id) => {
    const [host, ...rest] = String(id).trim().split(':');
    return { id: `${host}:${rest.join(':')}`, host, path: rest.join(':') };
  });
}

const sameRepo = (a, b) => lower(a) === lower(b);

/**
 * Pull request records merged and de-duplicated by URL (case-insensitive). An earlier record wins —
 * pass the attached ones first — and a later one only fills what the earlier lacks (a branch, a
 * title, a state that was unknown). `viaCommit` is never filled in: a pull request the search found by
 * its title or branch was not found only through a commit (D11).
 *
 * @param {object[][]} lists pull request records
 * @returns {object[]}
 */
export function mergePullRequests(...lists) {
  const byUrl = new Map();
  for (const pr of lists.flat()) {
    const key = pullRequestKey(pr.url);
    const had = byUrl.get(key);
    if (!had) {
      byUrl.set(key, { ...pr });
      continue;
    }
    for (const field of ['repo', 'number', 'title', 'branch']) if (had[field] == null && pr[field] != null) had[field] = pr[field];
    if (had.state === 'unknown' && pr.state && pr.state !== 'unknown') {
      had.state = pr.state;
      delete had.note;
    }
  }
  return [...byUrl.values()];
}

/**
 * The pull requests found by search less those `skip` names (`--skip-pr`, D12), URLs compared as
 * `pullRequestKey` compares them. `attached` are the URLs of `skip` that name a pull request the task
 * carries (never posted, so not skippable); `unmatched` those that name no pull request at all.
 *
 * @param {object[]} pullRequests pull request records
 * @param {string[]} [skip] the URLs given
 * @returns {{ kept: object[], skipped: object[], attached: string[], unmatched: string[] }}
 */
export function skipPullRequests(pullRequests, skip = []) {
  const wanted = new Map(skip.map((url) => [pullRequestKey(url), url]));
  const kept = [];
  const skipped = [];
  for (const pr of pullRequests) (wanted.has(pullRequestKey(pr.url)) && FOUND_BY_SEARCH.includes(pr.source) ? skipped : kept).push(pr);
  const found = new Set(skipped.map((pr) => pullRequestKey(pr.url)));
  const carried = new Set(pullRequests.filter((pr) => !FOUND_BY_SEARCH.includes(pr.source)).map((pr) => pullRequestKey(pr.url)));
  const attached = [...wanted].filter(([key]) => carried.has(key)).map(([, url]) => url);
  const unmatched = [...wanted].filter(([key]) => !found.has(key) && !carried.has(key)).map(([, url]) => url);
  return { kept, skipped, attached, unmatched };
}

/** `branches` without one that a pull request in `pullRequests` comes from, each once. */
export function branchesWithoutPullRequest(branches, pullRequests) {
  const covered = new Set(pullRequests.filter((pr) => pr.branch).map((pr) => lower(`${pr.repo} ${pr.branch}`)));
  const out = new Map();
  for (const b of branches) {
    const key = lower(`${b.repo} ${b.branch}`);
    if (!covered.has(key) && !out.has(key)) out.set(key, { repo: b.repo, branch: b.branch });
  }
  return [...out.values()];
}

/**
 * The repositories of `pullRequests` in none of `repos` (the pool, and the extended set when given),
 * each once.
 *
 * @param {object[]} pullRequests pull request records
 * @param {...string[]} repos the repository lists, `host:owner/name`
 * @returns {string[]}
 */
export function reposOutsidePool(pullRequests, ...repos) {
  const pool = poolRepos(repos.flat()).map((r) => r.id);
  const outside = new Map();
  for (const { repo } of pullRequests) {
    if (repo && !pool.some((id) => sameRepo(id, repo)) && !outside.has(lower(repo))) outside.set(lower(repo), repo);
  }
  return [...outside.values()];
}

// == reading the code hosts ==

/** Whether `error` is one a best-effort read reports and goes past: an HTTP answer, no channel, no credential or access. */
const reportable = (error) => error instanceof HttpError || error instanceof ChannelError || error instanceof UsageError;
const firstLine = (error) => String(error.message).split('\n')[0];

/**
 * The code-host clients for `tool` (its User-Agent name), each made once, when first asked for: a
 * missing credential raises then, and again on every later ask, without a second lookup.
 *
 * @param {string} tool
 * @returns {{ github: () => object, gitlab: () => object, limited: Map<string, number|null> }}
 */
export function codeHosts(tool) {
  const made = {};
  const once = (host, make) => () => {
    if (!made[host]) {
      try {
        made[host] = { client: make() };
      } catch (e) {
        made[host] = { error: e };
      }
    }
    if (made[host].error) throw made[host].error;
    return made[host].client;
  };
  // `limited` maps each quota (`quotaOf`) that answered a pull request or commit search with a rate limit —
  // not asked again in this run (D11) — to when it said to retry (ms since the epoch), null when it did not say.
  return { github: once('github', () => githubClient(tool)), gitlab: once('gitlab', () => gitlabClient(tool)), limited: new Map() };
}

const hostOf = (url) => lower(new URL(url).host);

/** The client that serves `server` for `host`, or an error saying why there is none. */
function clientFor(hosts, host, server) {
  const client = hosts[host]();
  const own = host === 'github' ? client.serverUrl : client.base;
  if (hostOf(own) !== hostOf(server)) throw new UsageError(`${hostOf(server)} is not the configured ${host === 'github' ? 'GitHub' : 'GitLab'} (${hostOf(own)})`);
  return client;
}

async function readAttached(parsed, hosts) {
  try {
    const client = clientFor(hosts, parsed.host, parsed.server);
    const read = parsed.host === 'github' ? githubPullRequest : gitlabMergeRequest;
    return { ...(await read(client, parsed.path, parsed.number)), url: parsed.url, source: 'attached' };
  } catch (e) {
    if (!reportable(e)) throw e;
    return {
      url: parsed.url, repo: `${parsed.host}:${parsed.path}`, number: parsed.number, title: null, branch: null,
      state: 'unknown', source: 'attached', note: firstLine(e),
    };
  }
}

/** `texts` are what the host is asked for, `tokens` what a title or a branch must carry as a whole token. */
async function searchPool(repo, { texts, tokens }, hosts) {
  if (repo.host === 'github') return githubByText(hosts.github(), repo.path, texts);
  if (repo.host === 'gitlab') return gitlabByText(hosts.gitlab(), repo.path, texts, { keep: (branch) => carriesKey(branch, tokens) });
  throw new UsageError(`${repo.id}: not a github or gitlab repository`);
}

/**
 * What a repository is searched for and matched by (D05, D11): the keys; in one of `numberRepos`
 * also the task's number, asked of the host as a bare search term, matched only as one of `numbers`
 * (the rendered patterns).
 */
function matchSet(repo, keys, { numberRepos, numbers, number }) {
  const numbered = numbers.length > 0 && numberRepos.some((id) => sameRepo(id, repo.id));
  return numbered ? { texts: [...keys, number], tokens: [...keys, ...numbers] } : { texts: keys, tokens: keys };
}

/**
 * Whether `error` is a host's answer that it limits the rate of requests: HTTP 429, a 403 naming a rate
 * limit, or a GitHub GraphQL answer whose errors are RATE_LIMITED (`graphqlError`).
 */
const rateLimited = (error) => error instanceof HttpError
  && (error.status === 429 || (error.status === 403 && /rate limit/i.test(String(error.body))) || Boolean(error.graphqlTypes?.includes('RATE_LIMITED')));
const shortSha = (sha) => String(sha).slice(0, 7);

const COMMITS_FOLLOWED = 20;
const SHAS_NAMED = 3;
const REPOS_NAMED = 3;

/** The first `cap` of `names`, comma-separated, then how many more: `a, b, c +2 more`. */
const namesCapped = (names, cap) => `${names.slice(0, cap).join(', ')}${names.length > cap ? ` +${names.length - cap} more` : ''}`;

/** Why a read failed, without its URL: the same for each commit an HTTP error repeats on. */
const reasonOf = (error) => (error instanceof HttpError ? `HTTP ${error.status}: ${String(error.body).slice(0, 300).split('\n')[0]}` : firstLine(error));

/**
 * `reason` with the commit `sha` in it — full or short — as `<sha>`: a 404 names the commit in its
 * path, so the same failure on several commits reads the same.
 */
const withoutSha = (reason, sha) => reason.replace(new RegExp(`(?<![0-9a-f])${escaped(shortSha(sha))}[0-9a-f]{0,33}(?![0-9a-f])`, 'gi'), '<sha>');

/**
 * The notes of the commits whose pull requests were not read, one per reason: a single commit's
 * names it and its error as read; several name their count, the reason, then the first three short
 * shas — the reason first, so a cut note keeps it.
 */
function unreadNotes(repo, unread) {
  const byReason = new Map();
  for (const { sha, error } of unread) {
    const reason = withoutSha(reasonOf(error), sha);
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push({ sha, error });
  }
  return [...byReason].map(([reason, failed]) => {
    if (failed.length === 1) return `${repo.id}: the pull requests of commit ${shortSha(failed[0].sha)} were not read — ${firstLine(failed[0].error)}`;
    const shas = namesCapped(failed.map((f) => shortSha(f.sha)), SHAS_NAMED);
    return `${repo.id}: the pull requests of ${failed.length} commits were not read — ${reason} (${shas})`;
  });
}

const SECONDS = /^\d+$/;
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** A whole number as a header gives it, or null when it is not one or too large to be exact. */
const wholeOf = (text) => (SECONDS.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null);

/** How long GitHub says to wait after a secondary rate limit that names no retry-after: at least a minute. */
const SECONDARY_WAIT_MS = 60_000;

/**
 * When a host that limits the rate of requests says to ask again, as a time (ms since the epoch): its
 * `retry-after` — seconds, or an HTTP date (IMF-fixdate); else, while GitHub's `x-ratelimit-remaining`
 * is above 0 — a secondary limit, the reset is the primary one's — a minute from now; else its
 * `x-ratelimit-reset`, or GitLab's `ratelimit-reset` (an epoch in seconds); null when it names none
 * in a form read here. Anything else counts as missing.
 */
function retryDeadline(error) {
  const header = (name) => String(error.headers?.get?.(name) ?? '').trim();
  const now = Date.now();
  const after = header('retry-after');
  if (wholeOf(after) !== null) return now + wholeOf(after) * 1000;
  if (HTTP_DATE.test(after) && !Number.isNaN(Date.parse(after))) return Date.parse(after);
  if (wholeOf(header('x-ratelimit-remaining')) > 0) return now + SECONDARY_WAIT_MS;
  const reset = wholeOf(header('x-ratelimit-reset')) ?? wholeOf(header('ratelimit-reset'));
  return reset === null ? null : reset * 1000;
}

/**
 * The end of a rate limit's note — `; retry after ~<N>s`, N the seconds left until `deadline`, rounded
 * up and at least 1 — or '' when the deadline is not known or too far to be exact.
 */
function retryAfter(deadline) {
  if (deadline === null || deadline === undefined) return '';
  const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  return Number.isSafeInteger(seconds) ? `; retry after ~${seconds}s` : '';
}

// What each search asks of a host, named as GitHub names its rate-limit resources: the pull request
// search is GitHub GraphQL; the commit search is GitHub REST search, then REST core for each commit's
// pull requests. GitLab has one quota for all of them.
const POOL_QUOTA = 'graphql';
const COMMIT_QUOTAS = ['search', 'core'];
const RESOURCES = new Set([POOL_QUOTA, ...COMMIT_QUOTAS]);

/**
 * The quota of `host` that a request of `kind` counts against: the host itself on GitLab; on GitHub
 * `github:<resource>` — the resource the rate limit `error` names in `x-ratelimit-resource` when it is
 * one of those searched here (graphql, search, core), else `kind`.
 */
function quotaOf(host, kind, error = null) {
  if (host !== 'github') return host;
  const named = String(error?.headers?.get?.('x-ratelimit-resource') ?? '').trim().toLowerCase();
  return `github:${RESOURCES.has(named) ? named : kind}`;
}

/**
 * The quota of `host` for `kinds` in `limited` that is clear last — a search that needs them all runs
 * only when each is: the latest deadline, or one with none known — or null when none is limited.
 */
function limitedQuota(host, kinds, limited) {
  const blocking = [...new Set(kinds.map((kind) => quotaOf(host, kind)))].filter((quota) => limited.has(quota));
  if (!blocking.length) return null;
  return blocking.find((quota) => limited.get(quota) === null) ?? blocking.reduce((last, quota) => (limited.get(quota) > limited.get(last) ? quota : last));
}

/**
 * Records in `limited` that `quota` answered with the rate limit `error` — the first limit of a quota
 * sets when to retry, a later one does not move it — and returns the end of its note (`retryAfter`).
 */
function limitQuota(limited, quota, error) {
  if (!limited.has(quota)) limited.set(quota, retryDeadline(error));
  return retryAfter(limited.get(quota));
}

/** Adds `repo` to `notAsked` — ids by host, with the limited `quota` the first of them met. */
function addNotAsked(notAsked, repo, quota) {
  if (!notAsked.has(repo.host)) notAsked.set(repo.host, { ids: [], quota });
  notAsked.get(repo.host).ids.push(repo.id);
}

/**
 * The notes of the repositories not asked because a quota of their host was limited earlier in this
 * run — `notAsked` (`addNotAsked`) — one per host, each ending with the time that quota has left
 * (`limited`): a single repository's names it; several name their host, their count and the first
 * three. `what` is what was not searched: 'commits' for the commit search, '' for the pull request search.
 */
function limitedEarlierNotes(notAsked, limited, what) {
  const searched = what ? `${what} not searched` : 'not searched';
  const several = (count) => (what ? `${what} of ${count} repositories` : `${count} repositories`);
  return [...notAsked].map(([host, { ids, quota }]) => {
    const earlier = `${host} limited the rate of requests earlier in this run`;
    const retry = retryAfter(limited.get(quota));
    return ids.length === 1 ? `${ids[0]}: ${searched} — ${earlier}${retry}`
      : `${host}: ${several(ids.length)} not searched — ${earlier} (${namesCapped(ids, REPOS_NAMED)})${retry}`;
  });
}

/**
 * The commits of one repository whose message carries a token, the pull requests they belong to —
 * each with `viaCommit`, the commit that led to it. A commit whose pull requests could not be read is
 * a note, and the next commit is followed. A rate limit stops the repository (`searchCommits`): `limit`
 * says where — `followed` 0 when no commit was followed, and nothing is kept; after, what was found is
 * kept — and `kind`, the quota it hit (`quotaOf`).
 */
async function repoCommits(repo, { texts, tokens }, hosts) {
  const client = repo.host === 'github' ? hosts.github() : hosts.gitlab();
  const search = repo.host === 'github' ? githubCommitsByText : gitlabCommitsByText;
  const pullsOf = repo.host === 'github' ? githubCommitPullRequests : gitlabCommitMergeRequests;
  const bySha = new Map();
  const truncated = [];
  const stopped = (error, kind) => ({ pullRequests: [], commits: [], truncated: [], notes: [], limit: { error, kind, followed: 0 } });
  for (const text of texts) {
    let result;
    try {
      result = await search(client, repo.path, text);
    } catch (error) {
      if (rateLimited(error)) return stopped(error, 'search');
      throw error;
    }
    if (result.truncated) truncated.push(`commits of ${repo.id} matching ${text}`);
    for (const commit of result.commits) if (carriesKey(commit.message, tokens) && !bySha.has(commit.sha)) bySha.set(commit.sha, commit);
  }
  const commits = [...bySha.values()];
  if (commits.length > COMMITS_FOLLOWED) truncated.push(`the pull requests of ${commits.length} commits of ${repo.id} (the first ${COMMITS_FOLLOWED} followed)`);
  const followed = commits.slice(0, COMMITS_FOLLOWED);
  const pullRequests = [];
  const alone = [];
  const unread = [];
  for (const [index, commit] of followed.entries()) {
    let own;
    try {
      own = await pullsOf(client, repo.path, commit.sha);
    } catch (error) {
      if (!reportable(error)) throw error;
      if (rateLimited(error)) {
        if (index === 0) return stopped(error, 'core');
        return { pullRequests, commits: alone, truncated, notes: unreadNotes(repo, unread), limit: { error, kind: 'core', followed: index, of: followed.length } };
      }
      // Neither a pull request nor a commit without one: what it belongs to is not known.
      unread.push({ sha: commit.sha, error });
      continue;
    }
    const viaCommit = { sha: commit.sha, message: commit.message };
    if (own.length) pullRequests.push(...own.map((pr) => ({ ...pr, viaCommit })));
    else alone.push({ repo: repo.id, sha: commit.sha, message: commit.message, url: commit.url });
  }
  return { pullRequests, commits: alone, truncated, notes: unreadNotes(repo, unread) };
}

/**
 * The commits of the searched repositories, one after another (D11): their pull requests as found by
 * search, and the commits without one. A host that answers with a rate limit is noted once and the
 * quota it hit not asked again in this run (`hosts.limited`, with when it said to retry); a repository it stopped after
 * some of its commits were followed keeps what they found and is noted as partly searched. The
 * repositories of a host so limited earlier share one note, after the others, with the time left.
 */
async function searchCommits(searched, keys, numbering, hosts, notes) {
  const limited = hosts.limited || new Map();
  const out = { pool: [], extended: [], commits: [] };
  const notAsked = new Map();
  for (const { repo, source } of searched) {
    const blocked = limitedQuota(repo.host, COMMIT_QUOTAS, limited);
    if (blocked) {
      addNotAsked(notAsked, repo, blocked);
      continue;
    }
    let result;
    try {
      result = await repoCommits(repo, matchSet(repo, keys, numbering), hosts);
    } catch (error) {
      if (!reportable(error)) throw error;
      notes.push(`${repo.id}: commits not searched — ${firstLine(error)}`);
      continue;
    }
    const stop = result.limit;
    const retry = stop ? limitQuota(limited, quotaOf(repo.host, stop.kind, stop.error), stop.error) : '';
    if (stop?.followed === 0) {
      notes.push(`${repo.id}: commits not searched — ${repo.host} limits the rate of requests (HTTP ${stop.error.status}); no more commit search there in this run${retry}`);
      continue;
    }
    out[source].push(...result.pullRequests.map((pr) => ({ ...pr, source })));
    out.commits.push(...result.commits.map((commit) => ({ ...commit, source })));
    for (const what of result.truncated) notes.push(`only the first page of ${what} was read`);
    notes.push(...result.notes);
    if (stop) notes.push(`${repo.id}: commits partly searched — ${repo.host} limits the rate of requests (HTTP ${stop.error.status}) after ${stop.followed} of ${stop.of} commits; no more commit search there in this run${retry}`);
  }
  notes.push(...limitedEarlierNotes(notAsked, limited, 'commits'));
  return out;
}

/**
 * The repositories of `listed` searched for pull requests and branches side by side (D05, D08), the
 * results — each `{ repo, source, result }`, `{ repo, source, error }` or `{ repo, source, skipped }` —
 * in the list's order. Those whose pull request quota (`quotaOf`) is in `limited`, limited earlier in
 * the run, are not asked but skipped: `notAsked` holds them (`addNotAsked`).
 */
async function searchRepos(listed, keys, numbering, hosts, limited) {
  const notAsked = new Map();
  const searched = await Promise.all(listed.map(({ repo, source }) => {
    const quota = quotaOf(repo.host, POOL_QUOTA);
    if (limited.has(quota)) {
      addNotAsked(notAsked, repo, quota);
      return { repo, source, skipped: true };
    }
    return searchPool(repo, matchSet(repo, keys, numbering), hosts).then(
      (result) => ({ repo, source, result }),
      (error) => {
        if (!reportable(error)) throw error;
        return { repo, source, error };
      });
  }));
  return { searched, notAsked };
}

/**
 * The repositories of `searched` (`searchRepos`) the commit search asks: those whose pull requests were
 * searched, and those stopped only by a rate limit while their host's commit quotas are not in `limited`
 * — on GitHub the commit search counts against other quotas than the pull request search.
 */
const commitCandidates = (searched, limited) => searched.filter((s) => s.result
  || ((s.skipped || rateLimited(s.error)) && !limitedQuota(s.repo.host, COMMIT_QUOTAS, limited)));

/**
 * The pull requests of a task and its branches without one (D05). Attached: the PR/MR URLs among
 * `urls` (its description, comments and links), each read from its host, then `known` — what the
 * tracker's integration reported (dev-status), kept where the host could not be read. Pool: each
 * repository in `repos`, its pull requests and branches whose title or branch name carries the key
 * or an alias key as a whole token. Extended: each repository in `extended`, searched the same way —
 * the caller passes it only when the user asked (D08). In a repository of `numberRepos` a title or
 * branch also matches by the task's number written as one of `patterns` (D11); elsewhere a bare
 * number never does. With `commits`, when no pull request at all was found, the commits of the
 * searched repositories are searched the same way (D11): a commit's pull request counts as found by
 * search and carries `viaCommit` — the first commit that led to it — unless the pull request search
 * found it too; a commit without one is returned in `commits`; a commit whose pull requests could not
 * be read is a note. The pull requests found by search that
 * `skip` names (`--skip-pr`, D12) are taken out into `skipped` before that decision, so a task whose
 * only found pull request is skipped still gets the commit search; `skip` in the result says which of
 * its URLs named an attached pull request or none at all (`skipPullRequests`). A host that answers
 * the pool, extended or commit search with a rate limit has the quota it hit (`quotaOf`) recorded in
 * `hosts.limited`, and what counts against that quota is not asked again in this run — across the
 * tasks of a batch that pass the same `hosts`; a repository stopped only by its pull request quota is
 * still searched for commits. Every read is best
 * effort: what failed is said in `notes`; `hits` counts per searched set the pull requests, branches
 * and commits that carry a key or a pattern, before they are merged with the attached ones and
 * without the skipped ones, so a set whose only hit was skipped counts as having found nothing.
 *
 * @param {string} key the task key, e.g. PROJ-123
 * @param {object} options
 * @param {string[]} [options.urls] the URLs the task carries
 * @param {object[]} [options.known] pull request records the tracker reported (source attached)
 * @param {{repo: string, branch: string}[]} [options.knownBranches] branches the tracker reported
 * @param {string[]} [options.aliases] the project's `key_aliases`
 * @param {string[]} [options.repos] the project's pool, `host:owner/name`
 * @param {string[]} [options.extended] the project's extended set, `host:owner/name`; empty unless asked for
 * @param {string[]} [options.numberRepos] the project's `number_repos` (D11)
 * @param {string[]} [options.patterns] the number templates in reach of the project (`numberPatterns`)
 * @param {boolean} [options.commits] whether to search commits when no pull request was found
 * @param {string[]} [options.skip] the `--skip-pr` URLs (D12)
 * @param {{ github: () => object, gitlab: () => object, limited?: Map<string, number|null> }} options.hosts from `codeHosts`
 * @returns {Promise<{ keys: string[], pullRequests: object[], skipped: object[], skip: { attached: string[], unmatched: string[] },
 *   branches: {repo: string, branch: string}[], commits: {repo: string, sha: string, message: string, url: string|null, source: string}[],
 *   notes: string[], hits: { pool: number, extended: number } }>}
 */
export async function collectPullRequests(key, {
  urls = [], known = [], knownBranches = [], aliases = [], repos = [], extended = [], numberRepos = [], patterns = [], commits = false, skip = [], hosts,
}) {
  const keys = taskKeys(key, aliases);
  const numbering = { numberRepos, numbers: numberTokens(key, patterns), number: keys[0].split('-').pop() };
  const notes = [];
  const attached = [];
  for (const parsed of pullRequestUrls([...urls, ...known.map((pr) => pr.url)])) attached.push(await readAttached(parsed, hosts));
  const reported = known.map((pr) => ({ ...pr, source: 'attached' }));
  const found = { pool: [], extended: [] };
  const hits = { pool: 0, extended: 0 };
  const branches = [...knownBranches];
  // One record of the hosts that limited the rate of requests, shared by the pull request and the commit search.
  const limited = hosts.limited || new Map();
  const run = hosts.limited ? hosts : { ...hosts, limited };
  const listed = [...poolRepos(repos).map((repo) => ({ repo, source: 'pool' })), ...poolRepos(extended).map((repo) => ({ repo, source: 'extended' }))];
  const { searched, notAsked } = await searchRepos(listed, keys, numbering, hosts, limited);
  for (const { repo, source, result, error, skipped } of searched) {
    if (skipped) continue;
    if (error) {
      // A rate limit marks its quota for the rest of the run — on GitLab the commit search below too.
      const retry = rateLimited(error) ? limitQuota(limited, quotaOf(repo.host, POOL_QUOTA, error), error) : '';
      notes.push(`${repo.id}: not searched — ${firstLine(error)}${retry}`);
      continue;
    }
    const { tokens } = matchSet(repo, keys, numbering);
    const carried = result.pullRequests.filter((pr) => carriesKey(pr.title, tokens) || carriesKey(pr.branch, tokens));
    const carriedBranches = result.branches.filter((b) => carriesKey(b.branch, tokens));
    found[source].push(...carried.map((pr) => ({ ...pr, source })));
    branches.push(...carriedBranches);
    hits[source] += carriedBranches.length;
    for (const what of result.truncated) notes.push(`only the first page of ${what} was read`);
  }
  notes.push(...limitedEarlierNotes(notAsked, limited, ''));
  let all = mergePullRequests(attached, reported, found.pool, found.extended);
  // The skipped pull requests are left out before the commit search is decided on (D11, D12).
  let { kept: pullRequests, skipped } = skipPullRequests(all, skip);
  let alone = [];
  const byCommit = { pool: [], extended: [] };
  if (commits && !pullRequests.length) {
    const result = await searchCommits(commitCandidates(searched, limited), keys, numbering, run, notes);
    for (const source of ['pool', 'extended']) {
      byCommit[source] = result[source];
      hits[source] += result.commits.filter((c) => c.source === source).length;
    }
    const fromCommits = mergePullRequests(result.pool, result.extended);
    all = mergePullRequests(all, fromCommits);
    const left = skipPullRequests(fromCommits, skip);
    pullRequests = left.kept;
    skipped = mergePullRequests(skipped, left.skipped);
    alone = result.commits;
  }
  // A skipped pull request is no hit: the set that found only it found nothing (D08, D12).
  const skippedKeys = new Set(skipped.map((pr) => pullRequestKey(pr.url)));
  const counted = (prs) => prs.filter((pr) => !skippedKeys.has(pullRequestKey(pr.url))).length;
  for (const source of ['pool', 'extended']) hits[source] += counted(found[source]) + counted(byCommit[source]);
  const { attached: skipAttached, unmatched } = skipPullRequests(all, skip);
  return {
    keys, pullRequests, skipped, skip: { attached: skipAttached, unmatched },
    branches: branchesWithoutPullRequest(branches, [...pullRequests, ...skipped]), commits: alone, notes, hits,
  };
}

// == wording ==

const label = (pr) => `${String(pr.repo || '').replace(/^[a-z]+:/, '')}${pr.repo?.startsWith('gitlab:') ? '!' : '#'}${pr.number ?? '?'}`;
/** The first line of a commit message that is not blank. */
const messageLine = (message) => (String(message).split('\n').find((l) => l.trim()) || '').trim();
/** A commit as the dry run names it: `host:owner/name@<short sha> <first line of its message>`. */
const commitLabel = (c) => `${c.repo}@${shortSha(c.sha)} ${messageLine(c.message)}`;

/**
 * The pull requests the task does not carry yet — found in the pool or the extended set — which the
 * move's comment adds.
 *
 * @param {object[]} pullRequests pull request records
 * @returns {object[]}
 */
export const foundBySearch = (pullRequests) => pullRequests.filter((pr) => FOUND_BY_SEARCH.includes(pr.source));

/** The one line about an extended set that was not searched while the pool found nothing, or null (D08). */
function extendedHint(found, { projectKey, extended = [], searchedExtended = false, extendedCommand }) {
  if (searchedExtended || !extended.length || found.hits?.pool) return null;
  return `Nothing found in the pool; the extended set of ${projectKey} has ${extended.length} repositor${extended.length === 1 ? 'y' : 'ies'}, searched only on request: ${extendedCommand}`;
}

const BRIEF_PULL_REQUESTS = 5;
const BRIEF_TITLE = 60;
const BRIEF_NOTES = 3;
const BRIEF_NOTE = 120;
const cut = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);
const RETRY_AFTER = /; retry after ~\d+s$/;
/**
 * A note of the brief `Notes:` line, cut to BRIEF_NOTE; a `; retry after ~<N>s` end is kept whole and
 * the text before it is cut instead, since the batch dry run is where it is read.
 */
const cutNote = (note) => {
  const retry = RETRY_AFTER.exec(note)?.[0];
  if (!retry || note.length <= BRIEF_NOTE) return cut(note, BRIEF_NOTE);
  return `${cut(note.slice(0, -retry.length), BRIEF_NOTE - retry.length)}${retry}`;
};
/**
 * What follows a pull request found through a commit (D11) — ` — via commit <short sha> <first line>`,
 * the line cut to `limit` when given — so a title that names another task is explained; '' otherwise.
 */
const viaText = (pr, limit) => {
  if (!pr.viaCommit) return '';
  const line = messageLine(pr.viaCommit.message);
  return ` — via commit ${shortSha(pr.viaCommit.sha)} ${limit ? cut(line, limit) : line}`.trimEnd();
};

/**
 * Whether a note says a search did not run or stopped part way — no credential, an HTTP error, a
 * host's rate limit now or earlier in the run: each such note says "not searched" or "partly
 * searched".
 */
const searchStopped = (note) => /\b(?:not|partly) searched\b/.test(note);

/** Whether a note says the pull requests of some commits were not read (an HTTP error on them). */
const commitsUnread = (note) => /\bthe pull requests of (?:commit \S+|\d+ commits) were not read\b/.test(note);

/**
 * Whether a note is a gap in the search (D13): a search that stopped, or commits whose pull requests
 * were not read. The other notes — only a first page read, dev-status unavailable — only inform.
 */
const searchGap = (note) => searchStopped(note) || commitsUnread(note);

/** A note of a host's rate limit: said in words, or a search not done on an HTTP 429 or a 403 naming a rate limit. */
const RATE_LIMIT_NOTE = /limit(?:s|ed) the rate of requests|\bnot searched — HTTP (?:429\b|403\b.*rate limit)/i;

/**
 * How early a note is shown in the brief `Notes:` line: a host's rate limit first, then the other
 * searches that stopped, then the commits whose pull requests were not read, then the notes that
 * only inform (a first page only, dev-status unavailable).
 */
const noteRank = (note) => (RATE_LIMIT_NOTE.test(note) ? 0 : searchStopped(note) ? 1 : commitsUnread(note) ? 2 : 3);

/**
 * The notes saying a part of the pull request search was not done — a repository not searched, only
 * a first page read, a source unavailable: `found.incomplete` when the caller set it apart from
 * notes that only inform, else every note of `collectPullRequests` (each says what was not done).
 *
 * @param {{ notes?: string[], incomplete?: string[] }} found
 * @returns {string[]}
 */
export const incompleteNotes = (found) => found.incomplete ?? found.notes ?? [];

/**
 * Whether the pull request search was incomplete: some search did not run or stopped part way (no
 * credential, an HTTP error, a rate limit), or the pull requests of some commits were not read. Only
 * a first page read or dev-status unavailable is a note, not a gap (D13).
 *
 * @param {{ notes?: string[], incomplete?: string[] }} found
 * @returns {boolean}
 */
export const searchIncomplete = (found) => incompleteNotes(found).some(searchGap);

/**
 * The notes of `found` that make the search incomplete (`searchIncomplete`), in the order the brief
 * `Notes:` line shows them: a rate limit first, then a stopped search, then unread commits.
 *
 * @param {{ notes?: string[], incomplete?: string[] }} found
 * @returns {string[]}
 */
export const searchGaps = (found) => incompleteNotes(found).filter(searchGap).sort((a, b) => noteRank(a) - noteRank(b));

/**
 * The pull request lines of a brief dry run: `PRs: none`, or `PRs:` and one line each —
 * `owner/name#N <state> [<source>] <title cut to 60>`, at most five, then how many more — the
 * hint about an unsearched extended set when `pullRequestLines` would print it, the skipped pull
 * requests, the commits without one, and one `Notes:` line with what the search could not do
 * (`incompleteNotes`, three of them cut to 120 — a search that did not run before a note that only
 * informs — then
 * how many more).
 *
 * @param {{ pullRequests: object[], hits?: object, notes?: string[], incomplete?: string[] }} found from `collectPullRequests`
 * @param {object} options as `pullRequestLines` takes them (projectKey, extended, searchedExtended, extendedCommand)
 * @returns {string[]}
 */
export function briefPullRequestLines(found, options) {
  const prs = found.pullRequests;
  const lines = prs.slice(0, BRIEF_PULL_REQUESTS).map((pr) => `  ${label(pr)} ${pr.state} [${pr.source}] ${cut(pr.title || '(title not read)', BRIEF_TITLE)}${viaText(pr, BRIEF_TITLE)}`);
  if (prs.length > BRIEF_PULL_REQUESTS) lines.push(`  … ${prs.length - BRIEF_PULL_REQUESTS} more`);
  const hint = extendedHint(found, options);
  const skipped = (found.skipped || []).map((pr) => `${label(pr)} ${cut(pr.title || '(title not read)', BRIEF_TITLE)}${viaText(pr, BRIEF_TITLE)}`);
  const commits = (found.commits || []).slice(0, BRIEF_PULL_REQUESTS).map((c) => `  ${cut(commitLabel(c), BRIEF_TITLE + 40)}`);
  if ((found.commits || []).length > BRIEF_PULL_REQUESTS) commits.push(`  … ${found.commits.length - BRIEF_PULL_REQUESTS} more`);
  // A host's rate limit is among the notes, so it has no line of its own.
  // The sort is stable: within a rank the notes keep the order they were collected in.
  const notes = [...incompleteNotes(found)].sort((a, b) => noteRank(a) - noteRank(b));
  const more = notes.length > BRIEF_NOTES ? ` (+${notes.length - BRIEF_NOTES} more)` : '';
  const noted = notes.length ? [`Notes: ${notes.slice(0, BRIEF_NOTES).map(cutNote).join('; ')}${more}`] : [];
  return [prs.length ? 'PRs:' : 'PRs: none', ...lines, ...(hint ? [`  ${hint}`] : []),
    ...(skipped.length ? [`Skipped (--skip-pr): ${skipped.join('; ')}`] : []), ...(commits.length ? ['Commits:', ...commits] : []), ...noted];
}

/**
 * The lines of a `## Pull requests` section: each pull request (state, source, repository, title,
 * URL), the branches without one, the notes, and what to do about an empty pool or an attached
 * repository outside it. About the extended set (D08): when it was searched and is empty, a note;
 * when it was not searched, the pool found nothing and the set is not empty, one line naming its size
 * and `extendedCommand` — the same command with `--extended`.
 *
 * @param {{ pullRequests: object[], branches: object[], notes: string[] }} found from `collectPullRequests`
 * @param {object} options
 * @param {string} options.projectKey the task's project, e.g. PROJ
 * @param {string[]} [options.repos] the project's pool
 * @param {string[]} [options.extended] the project's extended set
 * @param {boolean} [options.searchedExtended] whether the extended set was searched (`--extended`)
 * @param {string} [options.extendedCommand] the command that searches it, for the hint
 * @param {string} options.configPath where the project sits in oikos.yaml, e.g. `task-tracking.jira.projects`
 * @param {string} options.tool the tracker tool's command, e.g. `node oikos/tools/jira/cli.mjs`
 * @returns {string[]}
 */
export function pullRequestLines(found, { projectKey, repos = [], extended = [], searchedExtended = false, extendedCommand, configPath, tool }) {
  const out = ['## Pull requests'];
  const record = (pr) => [`  ${pr.state.padEnd(7)} ${pr.source.padEnd(8)} ${pr.repo || '?'}  ${pr.title || '(title not read)'}${viaText(pr)}`,
    `          ${pr.url}${pr.branch ? `  (branch ${pr.branch})` : ''}${pr.note ? `\n          state not read: ${pr.note}` : ''}`];
  if (!found.pullRequests.length) out.push('  (none found)');
  for (const pr of found.pullRequests) out.push(...record(pr));
  if (found.skipped?.length) {
    out.push('Skipped (--skip-pr) — not the task\'s result, left out of the comment:', ...found.skipped.flatMap(record));
  }
  if (found.branches.length) {
    out.push('Branches without a pull request:', ...found.branches.map((b) => `  ${b.repo}  ${b.branch}`));
  }
  if (found.commits?.length) {
    out.push('Commits without a pull request (evidence, not posted):', ...found.commits.map((c) => `  ${commitLabel(c)}`));
  }
  if (!repos.length) {
    out.push(`The repository pool of ${projectKey} is empty (${configPath}.${projectKey}.repos): only the pull requests the task`,
      '  carries were looked for — no search across the whole code host. Set the pool up with',
      `  \`${tool} project-init ${projectKey} --dry-run\`, or list the repositories there in oikos.yaml.`);
  }
  if (searchedExtended && !extended.length) {
    out.push(`--extended: the extended set of ${projectKey} is empty (${configPath}.${projectKey}.extended_repos) — nothing more was searched.`);
  }
  const hint = extendedHint(found, { projectKey, extended, searchedExtended, extendedCommand });
  if (hint) out.push(hint);
  for (const repo of reposOutsidePool(found.pullRequests.filter((pr) => pr.source === 'attached'), repos, extended)) {
    out.push(`${repo} carries a pull request of this task and is not in the pool of ${projectKey} — add it:`,
      `  ${tool} repos add ${projectKey} ${repo} --dry-run`);
  }
  if (found.notes.length) out.push('Notes:', ...found.notes.map((n) => `  ${n}`));
  return out;
}

/**
 * The comment posted with a move: `comment` (markdown), then the pull requests found in the pool or
 * the extended set that the task does not carry yet (D05, D08), as a list of links — one found through
 * a commit names that commit (D11); null when there is neither.
 *
 * @param {string|null|undefined} comment the comment the user gave
 * @param {object[]} pullRequests pull request records
 * @returns {string|null}
 */
export function moveComment(comment, pullRequests) {
  const fromPool = foundBySearch(pullRequests);
  const text = comment ? String(comment).trim() : '';
  if (!fromPool.length) return text || null;
  const list = fromPool.map((pr) => `- [${label(pr)}](${pr.url}) — ${pr.title || '(no title)'} (${pr.state})${viaText(pr)}`);
  return [...(text ? [text, ''] : []), 'Pull requests of this task found in the project\'s repositories:', ...list].join('\n');
}
