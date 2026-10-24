// The gitlab source: a person's events on the GitLab site (pushes, merge requests opened, merged by
// them and approved, comments, issues) each at its instant with its kind, where (the project's path)
// and what (the merge request or issue), and the merge requests they authored or reviewed, counted by
// GitLab itself. Others' merge requests the person approved, commented on or merged are read once
// each — their author — and those they approved or merged also their lines, counted in the diff, for
// the reviewed volume: a comment alone is no review.
import { UsageError } from '../../common/cli.mjs';
import { HttpError } from '../../common/http.mjs';
import { addDays } from '../report.mjs';
import { inWorkingPeriod, periodBounds, workingDate } from './period.mjs';
import { eachLimited } from './limited.mjs';
import { RATE_LIMIT_PAUSE_MS, rateLimitNotes, readWithRateLimit } from './ratelimit.mjs';

const EVENT_CAP = 10_000;
/** Projects whose path is looked up at most: an event of another is shown by id and has no `where`. */
const PROJECT_LOOKUPS = 300;
/** GitLab keeps a user's events for three years. */
const EVENT_YEARS = 3;
/** Merge requests read at once (their author, their diff). */
const CONCURRENCY = 4;
/** The files of one merge request's diff read at most. */
const DIFF_FILE_CAP = 3000;
/** The actions on a merge request that look at it: the merge request is read to know whose it is. */
const LOOKS_AT = new Set(['approved', 'accepted', 'commented on']);
/** The actions that review it: of someone else's merge request its diff is read for the lines. */
const REVIEWS = new Set(['approved', 'accepted']);
/**
 * The kinds of event that review someone else's merge request: the first of a day carries its lines.
 * A comment alone or a push is no review (report.mjs `REVIEW_KINDS`).
 */
const REVIEW_LIKE = new Set(['mr approved', 'mr merged']);

/**
 * The kind of a GitLab event.
 *
 * @param {object} e an event of `/users/:id/events`
 * @returns {string} push, mr opened, mr approved, mr merged, comment, issue opened, issue closed,
 *   branch deleted, tag deleted, else `<action> <target>`
 */
export function gitlabKind(e) {
  const action = String(e.action_name || '');
  const target = e.target_type || '';
  // A deleted branch or tag is a push event (`deleted`, target_type null or Project) whose push_data removed a ref.
  if (e.push_data?.action === 'removed') return e.push_data.ref_type === 'tag' ? 'tag deleted' : 'branch deleted';
  if (action.startsWith('pushed')) return 'push';
  if (target === 'MergeRequest' && action === 'opened') return 'mr opened';
  if (target === 'MergeRequest' && action === 'approved') return 'mr approved';
  // `accepted` is the merge the person performed, whoever opened the merge request.
  if (target === 'MergeRequest' && action === 'accepted') return 'mr merged';
  if (action === 'commented on') return 'comment';
  if (target === 'Issue' && action === 'opened') return 'issue opened';
  if (target === 'Issue' && action === 'closed') return 'issue closed';
  return [action, target].filter(Boolean).join(' ') || 'other';
}

/** The measure of the totals each kind counts in; any other kind is its own measure. */
const MEASURE = {
  push: 'pushes', 'mr opened': 'merge requests opened', 'mr merged': 'merge requests merged by them', 'mr approved': 'merge requests approved',
  comment: 'comments', 'issue opened': 'issues opened', 'issue closed': 'issues closed', 'branch deleted': 'branches deleted', 'tag deleted': 'tags deleted',
};

/** The measures the breakdown has a column for, after events and commits. */
const COLUMNS = ['merge requests opened', 'merge requests merged by them', 'merge requests approved', 'comments'];

/** The merge request or issue an event is on: { type: 'mr'|'issue', iid } or null. */
function targetOf(e) {
  const note = e.note || {};
  if (e.target_type === 'MergeRequest' && e.target_iid) return { type: 'mr', iid: e.target_iid };
  if (note.noteable_type === 'MergeRequest' && note.noteable_iid) return { type: 'mr', iid: note.noteable_iid };
  if (e.target_type === 'Issue' && e.target_iid) return { type: 'issue', iid: e.target_iid };
  if (note.noteable_type === 'Issue' && note.noteable_iid) return { type: 'issue', iid: note.noteable_iid };
  return null;
}

/** The GitLab user `username`, the credential's own user with `me`; a usage error when none. */
async function userOf(g, { username, me }) {
  if (username) {
    const [found] = await g.get(`/users?username=${encodeURIComponent(username)}`);
    if (!found) throw new UsageError(`no GitLab user @${username}`);
    return found;
  }
  if (me) return g.get('/user');
  throw new UsageError('no GitLab username: pass --gitlab <username> (or --me)');
}

