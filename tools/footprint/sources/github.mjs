// The github source: a person's pull-request work — pull requests they opened (and of them those
// merged since) with their lines, those they merged, their reviews by state and the volume of
// others' pull requests they reviewed or merged, their comments and their commits on those pull
// requests (every one: a longer list is read page by page) — each an event at its instant with its
// kind (pr opened, review, review comment, comment, merge, commit), so --tz decides the day; issues
// opened counted. With GITHUB_ORG the
// organization's repositories are listed (REST, the `repo` scope; no `read:org`) and each active
// one's pull requests are read newest-updated first: complete for what the token can read. Without
// it, GitHub's search across the whole of GitHub is the only route, and its results are incomplete
// at times: a lower bound. Commits pushed without a pull request are the git source's.
import { UsageError } from '../../common/cli.mjs';
import { ChannelError, HttpError } from '../../common/http.mjs';
import { addDays } from '../report.mjs';
import { inWorkingPeriod, periodBounds, workingDate } from './period.mjs';

const DAY_MS = 86_400_000;
/**
 * The reviews of the person, the comments and the commits read with each pull request; the rest of
 * a longer list is read after it, page by page (`connectionRest`).
 */
const REVIEWS_PER_PULL = 20;
const COMMENTS_PER_PULL = 50;
const COMMITS_PER_PULL = 100;
/**
 * Pull requests per page. A page asks for at most PAGE_SIZE × (1 + REVIEWS_PER_PULL +
 * COMMENTS_PER_PULL + COMMITS_PER_PULL) = 4 275 nodes in GitHub's count (connections only) — far
 * below its 500 000, but the nested commits make a page slow: a large page times out at GitHub's
 * gateway (502/504), so pages start small and shrink when they fail.
 */
const PAGE_SIZE = 25;
/** Nodes per page when the rest of a pull request's reviews, comments or commits is read. */
const CONNECTION_PAGE_SIZE = 100;
/** The smallest page tried before the source gives up. */
const MIN_PAGE_SIZE = 3;
const RETRY_PAUSE_MS = 500;
/** The wait after a rate limit that names no retry-after. */
const RATE_LIMIT_PAUSE_MS = 60_000;
/** The organization's repositories read at most. */
const REPO_CAP = 2000;
/** Repositories probed in one query: their latest-updated pull request and the person's issues. */
const PROBE_BATCH = 25;
/** The person's issues read per repository in the probe. */
const ISSUES_PER_REPO = 100;
/** GitHub search returns at most this many results for one query, whatever its issueCount says. */
const SEARCH_CAP = 1000;
/** Monthly windows of `updated:` at most (search route): from the day before the period on. */
const MAX_WINDOWS = 36;

/**
 * The connections of a pull request read beyond their first page: the query's name, its arguments
 * and variables beyond `$id`, `$first` and `$after`, and the fields of a node.
 */
const CONNECTIONS = {
  reviews: { name: 'OikosFootprintMoreReviews', args: ', author: $login', variables: ', $login: String!', nodes: 'submittedAt state' },
  comments: { name: 'OikosFootprintMoreComments', args: '', variables: '', nodes: 'createdAt author { login }' },
  commits: { name: 'OikosFootprintMoreCommits', args: '', variables: '', nodes: 'commit { oid authoredDate author { user { login } } }' },
};
const FIRST = { reviews: REVIEWS_PER_PULL, comments: COMMENTS_PER_PULL, commits: COMMITS_PER_PULL };

const connectionField = (key, first) => `${key}(first: ${first}${CONNECTIONS[key].args}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${CONNECTIONS[key].nodes} } }`;

const PULL_FIELDS = `fragment PullFields on PullRequest { id number url updatedAt createdAt merged mergedAt additions deletions
  repository { nameWithOwner } author { login } mergedBy { login }
  ${Object.keys(CONNECTIONS).map((key) => connectionField(key, FIRST[key])).join('\n  ')} }`;

/** The query of the next page of one connection of a pull request, by its node id. */
const connectionQuery = (key) => {
  const c = CONNECTIONS[key];
  return `query ${c.name}($id: ID!, $first: Int!, $after: String${c.variables}) { node(id: $id) { ... on PullRequest {
    ${key}(first: $first, after: $after${c.args}) { pageInfo { hasNextPage endCursor } nodes { ${c.nodes} } } } } }`;
};

