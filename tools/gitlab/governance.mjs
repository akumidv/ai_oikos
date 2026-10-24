// GitLab project governance, read-only: the project's merge checks, its protected branches, its
// approval settings and rules, CODEOWNERS — and the merged merge requests of a period with their
// approvals. What a token's role or the instance's tier does not reach (approval rules need Premium;
// some settings need Maintainer) is reported as such instead of failing the whole read.
import { HttpError } from '../common/http.mjs';
import { codeownersRules } from '../common/governance.mjs';
import { projectPath } from '../common/gitlab.mjs';

/** Where GitLab looks for CODEOWNERS, in its order: the first found is the one in force. */
export const CODEOWNERS_PATHS = ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];
/** The project's merge settings shown, in this order, when GitLab returns them. */
export const MERGE_FIELDS = [
  'merge_method', 'squash_option', 'only_allow_merge_if_pipeline_succeeds', 'allow_merge_on_skipped_pipeline',
  'only_allow_merge_if_all_discussions_are_resolved', 'only_allow_merge_if_all_status_checks_passed',
  'remove_source_branch_after_merge', 'resolve_outdated_diff_discussions', 'approvals_before_merge',
  'merge_pipelines_enabled', 'merge_trains_enabled',
];
const PROTECTED_LIMIT = 100;
const NOTES_LIMIT = 1000;
const PREMIUM = 'needs Premium or Maintainer';
const UNREADABLE = 'not readable with this token (needs Maintainer)';

/** GitLab's own message in an error body (JSON `message` or `error`), else the body's start. */
function bodyMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return String(parsed.message || parsed.error || body).slice(0, 200);
  } catch {
    return String(body).slice(0, 200);
  }
}

/**
 * A read whose absence or refusal is an answer: { state: 'ok', data } | { state: 'absent' } |
 * { state: 'unreadable', why }. A 403 is always `unreadable` (the token's role or the tier refuses
 * it; `why` carries GitLab's message). A 404 is `unreadable` by default, since a part of a project
 * that was itself just read is hidden for the role or missing on the tier, never absent; only a
 * probe whose 404 really is absence (a CODEOWNERS path) passes `notFound: 'absent'`.
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} path the API path
 * @param {{ notFound?: 'absent' | 'unreadable', as?: string }} [opts] what a 404 means; the rest goes to `g.get`
 * @returns {Promise<{ state: 'ok', data: any } | { state: 'absent' } | { state: 'unreadable', why: string }>}
 */
async function optional(g, path, { notFound = 'unreadable', ...opts } = {}) {
  try {
    const data = await g.get(path, { ...opts, absentOn404: true });
    if (data !== null) return { state: 'ok', data };
    return notFound === 'absent' ? { state: 'absent' } : { state: 'unreadable', why: 'GitLab answered 404' };
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) return { state: 'unreadable', why: `refused (403) — ${bodyMessage(e.body)}` };
    throw e;
  }
}

/**
 * The governance of the project `path` (`group/name`): its merge settings (the full project, so a
 * field GitLab leaves out for the token's role or tier is missing), its protected branches, its
 * approval settings and rules, and the CODEOWNERS file in force on the default branch. The parts that
 * may be refused are { state: 'ok', data } or { state: 'unreadable', why } as `optional` answers
 * (never `absent`: a 403 or 404 there is the token's role or the tier); `protectedBranches.data` is
 * GitLab's raw list, which a role below Maintainer may see filtered or empty, and `unreadable` never
 * means unprotected. `codeowners` is { state: 'ok', path, rules }, { state: 'absent', looked } when no
 * path has the file, or `unreadable` as `optional` answers.
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} path the project, `group/name`
 * @returns {Promise<object>} the combined object `--json` prints
 */
export async function gitlabGovernance(g, path) {
  const p = `/projects/${projectPath(path)}`;
  const project = await g.get(p);
  // One page holds PROTECTED_LIMIT rows (GitLab's maximum per page). A 404 or 403 here is the token's
  // role, not an absence of protection: the project itself was just read.
  const protectedBranches = await optional(g, `${p}/protected_branches?per_page=${PROTECTED_LIMIT}&page=1`);
  const approvals = await optional(g, `${p}/approvals`);
  const approvalRules = await optional(g, `${p}/approval_rules?per_page=100`);
  const merge = Object.fromEntries(MERGE_FIELDS.filter((f) => f in project).map((f) => [f, project[f]]));
  return {
    project: path, defaultBranch: project.default_branch, merge, protectedBranches, approvals, approvalRules,
    codeowners: await gitlabCodeowners(g, p, project.default_branch),
  };
}

/** The CODEOWNERS file in force at `ref`: the first of CODEOWNERS_PATHS that exists. */
async function gitlabCodeowners(g, p, ref) {
  if (!ref) return { state: 'absent', looked: CODEOWNERS_PATHS };
  for (const file of CODEOWNERS_PATHS) {
    // A 404 here is the file missing at this path (the repository's other paths are probed next).
    const r = await optional(g, `${p}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`, { as: 'text', notFound: 'absent' });
    if (r.state === 'unreadable') return r;
    if (r.state === 'ok') return { state: 'ok', path: file, rules: codeownersRules(r.data) };
  }
  return { state: 'absent', looked: CODEOWNERS_PATHS };
}