/** How many merge requests match `query` across the site, from the x-total header (null when GitLab leaves it out). */
async function mergeRequestCount(g, query) {
  const r = await g.api(`/merge_requests?${new URLSearchParams({ scope: 'all', state: 'all', per_page: '1', ...query })}`);
  const total = r.headers.get('x-total');
  return total === null || total === '' ? null : Number(total);
}

/** Whether `e` is GitLab saying a thing is gone or hidden: a 404 (the client's usage error) or a 403. */
const unreadable = (e) => e instanceof UsageError || (e instanceof HttpError && e.status === 403);

/**
 * The paths of `ids` (at most PROJECT_LOOKUPS of them, a few at a time): a hidden or deleted project
 * is left out — shown by id, in the default place.
 */
async function projectPaths(g, ids) {
  const paths = new Map();
  await eachLimited(ids.slice(0, PROJECT_LOOKUPS), CONCURRENCY, async (id) => {
    try {
      paths.set(id, (await g.get(`/projects/${id}`)).path_with_namespace);
    } catch (e) {
      // A 404 (deleted, or no longer visible) or a 403 (no access to it): the project is shown by id.
      if (!unreadable(e)) throw e;
    }
  });
  return paths;
}

/**
 * The lines added and removed in a merge request: its `/diffs` (paged; GitLab 15.7 on), else its
 * `/changes` on an older GitLab — `+` and `-` lines of each file's diff, from its first hunk on.
 * `overflow` when `/changes` says GitLab cut the diff.
 */
async function diffLines(g, pid, iid, limits) {
  const base = `/projects/${pid}/merge_requests/${iid}`;
  let files;
  let overflow = false;
  try {
    files = await readWithRateLimit(() => g.paged(`${base}/diffs`, DIFF_FILE_CAP), limits);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const changes = await readWithRateLimit(() => g.get(`${base}/changes`), limits);
    files = changes?.changes || [];
    overflow = changes?.overflow === true;
  }
  let added = 0;
  let deleted = 0;
  let collapsed = 0;
  for (const f of files) {
    if (!f.diff) { if (f.too_large || f.collapsed) collapsed += 1; continue; }
    let inHunk = false;
    for (const line of f.diff.split('\n')) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue; // a `--- a/x` / `+++ b/x` header, where a diff carries one
      if (line[0] === '+') added += 1;
      else if (line[0] === '-') deleted += 1;
    }
  }
  return { added, deleted, collapsed, cut: files.length >= DIFF_FILE_CAP, overflow };
}

/**
 * The merge requests the person looked at (`keys`: `<project id>!<iid>`): each one's author, and
 * for someone else's that the person reviewed (`reviewedKeys`: approved or merged) its lines
 * (`diffLines`), read once each; a read answered 429 waits once (`limits`).
 */
async function readMergeRequests(g, keys, user, reviewedKeys, limits) {
  const mrs = new Map();
  await eachLimited(keys, CONCURRENCY, async (key) => {
    const [pid, iid] = key.split('!');
    let mr;
    try {
      mr = await readWithRateLimit(() => g.get(`/projects/${pid}/merge_requests/${iid}`), limits);
    } catch (e) {
      if (!unreadable(e)) throw e;
      mrs.set(key, { read: false });
      return;
    }
    const others = !(mr.author?.username && mr.author.username.toLowerCase() === user.username.toLowerCase());
    mrs.set(key, { read: true, others, lines: others && reviewedKeys.has(key) ? await diffLines(g, pid, iid, limits) : null });
  });
  return mrs;
}

/**
 * On someone else's merge request, `reviewed: [added, deleted]` on the person's first approval or
 * merge of each working day of `period` (the events in time order), the day the report lays it on;
 * a comment carries none.
 */
function markReviewed(events, lines, period) {
  const days = new Set();
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!REVIEW_LIKE.has(e.kind)) continue;
    const date = workingDate(e.at, period);
    if (days.has(date)) continue;
    days.add(date);
    e.reviewed = [lines.added, lines.deleted];
  }
}

const linesText = (added, deleted) => `+${added} −${deleted}`;