const REPO_PULLS_QUERY = `query OikosFootprintRepoPulls($owner: String!, $name: String!, $login: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequests(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
    pageInfo { hasNextPage endCursor } nodes { ...PullFields } } } } ${PULL_FIELDS}`;

const SEARCH_PULLS_QUERY = `query OikosFootprintPulls($q: String!, $login: String!, $first: Int!, $after: String) {
  search(type: ISSUE, query: $q, first: $first, after: $after) { issueCount pageInfo { hasNextPage endCursor }
    nodes { ...PullFields } } } ${PULL_FIELDS}`;

const ISSUES_QUERY = 'query OikosFootprintIssues($q: String!) { search(type: ISSUE, query: $q, first: 1) { issueCount } }';

/**
 * The probe of `count` repositories of one owner (variables $n0 … $n<count-1>): each one's latest
 * updated pull request — whether it has any to read — and the issues the person created, updated since.
 */
function probeQuery(count) {
  const names = Array.from({ length: count }, (_, i) => `$n${i}: String!`).join(', ');
  const repos = Array.from({ length: count }, (_, i) => `r${i}: repository(owner: $owner, name: $n${i}) { ...Probe }`).join(' ');
  return `query OikosFootprintProbe($owner: String!, $login: String!, $since: DateTime!, ${names}) { ${repos} }
    fragment Probe on Repository { pullRequests(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { updatedAt } }
      issues(first: ${ISSUES_PER_REPO}, orderBy: { field: CREATED_AT, direction: DESC }, filterBy: { createdBy: $login, since: $since }) {
        totalCount nodes { createdAt } } }`;
}

const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * Whether a failed page may succeed smaller: a gateway error or timeout (the query took too long),
 * or a 200 that carried no data (common/github.mjs raises it as an HttpError of status 200).
 */
const overloaded = (e) => (e instanceof HttpError && [200, 502, 503, 504].includes(e.status) && !rateLimited(e))
  || (e instanceof ChannelError && e.cause?.name === 'TimeoutError');

/** A primary or secondary rate limit: a 403 or 429, or a GraphQL RATE_LIMITED error (status 200). */
function rateLimited(e) {
  return e instanceof HttpError && [200, 403, 429].includes(e.status) && /rate limit/i.test(String(e.body));
}

/**
 * One GraphQL call. A rate limit is waited out once — its retry-after, else `run.rateLimitPauseMs`
 * — and a second one in a row gives up with a usage error.
 */
async function call(g, query, variables, run) {
  try {
    return await g.graphql(query, variables);
  } catch (e) {
    if (!rateLimited(e)) throw e;
    const retryAfter = e.headers?.get('retry-after');
    const wait = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : run.rateLimitPauseMs;
    await pause(wait);
    run.limited.push(wait);
    try {
      return await g.graphql(query, variables);
    } catch (again) {
      if (!rateLimited(again)) throw again;
      throw new UsageError(`GitHub's rate limit held after a wait of ${Math.round(wait / 1000)} s: run it again later (${String(again.body).slice(0, 160)})`);
    }
  }
}

/**
 * One page of `query` with `paging.size` as `$first` (`run.paging`, pull requests, by default). A
 * page that fails as `overloaded` is asked again from the same cursor with half as many (25 → 12 →
 * 6 → 3), and the size that worked stays for the pages after it; below MIN_PAGE_SIZE the error
 * names `what`.
 */
async function shrinkingPage(g, query, variables, run, what, { paging = run.paging, unit = 'pull requests' } = {}) {
  for (;;) {
    try {
      return await call(g, query, { ...variables, first: paging.size }, run);
    } catch (e) {
      if (!overloaded(e)) throw e;
      const smaller = Math.floor(paging.size / 2);
      if (smaller < MIN_PAGE_SIZE) {
        const failed = `${what} still failed at ${paging.size} ${unit} per page`;
        throw e instanceof HttpError ? new HttpError(e.status, e.url, `${failed}: ${e.body}`) : new ChannelError(`${failed}: ${e.message}`, { cause: e });
      }
      paging.size = smaller;
      await pause(run.pauseMs);
    }
  }
}

