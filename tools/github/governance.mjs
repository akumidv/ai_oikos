// GitHub repository governance, read-only: what guards a branch (the rules of rulesets, the classic
// branch protection), the deployment environments' gates, CODEOWNERS — and the merged pull requests
// of a period with their reviews. Each part a token may not reach (branch protection needs
// Administration read) is reported as such instead of failing the whole read.
import { HttpError } from '../common/http.mjs';
import { codeownersRules } from '../common/governance.mjs';

/** Where GitHub looks for CODEOWNERS, in its order: the first found is the one in force. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const MERGED_PAGE = 50;
const APPROVALS_PER_PULL = 20;

/** GitHub's own message in an error body (JSON `message`), else the body's start. */
function bodyMessage(body) {
  try {
    return JSON.parse(body).message || String(body).slice(0, 200);
  } catch {
    return String(body).slice(0, 200);
  }
}

/**
 * A read whose absence or refusal is an answer: { state: 'ok', data } | { state: 'absent' } |
 * { state: 'refused', status: 403, message }.
 */
async function optional(g, path, opts = {}) {
  try {
    const r = await g.api(path, { ...opts, absentOn404: true });
    return r === null ? { state: 'absent' } : { state: 'ok', data: r.data };
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) return { state: 'refused', status: 403, message: bodyMessage(e.body) };
    throw e;
  }
}

/**
 * The governance of `repo` (`owner/name`) on `branch` (default: the default branch): the rules in
 * force on the branch, the repository's rulesets, the classic protection of the branch, the
 * environments (with the custom branch policies of those that have them) and the CODEOWNERS file in
 * force. Each part is { state, data|message } as `optional` reads it; `codeowners` is
 * { state, path, rules } or { state: 'absent', looked }.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} repo `owner/name`
 * @param {{ branch?: string }} [options]
 * @returns {Promise<object>} the combined object `--json` prints
 */
export async function githubGovernance(g, repo, { branch } = {}) {
  const { data: meta } = await g.api(`/repos/${repo}`);
  const ref = branch || meta.default_branch;
  const b = encodeURIComponent(ref);
  const rules = await optional(g, `/repos/${repo}/rules/branches/${b}?per_page=100`);
  const rulesets = await optional(g, `/repos/${repo}/rulesets?includes_parents=true&per_page=100`);
  const protection = await optional(g, `/repos/${repo}/branches/${b}/protection`);
  const environments = await optional(g, `/repos/${repo}/environments?per_page=100`);
  if (environments.state === 'ok') {
    const withPolicies = [];
    for (const env of environments.data.environments || []) {
      if (!env.deployment_branch_policy?.custom_branch_policies) {
        withPolicies.push(env);
        continue;
      }
      const policies = await optional(g, `/repos/${repo}/environments/${encodeURIComponent(env.name)}/deployment-branch-policies?per_page=100`);
      withPolicies.push({ ...env, branch_policies: policies.state === 'ok' ? policies.data.branch_policies || [] : null });
    }
    environments.data = { ...environments.data, environments: withPolicies };
  }
  return { repo, branch: ref, defaultBranch: meta.default_branch, rules, rulesets, protection, environments, codeowners: await githubCodeowners(g, repo, ref) };
}

/**
 * The CODEOWNERS file in force in `repo` at `ref`: the first of CODEOWNERS_PATHS that exists, as
 * { state: 'ok', path, rules }; { state: 'absent', looked } when none does; a refusal as `optional`.
 */
async function githubCodeowners(g, repo, ref) {
  for (const path of CODEOWNERS_PATHS) {
    const r = await optional(g, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/vnd.github.raw+json' }, as: 'text',
    });
    if (r.state === 'refused') return r;
    if (r.state === 'ok') return { state: 'ok', path, rules: codeownersRules(r.data) };
  }
  return { state: 'absent', looked: CODEOWNERS_PATHS };
}

const yes = (flag) => (flag ? 'yes' : 'no');
const enabled = (setting) => yes(setting?.enabled);