const yes = (flag) => (flag ? 'yes' : 'no');
const value = (v) => (typeof v === 'boolean' ? yes(v) : v === null || v === undefined ? '-' : String(v));
const levels = (list) => (list || []).map((l) => l.access_level_description || l.user_id || l.group_id || l.access_level).join(' + ') || 'no one';

/** The scalar settings of an approvals answer, as `name value` pairs. */
function scalarText(settings) {
  return Object.entries(settings || {}).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => `${k} ${value(v)}`).join(', ');
}

/** An approval rule, in one line. */
function ruleText(rule) {
  const who = [
    ...(rule.users || []).map((u) => `@${u.username}`),
    ...(rule.groups || []).map((x) => `group ${x.full_path || x.name}`),
  ];
  const branches = (rule.protected_branches || []).map((b) => b.name);
  return `${rule.name} (${rule.rule_type || 'regular'}): ${rule.approvals_required ?? 0} required · approvers ${who.join(', ') || 'any eligible'}`
    + `${branches.length ? ` · branches ${branches.join(', ')}` : ''}`;
}

/**
 * The governance object of `gitlabGovernance` as compact lines for an agent's context.
 *
 * @param {object} gov from `gitlabGovernance`
 * @returns {string[]}
 */
export function gitlabGovernanceLines(gov) {
  const out = [`gitlab:${gov.project} · default branch ${gov.defaultBranch || '-'}`];
  const shown = Object.entries(gov.merge);
  out.push(`merge checks: ${shown.length ? shown.map(([k, v]) => `${k} ${value(v)}`).join(', ') : 'none returned (needs Maintainer?)'}`);
  const pb = gov.protectedBranches;
  if (pb.state === 'ok') {
    // A role below Maintainer may get a filtered or empty list: a count is what the token sees, never "none".
    out.push(`protected branches: ${pb.data.length} visible to this token`);
    for (const b of pb.data) {
      out.push(`  ${b.name}: push ${levels(b.push_access_levels)} · merge ${levels(b.merge_access_levels)} · force push ${yes(b.allow_force_push)}`
        + ` · code owner approval ${yes(b.code_owner_approval_required)}`);
    }
  } else out.push(`protected branches: ${UNREADABLE} — ${pb.why}`);
  const refused = (part) => `not available: ${PREMIUM} — ${part.why}`;
  out.push(`approval settings: ${gov.approvals.state === 'ok' ? scalarText(gov.approvals.data) || '-' : refused(gov.approvals)}`);
  if (gov.approvalRules.state === 'ok') {
    out.push(`approval rules: ${gov.approvalRules.data.length}`);
    for (const r of gov.approvalRules.data) out.push(`  ${ruleText(r)}`);
  } else out.push(`approval rules: ${refused(gov.approvalRules)}`);
  const co = gov.codeowners;
  if (co.state === 'ok') {
    out.push(`CODEOWNERS: ${co.path} — ${co.rules.length} rule(s)`);
    for (const line of co.rules) out.push(`  ${line}`);
  } else if (co.state === 'absent') out.push(`CODEOWNERS: none (looked in ${co.looked.join(', ')})`);
  else out.push(`CODEOWNERS: ${co.why}`);
  return out;
}

/**
 * The merge requests of the project `path` merged on or after `since`, oldest merge first: those
 * updated since (GitLab has no filter by merge date on every version), at most `limit` read, kept
 * when merged since. Each with its approvals (null when refused or absent) and, with `notes`, the
 * count of its non-system notes; and its merge record (`common/governance.mjs`) with `number` `!iid`.
 * `truncated` when `limit` rows were read.
 *
 * @param {object} g a client from `gitlabClient`
 * @param {string} path the project, `group/name`
 * @param {string} since a date, YYYY-MM-DD
 * @param {{ limit: number, notes?: boolean }} options
 * @returns {Promise<{ mergeRequests: object[], records: object[], truncated: boolean }>}
 */
export async function gitlabMerged(g, path, since, { limit, notes = false }) {
  const p = `/projects/${projectPath(path)}`;
  const from = Date.parse(`${since}T00:00:00Z`);
  const q = new URLSearchParams({ state: 'merged', updated_after: `${since}T00:00:00Z`, order_by: 'updated_at', sort: 'desc' });
  const rows = await g.paged(`${p}/merge_requests?${q}`, limit);
  const merged = rows.filter((mr) => mr.merged_at && Date.parse(mr.merged_at) >= from).sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at));
  const mergeRequests = [];
  for (const mr of merged) {
    const approvals = await optional(g, `${p}/merge_requests/${mr.iid}/approvals`);
    const count = notes ? (await g.paged(`${p}/merge_requests/${mr.iid}/notes?sort=asc`, NOTES_LIMIT)).filter((n) => !n.system).length : null;
    mergeRequests.push({ mergeRequest: mr, approvals: approvals.state === 'ok' ? approvals.data : null, notes: count });
  }
  const records = mergeRequests.map(({ mergeRequest: mr, approvals, notes: n }) => ({
    number: `!${mr.iid}`,
    title: mr.title,
    createdAt: mr.created_at,
    mergedAt: mr.merged_at,
    author: mr.author?.username || null,
    mergedBy: mr.merge_user?.username || mr.merged_by?.username || null,
    approvers: approvals ? [...new Set((approvals.approved_by || []).map((a) => a.user?.username).filter(Boolean))] : null,
    notes: n,
  }));
  return { mergeRequests, records, truncated: rows.length >= limit };
}