/**
 * `pr` with every node of its connection `key` (reviews, comments, commits): the pages after the
 * first read by the pull request's node id, with the same shrinking and rate-limit handling. A
 * pull request without an id, or a page that comes back empty, keeps what was read and is counted
 * in `run.cut[key]`.
 */
async function connectionRest(g, pr, key, login, run) {
  const first = pr[key];
  let info = first?.pageInfo;
  if (!info?.hasNextPage) return pr;
  const nodes = [...first.nodes];
  const variables = key === 'reviews' ? { id: pr.id, login } : { id: pr.id };
  while (info?.hasNextPage && info.endCursor && pr.id) {
    const data = await shrinkingPage(g, connectionQuery(key), { ...variables, after: info.endCursor }, run,
      `GitHub ${key} of ${pr.url}`, { paging: run.connectionPaging, unit: key });
    const page = data.node?.[key];
    if (!page?.nodes?.length) break;
    nodes.push(...page.nodes);
    info = page.pageInfo;
  }
  if (info?.hasNextPage) run.cut[key] = (run.cut[key] || 0) + 1;
  run.paged[key] = (run.paged[key] || 0) + 1;
  return { ...pr, [key]: { ...first, nodes, pageInfo: info } };
}

/** `pr` with every review of the person, every comment and every commit (`connectionRest`). */
async function wholePull(g, pr, login, run) {
  let whole = pr;
  for (const key of Object.keys(CONNECTIONS)) whole = await connectionRest(g, whole, key, login, run);
  return whole;
}

// == the organization route: its repositories, each one's pull requests newest-updated first ==

/**
 * The probe of `names`: [{ name, active, issues: [createdAt], issuesCut }] — `active` when the
 * repository has a pull request updated since `since`. A batch that fails as `overloaded` is split
 * in halves; a single repository that still fails gives up naming it.
 */
async function probe(g, org, names, { login, since }, run) {
  const variables = { owner: org, login, since, ...Object.fromEntries(names.map((n, i) => [`n${i}`, n])) };
  let data;
  try {
    data = await call(g, probeQuery(names.length), variables, run);
  } catch (e) {
    if (!overloaded(e)) throw e;
    if (names.length === 1) throw e instanceof HttpError ? new HttpError(e.status, e.url, `probe of ${org}/${names[0]} failed: ${e.body}`) : e;
    await pause(run.pauseMs);
    const half = Math.ceil(names.length / 2);
    return [...await probe(g, org, names.slice(0, half), { login, since }, run), ...await probe(g, org, names.slice(half), { login, since }, run)];
  }
  return names.map((name, i) => {
    const repo = data[`r${i}`];
    const latest = repo?.pullRequests?.nodes?.[0]?.updatedAt;
    const issues = (repo?.issues?.nodes || []).map((n) => n.createdAt);
    return { name, active: Date.parse(latest || '') >= Date.parse(since), issues, issuesCut: (repo?.issues?.totalCount || 0) > issues.length };
  });
}

/** The pull requests of `org/name` updated since `since`, newest-updated first, page by page. */
async function repoPulls(g, org, name, { login, since }, run) {
  const pulls = [];
  let after = null;
  for (;;) {
    const data = await shrinkingPage(g, REPO_PULLS_QUERY, { owner: org, name, login, after }, run, `GitHub pull requests of ${org}/${name}`);
    const page = data.repository?.pullRequests;
    if (!page) return pulls;
    pulls.push(...page.nodes.filter((n) => n?.url));
    // Ordered by update: once a page ends before `since`, the rest is older still.
    if (!page.pageInfo.hasNextPage || !page.nodes.length || Date.parse(page.nodes.at(-1).updatedAt) < Date.parse(since)) return pulls;
    after = page.pageInfo.endCursor;
  }
}