/** A rule's parameters as `name value` pairs; a list of status checks by their contexts. */
function parametersText(parameters) {
  return Object.entries(parameters || {}).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: ${v.map((x) => (x && typeof x === 'object' ? x.context ?? x.name ?? x.pattern ?? '{…}' : x)).join(', ') || '-'}`;
    if (typeof v === 'boolean') return `${k} ${yes(v)}`;
    if (v && typeof v === 'object') return `${k} {…}`;
    return `${k} ${v}`;
  }).join(', ');
}

/** The classic protection of a branch, in one line. */
function protectionText(p) {
  const checks = p.required_status_checks;
  const reviews = p.required_pull_request_reviews;
  const contexts = checks ? (checks.checks?.map((c) => c.context) || checks.contexts || []).join(', ') || 'none named' : null;
  return [
    `enforce admins ${enabled(p.enforce_admins)}`,
    checks ? `status checks (strict ${yes(checks.strict)}): ${contexts}` : 'status checks: not required',
    reviews
      ? `reviews: ${reviews.required_approving_review_count ?? 0} approval(s), code owners ${yes(reviews.require_code_owner_reviews)}, dismiss stale ${yes(reviews.dismiss_stale_reviews)}, last push approval ${yes(reviews.require_last_push_approval)}`
      : 'reviews: not required',
    `linear history ${enabled(p.required_linear_history)}`,
    `force push ${enabled(p.allow_force_pushes)}`,
    `deletions ${enabled(p.allow_deletions)}`,
    `conversation resolution ${enabled(p.required_conversation_resolution)}`,
    ...(p.required_signatures ? [`signed commits ${enabled(p.required_signatures)}`] : []),
  ].join(' · ');
}

/** An environment's gates, in one line. */
function environmentText(env) {
  const parts = [];
  for (const rule of env.protection_rules || []) {
    if (rule.type === 'required_reviewers') {
      const who = (rule.reviewers || []).map((r) => (r.type === 'Team' ? `team ${r.reviewer?.slug}` : `@${r.reviewer?.login}`)).join(', ');
      parts.push(`reviewers ${who || '-'}${rule.prevent_self_review ? ' (no self-review)' : ''}`);
    } else if (rule.type === 'wait_timer') parts.push(`wait ${rule.wait_timer} min`);
    else if (rule.type !== 'branch_policy') parts.push(rule.type);
  }
  if (!parts.length) parts.push('no protection rules');
  const policy = env.deployment_branch_policy;
  if (!policy) parts.push('branches: any');
  else if (policy.protected_branches) parts.push('branches: protected only');
  else if (env.branch_policies) parts.push(`branches: ${env.branch_policies.map((p) => `${p.name}${p.type === 'tag' ? ' (tag)' : ''}`).join(', ') || 'none listed'}`);
  else parts.push('branches: custom policies (not readable)');
  return `${env.name}: ${parts.join(' · ')}`;
}

const refusedText = (part, need) => `refused (403): ${need} — ${part.message}`;

/**
 * The governance object of `githubGovernance` as compact lines for an agent's context.
 *
 * @param {object} gov from `githubGovernance`
 * @returns {string[]}
 */
export function githubGovernanceLines(gov) {
  const out = [`github:${gov.repo} · branch ${gov.branch}${gov.branch === gov.defaultBranch ? ' (default)' : ` (default ${gov.defaultBranch})`}`];
  const names = new Map(gov.rulesets.state === 'ok' ? gov.rulesets.data.map((s) => [s.id, s.name]) : []);
  if (gov.rules.state === 'ok') {
    out.push(`rules on ${gov.branch}: ${gov.rules.data.length}`);
    for (const r of gov.rules.data) {
      const source = r.ruleset_id ? ` [ruleset ${names.has(r.ruleset_id) ? `"${names.get(r.ruleset_id)}" ` : ''}#${r.ruleset_id}${r.ruleset_source_type === 'Organization' ? `, org ${r.ruleset_source}` : ''}]` : '';
      const params = parametersText(r.parameters);
      out.push(`  - ${r.type}${source}${params ? `: ${params}` : ''}`);
    }
  } else out.push(`rules on ${gov.branch}: ${gov.rules.state === 'refused' ? refusedText(gov.rules, 'needs Metadata read') : 'not available'}`);
  if (gov.rulesets.state === 'ok') {
    out.push(`rulesets: ${gov.rulesets.data.length}`);
    for (const s of gov.rulesets.data) out.push(`  #${s.id} ${s.name} · ${s.target || 'branch'} · ${s.enforcement} · ${s.source_type || '?'} ${s.source || ''}`.trimEnd());
  } else out.push(`rulesets: ${gov.rulesets.state === 'refused' ? refusedText(gov.rulesets, 'needs Metadata read, or the plan has no rulesets') : 'not available'}`);
  if (gov.protection.state === 'ok') out.push(`protection of ${gov.branch}: ${protectionText(gov.protection.data)}`);
  else if (gov.protection.state === 'absent') out.push(`protection of ${gov.branch}: not protected, or needs admin (Administration read) — GitHub answers 404 for both`);
  else out.push(`protection of ${gov.branch}: ${refusedText(gov.protection, 'needs admin (Administration read)')}`);
  if (gov.environments.state === 'ok') {
    const envs = gov.environments.data.environments || [];
    out.push(`environments: ${envs.length}`);
    for (const env of envs) out.push(`  ${environmentText(env)}`);
  } else out.push(`environments: ${gov.environments.state === 'refused' ? refusedText(gov.environments, 'needs Actions read (verify)') : 'none, or not available'}`);
  const co = gov.codeowners;
  if (co.state === 'ok') {
    out.push(`CODEOWNERS: ${co.path} — ${co.rules.length} rule(s)`);
    for (const line of co.rules) out.push(`  ${line}`);
  } else if (co.state === 'absent') out.push(`CODEOWNERS: none (looked in ${co.looked.join(', ')})`);
  else out.push(`CODEOWNERS: ${refusedText(co, 'needs Contents read')}`);
  return out;
}