/**
 * The gitlab source for one person. Each event is `{ at, kind, what, where, pr?, others?,
 * reviewed? }`: `where` the project's path, `what` `group/project!iid` for a merge request,
 * `group/project#iid` for an issue, else the project's path; `pr` the merge request's URL;
 * `others` and `reviewed` on someone else's merge request (see `markReviewed`).
 *
 * @param {object} g a client from `gitlabClient` (common/gitlab.mjs)
 * @param {{ username?: string, me?: boolean, since: string, until: string, tz: string, dayStartsMin?: number }} query
 *   `dayStartsMin` the working day's start: an event belongs to the period by its working day (period.mjs)
 * @param {{ rateLimitPauseMs?: number }} [options] the wait after a 429 that names none (tests give another)
 * @returns {Promise<object>} a source result (report.mjs), with `site` the site's base URL — the
 *   host of its projects, as the report matches a push against git's remotes
 */
export async function collectGitlab(g, { username, me, since, until, tz, dayStartsMin = 0 }, { rateLimitPauseMs = RATE_LIMIT_PAUSE_MS } = {}) {
  const period = { since, until, tz, dayStartsMin };
  const user = await userOf(g, { username, me });
  const notes = [];
  // `after` and `before` are dates in UTC and exclusive: a day of slack on each side (more than any
  // offset and day_starts), and the events are kept by their working day in --tz.
  const q = new URLSearchParams({ after: addDays(since, -2), before: addDays(until, 2), sort: 'asc' });
  const all = await g.paged(`/users/${user.id}/events?${q}`, EVENT_CAP + 1);
  if (all.length > EVENT_CAP) notes.push(`events cut at ${EVENT_CAP}: the totals, days and breakdown cover the first ${EVENT_CAP} of the period`);
  const { from, to } = periodBounds(period);
  const raw = all.slice(0, EVENT_CAP).filter((e) => inWorkingPeriod(e.created_at, period));
  const counts = {};
  let commits = 0;
  const perProject = new Map();
  for (const e of raw) {
    const measure = MEASURE[gitlabKind(e)] || gitlabKind(e);
    counts[measure] = (counts[measure] || 0) + 1;
    const pushed = measure === 'pushes' ? Number(e.push_data?.commit_count) || 0 : 0;
    commits += pushed;
    if (e.project_id) {
      const row = perProject.get(e.project_id) || { events: 0, commits: 0 };
      row.events += 1;
      row.commits += pushed;
      row[measure] = (row[measure] || 0) + 1;
      perProject.set(e.project_id, row);
    }
  }
  const ordered = [...perProject.entries()].sort((a, b) => b[1].events - a[1].events);
  const paths = await projectPaths(g, ordered.map(([id]) => id));
  if (ordered.length > PROJECT_LOOKUPS) {
    notes.push(`project paths looked up for the ${PROJECT_LOOKUPS} most active of ${ordered.length} projects; the rest are shown by id and fall into the default place`);
  }
  const hidden = ordered.slice(0, PROJECT_LOOKUPS).filter(([id]) => !paths.has(id)).length;
  if (hidden) notes.push(`${hidden} project(s) could not be looked up (deleted, or no access): shown by id, they fall into the default place`);
  const projectName = (id) => paths.get(id) || `project ${id}`;
  const mrKey = (e, t) => `${e.project_id}!${t.iid}`;
  const onMr = (actions) => raw.filter((e) => actions.has(String(e.action_name)) && e.project_id && targetOf(e)?.type === 'mr').map((e) => mrKey(e, targetOf(e)));
  const limits = { pauseMs: rateLimitPauseMs, waits: [] };
  const mrs = await readMergeRequests(g, [...new Set(onMr(LOOKS_AT))], user, new Set(onMr(REVIEWS)), limits);
  const events = [];
  const byMr = new Map();
  for (const e of raw) {
    const t = targetOf(e);
    const project = e.project_id ? projectName(e.project_id) : null;
    const event = { at: e.created_at, kind: gitlabKind(e) };
    if (project) event.what = t ? `${project}${t.type === 'mr' ? '!' : '#'}${t.iid}` : project;
    if (e.project_id && paths.has(e.project_id)) event.where = paths.get(e.project_id);
    if (t?.type === 'mr' && e.project_id) {
      const key = mrKey(e, t);
      event.pr = paths.has(e.project_id) && g.base ? `${g.base}/${paths.get(e.project_id)}/-/merge_requests/${t.iid}` : `${project}!${t.iid}`;
      if (mrs.get(key)?.others) {
        event.others = true;
        byMr.set(key, [...(byMr.get(key) || []), event]);
      }
    }
    events.push(event);
  }
  // Others' merge requests the person merged, approved, or either: each counted once.
  const others = { merged: new Set(), approved: new Set(), touched: new Set() };
  let reviewedAdded = 0;
  let reviewedDeleted = 0;
  const collapsed = { files: 0, mrs: 0, cut: 0, overflow: 0 };
  for (const [key, list] of byMr) {
    const lines = mrs.get(key).lines;
    for (const e of list) {
      if (e.kind === 'mr merged') others.merged.add(key);
      if (e.kind === 'mr approved') others.approved.add(key);
      if (REVIEW_LIKE.has(e.kind)) others.touched.add(key);
    }
    if (!others.touched.has(key) || !lines) continue;
    reviewedAdded += lines.added;
    reviewedDeleted += lines.deleted;
    if (lines.collapsed) { collapsed.files += lines.collapsed; collapsed.mrs += 1; }
    if (lines.cut) collapsed.cut += 1;
    if (lines.overflow) collapsed.overflow += 1;
    markReviewed(list, lines, period);
  }
  const created = { created_after: new Date(from).toISOString(), created_before: new Date(to).toISOString() };
  const authored = await mergeRequestCount(g, { ...created, author_username: user.username });
  const reviewed = await mergeRequestCount(g, { ...created, reviewer_username: user.username });
  if (authored === null || reviewed === null) notes.push('GitLab left out a merge request total (it does above 10 000): shown as unknown');
  const unread = [...mrs.values()].filter((m) => !m.read).length;
  if (unread) notes.push(`${unread} merge request(s) the person approved, merged or commented on could not be read (deleted, or no access): not counted as anyone's`);
  if (collapsed.mrs) notes.push(`${collapsed.files} file(s) in ${collapsed.mrs} merge request(s) have a diff GitLab does not show (too large or collapsed): the reviewed volume is a lower bound`);
  if (collapsed.cut) notes.push(`the diff of ${collapsed.cut} merge request(s) read up to ${DIFF_FILE_CAP} files: the reviewed volume is a lower bound`);
  if (collapsed.overflow) notes.push(`GitLab cut the diff of ${collapsed.overflow} merge request(s) it gave through /changes (overflow): the reviewed volume is a lower bound`);
  notes.push(...rateLimitNotes(limits.waits, 'GitLab'));
  const oldest = addDays(new Date().toISOString().slice(0, 10), -365 * EVENT_YEARS);
  if (since < oldest) notes.push(`GitLab keeps events for ${EVENT_YEARS} years: days before ${oldest} have none`);
  notes.push(
    'pushes count push events; commits pushed sum their commit counts, so a force-push of the same commits counts again',
    "others' merge requests are those whose author is not the person: a review of one is an approval or a merge, and its lines are counted once from its diff; "
      + 'a comment alone is no review and carries no lines',
  );
  return {
    source: 'gitlab',
    label: `GitLab @${user.username}`,
    // The site's base URL: a project is `<site>/<path>` (none when the client does not say).
    site: g.base || null,
    totals: [
      ['events', raw.length],
      ['commits pushed', commits],
      ...Object.entries(counts).sort((a, b) => b[1] - a[1]),
      ['merge requests authored (created in the period)', authored ?? 'unknown'],
      ['merge requests as reviewer (created in the period)', reviewed ?? 'unknown'],
      ["others' merge requests merged by them", others.merged.size],
      ["others' merge requests approved", others.approved.size],
      ["others' merge requests reviewed or merged", others.touched.size],
      ['reviewed volume (their lines, once per merge request)', linesText(reviewedAdded, reviewedDeleted)],
    ],
    events,
    breakdown: {
      title: 'per project',
      header: ['Project', 'Events', 'Commits pushed', 'MRs opened', 'MRs merged by them', 'Approvals', 'Comments'],
      rows: ordered.map(([id, r]) => [projectName(id), r.events, r.commits, ...COLUMNS.map((c) => r[c] || 0)]),
      wheres: ordered.map(([id]) => paths.get(id) || null),
    },
    notes,
  };
}

/**
 * The token's own GitLab user (`/user`).
 *
 * @param {object} g a client from `gitlabClient`
 * @returns {Promise<{ username: string, name: string, state: string, url: string }[]>} one candidate, as `identifyGitlab` gives them
 */
export async function identifyGitlabMe(g) {
  const u = await g.get('/user');
  return [{ username: u.username, name: u.name, state: u.state, url: u.web_url }];
}

/**
 * GitLab users matching `name` (`/users?search=`: name, username or public email).
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} name a person's name
 * @returns {Promise<{ username: string, name: string, state: string, url: string }[]>}
 */
export async function identifyGitlab(g, name) {
  const users = await g.get(`/users?search=${encodeURIComponent(name)}&per_page=20`);
  return users.map((u) => ({ username: u.username, name: u.name, state: u.state, url: u.web_url }));
}