/** The organization route: { pulls, issues, notes }. */
async function orgPulls(g, org, login, period, run) {
  const { from } = period;
  const since = new Date(from - DAY_MS).toISOString();
  const repos = await g.paged(`/orgs/${encodeURIComponent(org)}/repos?type=all`, REPO_CAP);
  const names = repos.map((r) => r.name);
  const probed = [];
  for (let i = 0; i < names.length; i += PROBE_BATCH) probed.push(...await probe(g, org, names.slice(i, i + PROBE_BATCH), { login, since }, run));
  const pulls = [];
  const active = probed.filter((p) => p.active);
  for (const p of active) pulls.push(...await repoPulls(g, org, p.name, { login, since }, run));
  // The bounds are an API's (an hour wider); an issue belongs to the period by its working day.
  const issues = probed.reduce((n, p) => n + p.issues.filter((at) => inWorkingPeriod(at, period)).length, 0);
  const issuesCut = probed.filter((p) => p.issuesCut && p.issues.length && Date.parse(p.issues.at(-1)) >= from).length;
  const notes = [
    `pull requests of the ${names.length} repositor${names.length === 1 ? 'y' : 'ies'} of GITHUB_ORG ${org} the token can read (archived included), read per repository — not through search: `
      + `${active.length} had a pull request updated since ${since.slice(0, 10)}, read newest-updated first; complete for those repositories`,
    'opened, merges, reviews and commits are those on the pull requests the person authored, merged, reviewed or committed to, laid on days by their time',
    'issues opened: those the person created in the period, per repository',
  ];
  if (repos.length >= REPO_CAP) notes.push(`repositories cut at ${REPO_CAP}: the others of ${org} are not read`);
  if (issuesCut) notes.push(`issues read up to ${ISSUES_PER_REPO} per repository: cut in ${issuesCut} repositor${issuesCut === 1 ? 'y' : 'ies'}, issues opened is a lower bound`);
  return { pulls, issues, notes };
}

// == the search route (no GITHUB_ORG): the whole of GitHub, a lower bound ==

/** The date one month after `date` (a day past the month's end rolls over: 01-31 → 03-03). */
function addMonth(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}

/**
 * The monthly windows of `updated:` from `start` to `today`, at most MAX_WINDOWS: { windows, cutFrom }
 * where `cutFrom` is the first date not searched, or null.
 */
function monthlyWindows(start, today) {
  const windows = [];
  let from = start;
  while (from <= today && windows.length < MAX_WINDOWS) {
    const end = addDays(addMonth(from), -1);
    windows.push([from, end < today ? end : today]);
    from = addMonth(from);
  }
  return { windows, cutFrom: from <= today ? from : null };
}

/**
 * Every pull request `q` finds updated in [from, to] (UTC dates). A window holding more than
 * SEARCH_CAP is split in halves down to one day; a day still above it is read to the cap and
 * recorded in `run.cuts`; a window that returned fewer distinct pull requests than its issueCount
 * is recorded in `run.short`.
 */
async function pullsUpdated(g, q, login, [from, to], run) {
  // Search's default best-match order is not stable from one page to the next; a fixed order helps.
  const scoped = `${q} updated:${from}..${to} sort:updated-asc`;
  const nodes = [];
  let after = null;
  for (;;) {
    const { search } = await shrinkingPage(g, SEARCH_PULLS_QUERY, { q: scoped, login, after }, run, `GitHub search for ${scoped}`);
    if (search.issueCount > SEARCH_CAP && from < to) {
      const half = Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS / 2);
      const mid = addDays(from, half);
      return [...await pullsUpdated(g, q, login, [from, mid], run), ...await pullsUpdated(g, q, login, [addDays(mid, 1), to], run)];
    }
    nodes.push(...search.nodes.filter((n) => n?.url));
    if (!search.pageInfo.hasNextPage || nodes.length >= SEARCH_CAP) {
      const distinct = new Set(nodes.map((n) => n.id || n.url)).size;
      if (search.issueCount > SEARCH_CAP) run.cuts.push(`${from}: ${search.issueCount}`);
      else if (distinct < search.issueCount) run.short.push(`${distinct} of ${search.issueCount} pull requests updated ${from}..${to}`);
      return nodes;
    }
    after = search.pageInfo.endCursor;
  }
}