const MERGED_QUERY = `query OikosMerged($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title url createdAt mergedAt author { login } mergedBy { login }
      approvals: reviews(states: APPROVED, first: ${APPROVALS_PER_PULL}) { totalCount nodes { author { login } } }
      reviews { totalCount } } } } }`;

/**
 * The pull requests of `repo` merged on or after `since`, by GitHub's search (one query, page by
 * page), oldest merge first, at most `limit`: the raw nodes and their merge records
 * (`common/governance.mjs`) with `number` `#n`, `title`, `reviews`. `truncated` when GitHub found more.
 *
 * @param {object} g a client from `githubClient`
 * @param {string} repo `owner/name`
 * @param {string} since a date, YYYY-MM-DD
 * @param {number} limit the most to read
 * @returns {Promise<{ pullRequests: object[], records: object[], found: number, truncated: boolean }>}
 */
export async function githubMerged(g, repo, since, limit) {
  const q = `repo:${repo} is:pr is:merged merged:>=${since}`;
  const nodes = [];
  let after = null;
  let found = 0;
  while (nodes.length < limit) {
    const data = await g.graphql(MERGED_QUERY, { q, first: Math.min(MERGED_PAGE, limit - nodes.length), after });
    found = data.search?.issueCount || 0;
    nodes.push(...(data.search?.nodes || []).filter((n) => n?.mergedAt));
    if (!data.search?.pageInfo?.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  const pullRequests = nodes.slice(0, limit).sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const records = pullRequests.map((pr) => ({
    number: `#${pr.number}`,
    title: pr.title,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    author: pr.author?.login || null,
    mergedBy: pr.mergedBy?.login || null,
    approvers: [...new Set((pr.approvals?.nodes || []).map((r) => r.author?.login).filter(Boolean))],
    reviews: pr.reviews?.totalCount ?? null,
  }));
  return { pullRequests, records, found, truncated: found > pullRequests.length };
}