/** The search route: { pulls, issues, notes }. */
async function searchPulls(g, login, { since, until, today }, run) {
  // A pull request touched in the period may have been updated since: the windows run to today.
  const { windows, cutFrom } = monthlyWindows(addDays(since, -1), today);
  const pulls = [];
  for (const window of windows) pulls.push(...await pullsUpdated(g, `is:pr involves:${login}`, login, window, run));
  const issues = (await call(g, ISSUES_QUERY, { q: `is:issue author:${login} created:${since}..${until}` }, run)).search.issueCount;
  const notes = [
    'no GITHUB_ORG: pull requests found through GitHub search across the whole of GitHub. Search can return incomplete results '
      + '(its counts change from page to page), so every total here is a lower bound; GITHUB_ORG reads an organization whole',
    `search finds the pull requests the person authored, was assigned, was mentioned in, or commented on or reviewed (involves:), updated since ${addDays(since, -1)}: `
      + 'opened, merges, reviews and commits are those of the pull requests found, laid on days by their time',
    'issues opened: GitHub search\'s count by the dates of the period (UTC), a lower bound, not laid on days',
  ];
  if (cutFrom) notes.push(`search cut at ${MAX_WINDOWS} monthly windows: pull requests last updated from ${cutFrom} on are not read`);
  if (run.short.length) notes.push(`GitHub search returned ${run.short.join('; ')}: the totals are a lower bound`);
  if (run.cuts.length) notes.push(`GitHub search returns at most ${SEARCH_CAP} pull requests per query: cut on ${run.cuts.join(', ')} (day: found)`);
  return { pulls, issues, notes };
}

// == the totals, from the pull requests either route read ==

const repoRow = (rows, name) => {
  if (!rows.has(name)) rows.set(name, { pulls: 0, merged: 0, mergedBy: 0, added: 0, deleted: 0, reviews: 0, comments: 0, commits: 0 });
  return rows.get(name);
};

const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
const lines = (added, deleted) => `+${added} −${deleted}`;
/**
 * The kinds of event that review someone else's pull request: the first of a day carries its lines.
 * A conversation comment alone, a commit or a push is no review (report.mjs `REVIEW_KINDS`).
 */
const REVIEW_LIKE = new Set(['review', 'review comment', 'merge']);

/** The pull request's number: the field, else the last part of its URL. */
const numberOf = (pr) => pr.number ?? Number(String(pr.url).match(/\/pull\/(\d+)/)?.[1]);

/**
 * On someone else's pull request, `reviewed: [additions, deletions]` on the person's first
 * review, review comment or merge of each working day of `period` (the events in time order), the
 * day the report lays it on; a comment or a commit carries none.
 */
function markReviewed(events, pr, period) {
  const days = new Set();
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!REVIEW_LIKE.has(e.kind)) continue;
    const date = workingDate(e.at, period);
    if (days.has(date)) continue;
    days.add(date);
    e.reviewed = [pr.additions || 0, pr.deletions || 0];
  }
}

/**
 * The person's work on `pulls` (each counted once by id) on the working days of `period`: the totals, events and
 * rows. Opened: authored and created in it; merged by them: merged in it; a review: submitted in it
 * (PENDING ignored; COMMENTED is a review comment) — the reviews and their states counted on others'
 * pull requests, those on the person's own apart; a comment: written in it on the conversation; a
 * commit: authored in it by the person, once by its oid. Every event carries its kind, `what`
 * (owner/repo#n), `where` (owner/repo) and `pr` (the URL), and `others: true` on someone else's
 * pull request.
 */
function tally(pulls, login, period) {
  const inPeriod = (at) => inWorkingPeriod(at, period);
  const rows = new Map();
  const events = [];
  const total = {
    pulls: 0, merged: 0, added: 0, deleted: 0, mergedBy: 0, reviews: 0, ownReviews: 0, reviewedPulls: 0, reviewedAdded: 0, reviewedDeleted: 0,
    comments: 0, commits: 0,
  };
  // Others' pull requests the person merged, and those they reviewed or merged: each counted once.
  const others = { merged: 0, touched: 0, touchedAdded: 0, touchedDeleted: 0 };
  const byState = {};
  const commits = new Set();
  for (const pr of pulls) {
    const repo = pr.repository?.nameWithOwner || '?';
    const own = same(pr.author?.login, login);
    const pullEvents = [];
    const event = (at, kind) => pullEvents.push({ at, kind, what: `${repo}#${numberOf(pr)}`, where: repo, pr: pr.url, ...(own ? {} : { others: true }) });
    if (own && inPeriod(pr.createdAt)) {
      const row = repoRow(rows, repo);
      row.pulls += 1;
      row.added += pr.additions;
      row.deleted += pr.deletions;
      total.pulls += 1;
      total.added += pr.additions;
      total.deleted += pr.deletions;
      // GitHub's merged flag is the state now: of the pull requests opened in the period, those merged since.
      if (pr.merged) { row.merged += 1; total.merged += 1; }
      event(pr.createdAt, 'pr opened');
    }
    const mergedByThem = pr.merged && same(pr.mergedBy?.login, login) && inPeriod(pr.mergedAt);
    if (mergedByThem) {
      repoRow(rows, repo).mergedBy += 1;
      total.mergedBy += 1;
      if (!own) others.merged += 1;
      event(pr.mergedAt, 'merge');
    }
    const reviews = (pr.reviews?.nodes || []).filter((r) => r.state !== 'PENDING' && inPeriod(r.submittedAt));
    for (const r of reviews) {
      event(r.submittedAt, r.state === 'COMMENTED' ? 'review comment' : 'review');
      if (own) continue;
      const state = String(r.state || 'unknown').toLowerCase().replace(/_/g, ' ');
      byState[state] = (byState[state] || 0) + 1;
    }
    if (reviews.length && own) total.ownReviews += reviews.length;
    if (reviews.length && !own) {
      repoRow(rows, repo).reviews += reviews.length;
      total.reviews += reviews.length;
      // The volume of others' work reviewed: each pull request's lines once, however many reviews.
      total.reviewedPulls += 1;
      total.reviewedAdded += pr.additions;
      total.reviewedDeleted += pr.deletions;
    }
    if (!own && (reviews.length || mergedByThem)) {
      others.touched += 1;
      others.touchedAdded += pr.additions;
      others.touchedDeleted += pr.deletions;
    }
    const comments = (pr.comments?.nodes || []).filter((c) => same(c.author?.login, login) && inPeriod(c.createdAt));
    for (const c of comments) event(c.createdAt, 'comment');
    if (comments.length) {
      repoRow(rows, repo).comments += comments.length;
      total.comments += comments.length;
    }
    for (const { commit: c } of pr.commits?.nodes || []) {
      // A commit carried by two pull requests (a stacked branch, a backport) counts once.
      if (!c?.oid || commits.has(c.oid) || !same(c.author?.user?.login, login) || !inPeriod(c.authoredDate)) continue;
      commits.add(c.oid);
      repoRow(rows, repo).commits += 1;
      total.commits += 1;
      event(c.authoredDate, 'commit');
    }
    if (!own) markReviewed(pullEvents, pr, period);
    events.push(...pullEvents);
  }
  return { total, others, byState, rows, events };
}

/**
 * The github source for one person.
 *
 * @param {object} g a client from `githubClient` (common/github.mjs)
 * @param {{ login?: string, me?: boolean, org?: string|null, since: string, until: string, tz: string, dayStartsMin?: number }} query
 *   `me` reads the login of the credential's own user; `org` is GITHUB_ORG; `dayStartsMin` the
 *   working day's start (an action belongs to the period by its working day, period.mjs)
 * @param {{ today?: string, pauseMs?: number, rateLimitPauseMs?: number }} [options] the last date
 *   searched (`YYYY-MM-DD` in UTC, search route), the pause before a smaller page and the wait after
 *   a rate limit that names none (tests give others)
 * @returns {Promise<object>} a source result (report.mjs), with `site` the server's URL — the host
 *   of its repositories, as the report matches a commit against git's remotes
 */
export async function collectGithub(g, { login, me, org, since, until, tz, dayStartsMin = 0 }, {
  today = new Date().toISOString().slice(0, 10), pauseMs = RETRY_PAUSE_MS, rateLimitPauseMs = RATE_LIMIT_PAUSE_MS,
} = {}) {
  const user = login || (me ? (await g.api('/user')).data.login : null);
  if (!user) throw new UsageError('no GitHub login: pass --github <login> (or --me)');
  const period = { since, until, tz, dayStartsMin, ...periodBounds({ since, until, tz, dayStartsMin }) };
  const run = {
    paging: { size: PAGE_SIZE }, connectionPaging: { size: CONNECTION_PAGE_SIZE }, pauseMs, rateLimitPauseMs,
    limited: [], cuts: [], short: [], cut: {}, paged: {},
  };
  const found = org ? await orgPulls(g, org, user, period, run) : await searchPulls(g, user, { since, until, today }, run);
  const unique = new Map(found.pulls.map((pr) => [pr.id || pr.url, pr]));
  const whole = [];
  for (const pr of unique.values()) whole.push(await wholePull(g, pr, user, run));
  const { total, others, byState, rows, events } = tally(whole, user, period);
  const notes = [
    ...found.notes,
    'commits pushed directly to a branch without a pull request are not seen here: the git source counts them',
    "a review with the state commented is a review comment; a comment is one on a pull request's conversation (not a line comment inside a review)",
    "reviews and reviews by state are those on others' pull requests (the person's own are counted apart); a review of someone else's pull request is a review, "
      + 'a review comment or a merge — a conversation comment or a commit alone is not, and carries no reviewed lines',
  ];
  const paged = Object.entries(run.paged).map(([key, n]) => `${key} of ${n}`);
  if (paged.length) notes.push(`read beyond the first page of a pull request: ${paged.join(', ')} pull request(s)`);
  for (const [key, n] of Object.entries(run.cut)) notes.push(`${key} not read whole in ${n} pull request(s): GitHub gave no further page`);
  if (run.paging.size < PAGE_SIZE) notes.push(`GitHub answered slowly: pages shrunk from ${PAGE_SIZE} to ${run.paging.size} pull requests`);
  if (run.connectionPaging.size < CONNECTION_PAGE_SIZE) notes.push(`GitHub answered slowly: pages of a pull request's reviews, comments or commits shrunk from ${CONNECTION_PAGE_SIZE} to ${run.connectionPaging.size}`);
  if (run.limited.length) {
    const seconds = Math.round(run.limited.reduce((sum, ms) => sum + ms, 0) / 1000);
    notes.push(`GitHub's rate limit was met ${run.limited.length} time(s): waited ${seconds} s in all`);
  }
  const activity = (r) => r.pulls + r.mergedBy + r.reviews + r.comments + r.commits;
  const ordered = [...rows.entries()].sort((a, b) => activity(b[1]) - activity(a[1]));
  return {
    source: 'github',
    label: `GitHub ${user}${org ? ` in ${org}` : ''}`,
    // The web and git host (github.com, or the Enterprise server): a repository is `<site>/<owner>/<name>`.
    site: g.serverUrl || 'https://github.com',
    totals: [
      ['pull requests opened', total.pulls],
      ['pull requests opened, merged since', total.merged],
      ['pull request lines', lines(total.added, total.deleted)],
      ['pull requests merged by them', total.mergedBy],
      ['reviews', total.reviews],
      ['reviews by state', Object.entries(byState).map(([s, n]) => `${s} ${n}`).join(', ')],
      ['reviews on own pull requests', total.ownReviews],
      ["others' pull requests reviewed", total.reviewedPulls],
      ["others' pull requests merged by them", others.merged],
      ["others' pull requests reviewed or merged", others.touched],
      ['reviewed volume (their lines, once per pull request)', lines(total.reviewedAdded, total.reviewedDeleted)],
      ['reviewed or merged volume (their lines, once per pull request)', lines(others.touchedAdded, others.touchedDeleted)],
      ['comments on pull requests', total.comments],
      ['commits in pull requests', total.commits],
      ['issues opened', found.issues],
    ],
    events,
    breakdown: {
      title: 'per repository',
      header: ['Repository', 'PRs', 'Merged since', 'Merged by them', 'PR +', 'PR −', 'Reviews', 'Comments', 'Commits'],
      rows: ordered.map(([name, r]) => [name, r.pulls, r.merged, r.mergedBy, r.added, r.deleted, r.reviews, r.comments, r.commits]),
      wheres: ordered.map(([name]) => name),
    },
    notes,
  };
}

/**
 * The credential's own GitHub user (`/user`).
 *
 * @param {object} g a client from `githubClient`
 * @returns {Promise<{ login: string, url: string }[]>} one candidate, as `identifyGithub` gives them
 */
export async function identifyGithubMe(g) {
  const { data } = await g.api('/user');
  return [{ login: data.login, url: data.html_url }];
}

/**
 * GitHub users whose public profile name matches `name` (`/search/users`, `in:name`).
 *
 * @param {object} g a client from `githubClient`
 * @param {string} name a person's name
 * @returns {Promise<{ login: string, url: string }[]>}
 */
export async function identifyGithub(g, name) {
  const q = encodeURIComponent(`${name} in:name`);
  const { data } = await g.api(`/search/users?q=${q}&per_page=20`);
  return (data.items || []).map((u) => ({ login: u.login, url: u.html_url }));
}
