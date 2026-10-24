// Setting a tracker project up (ADR 0001 D05, D07): what `<tracker> project-init <KEY> --dry-run`
// reports before the `projects.<KEY>` block is written — the workflow laid against the rules, key
// alias candidates, repository pool candidates by activity and by name pattern. Shared by the
// tracker connectors: the tracker reads its own workflow and task numbers, this module searches the
// code hosts and words the report. A name pattern is a search aid only; the pool stores the explicit
// names the user picks (`tracking-config.mjs` writes them).
import { UsageError } from './cli.mjs';
import { HttpError, ChannelError } from './http.mjs';
import { githubOwnerPullRequests, githubOwnerRepos, githubRecentNames } from './github.mjs';
import { poolRepos } from './pullrequests.mjs';
import { ANY, resolveTransition, statusesText, trackerProject } from './transitions.mjs';

/** How many times a prefix must be seen before it is proposed as a key alias. */
export const ALIAS_MIN_COUNT = 2;
/** How far back the activity search looks by default, in months. */
export const DEFAULT_MONTHS = 6;
/** How many candidate repositories the alias search reads at most (one request each). */
export const ALIAS_SCAN_LIMIT = 30;

const lower = (text) => String(text).trim().toLowerCase();
const reportable = (error) => error instanceof HttpError || error instanceof ChannelError || error instanceof UsageError;
const firstLine = (error) => String(error.message).split('\n')[0];

// == the workflow against the rules ==

/**
 * The project's statuses laid against the rules that hold for it (its own `transitions`, else the
 * defaults): for each rule the moves between two workflow statuses it decides (first match wins),
 * the statuses it names that the workflow lacks; the workflow statuses no rule touches.
 *
 * @param {string[]} statuses the workflow's status names
 * @param {object|undefined} part the `task-tracking.<connector>` mapping, or undefined
 * @param {string} projectKey the project, e.g. PROJ
 * @returns {{ own: boolean, defaultMode: string, rules: object[], uncovered: string[] }}
 *   each rule `{ origin, rule, moves: [from, to][], missing: string[] }`
 */
export function workflowCoverage(statuses, part, projectKey) {
  const project = trackerProject(part, projectKey);
  const own = Array.isArray(project?.config.transitions);
  const list = own ? project.config.transitions : (part?.defaults?.transitions || []);
  const base = own ? `projects.${project.key}.transitions` : 'defaults.transitions';
  const rules = list.map((rule, i) => ({ origin: `${base}[${i}]`, rule, moves: [], missing: [] }));
  const known = new Set(statuses.map(lower));
  for (const entry of rules) {
    const named = [entry.rule.from, entry.rule.to].flatMap((v) => (Array.isArray(v) ? v : [v]));
    entry.missing = [...new Set(named.filter((s) => s !== ANY && !known.has(lower(s))))];
  }
  const touched = new Set();
  for (const from of statuses) {
    for (const to of statuses) {
      if (lower(from) === lower(to)) continue;
      const resolved = resolveTransition(part, projectKey, from, to);
      if (!resolved.rule) continue;
      rules.find((r) => r.origin === resolved.origin)?.moves.push([from, to]);
      touched.add(lower(from)).add(lower(to));
    }
  }
  return { own, defaultMode: part?.defaults?.default || 'person', rules, uncovered: statuses.filter((s) => !touched.has(lower(s))) };
}

// == key aliases ==

const TOKEN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]*)-(\d+)(?![A-Za-z0-9])/g;
// A candidate alias starts a word: not the tail of a kebab-case name (`portfolio-crud-1650`).
const ALIAS_TOKEN = /(?<![A-Za-z0-9-])([A-Za-z][A-Za-z0-9_]*)-(\d+)(?![A-Za-z0-9])/g;

/**
 * The prefixes other than `projectKey` that name a task number of the project in pull request titles
 * and branch names — `PJ-123` where PROJ-123 exists — with how many pull requests or branches carry
 * each (one per item) and one example, most seen first. A prefix that follows a hyphen is the tail of
 * a kebab-case name, not a key, and is not counted.
 *
 * @param {{ repo: string, title?: string|null, branch?: string|null }[]} items titles and branch names
 * @param {string} projectKey the project, e.g. PROJ
 * @param {Iterable<number>} numbers the numbers of the project's tasks
 * @returns {{ prefix: string, count: number, example: string }[]}
 */
export function aliasCandidates(items, projectKey, numbers) {
  const tasks = new Set([...numbers].map(Number));
  const own = String(projectKey).toUpperCase();
  const seen = new Map();
  for (const item of items) {
    const prefixes = new Set();
    for (const text of [item.title, item.branch].filter(Boolean)) {
      for (const m of text.matchAll(ALIAS_TOKEN)) {
        const prefix = m[1].toUpperCase();
        if (prefix !== own && tasks.has(Number(m[2]))) prefixes.add(prefix);
      }
    }
    for (const prefix of prefixes) {
      const had = seen.get(prefix) || { prefix, count: 0, example: `${item.repo}: ${item.title || item.branch}` };
      had.count += 1;
      seen.set(prefix, had);
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

/** Whether `text` carries `<prefix>-<n>` for one of `prefixes` as a whole token. */
export function carriesPrefix(text, prefixes) {
  if (!text) return false;
  const wanted = new Set(prefixes.map((p) => String(p).toUpperCase()));
  return [...String(text).matchAll(TOKEN)].some((m) => wanted.has(m[1].toUpperCase()));
}

// == the pool: owners, patterns, candidates ==

/**
 * The owners to search: `host:owner` as given, else the owners of the project's repositories (the
 * pool and the extended set), each once.
 *
 * @param {string[]} given `--owner` values, `github:acme`
 * @param {string[]} pool the project's repositories, `github:acme/web`
 * @returns {{ host: string, owner: string, id: string }[]}
 */
export function searchOwners(given, pool) {
  const ids = given.length ? given : poolRepos(pool).map((r) => `${r.host}:${r.path.split('/')[0]}`);
  const out = new Map();
  for (const id of ids) {
    const m = /^(github|gitlab):([^\s:/]+)$/.exec(String(id).trim());
    if (!m) throw new UsageError(`--owner '${id}' is not <host>:<owner> with host github or gitlab (e.g. github:acme)`);
    if (!out.has(lower(id))) out.set(lower(id), { host: m[1], owner: m[2], id: `${m[1]}:${m[2]}` });
  }
  return [...out.values()];
}

/** A glob (`*` any run, `?` one character) as an anchored, case-insensitive pattern. */
export function globPattern(glob) {
  const source = String(glob).split('').map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&'))).join('');
  return new RegExp(`^${source}$`, 'i');
}

/** Whether the repository `repo` (`host:owner/name`) matches `glob`: by name, or by `owner/name` when the glob has a slash. */
export function repoMatches(repo, glob) {
  const path = String(repo).replace(/^[a-z]+:/, '');
  return globPattern(glob).test(glob.includes('/') ? path : path.split('/').pop());
}

/** The date `months` months before `now`, YYYY-MM-DD. */
export function monthsAgo(months, now = new Date()) {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

/**
 * Search the code hosts for the project's setup, best effort: under each owner the pull requests that
 * carry one of `prefixes` (the key and its aliases) as `<PREFIX>-<n>` in the title or branch since
 * `since`, the repositories whose names match `patterns`, and in the candidate repositories (`pool`
 * and those found) the recent pull request titles and branch names for the alias search. GitHub only;
 * a GitLab owner or repository is named as not searched. Every failure is a note of its step.
 *
 * @param {object} options
 * @param {{ host: string, owner: string, id: string }[]} options.owners from `searchOwners`
 * @param {string[]} options.prefixes the key and its aliases, e.g. [PROJ, PJ]
 * @param {string[]} options.patterns name globs
 * @param {string[]} options.pool the repositories already in the pool, and those given to add
 * @param {string} options.since YYYY-MM-DD
 * @param {{ github: () => object }} options.hosts from `codeHosts`
 * @returns {Promise<{ hits: object[], matched: {repo: string, pattern: string}[], names: object[], notes: { pool: string[], aliases: string[] } }>}
 */
export async function searchProjectSetup({ owners, prefixes, patterns, pool, since, hosts }) {
  const notes = { pool: [], aliases: [] };
  const hits = [];
  const matched = [];
  const guard = async (notesOf, what, work) => {
    try {
      return await work();
    } catch (e) {
      if (!reportable(e)) throw e;
      notesOf.push(`${what}: not searched — ${firstLine(e)}`);
      return null;
    }
  };
  for (const { host, owner, id } of owners) {
    if (host !== 'github') {
      notes.pool.push(`${id}: GitLab: not searched`);
      continue;
    }
    for (const prefix of prefixes) {
      const found = await guard(notes.pool, `${id} pull requests carrying ${prefix}`, () => githubOwnerPullRequests(hosts.github(), owner, prefix, since));
      if (!found) continue;
      if (found.truncated) notes.pool.push(`${id}: only the 100 most recently updated pull requests matching ${prefix} were read`);
      hits.push(...found.pullRequests.filter((pr) => carriesPrefix(pr.title, [prefix]) || carriesPrefix(pr.branch, [prefix])));
    }
    if (patterns.length) {
      const listed = await guard(notes.pool, `${id} repositories`, () => githubOwnerRepos(hosts.github(), owner));
      if (listed?.truncated) notes.pool.push(`${id}: only the first 1000 repositories were matched against the patterns`);
      for (const repo of listed?.repos || []) {
        for (const pattern of patterns) if (repoMatches(repo, pattern)) matched.push({ repo, pattern });
      }
    }
  }
  const unique = new Map();
  for (const pr of hits) if (!unique.has(lower(pr.url))) unique.set(lower(pr.url), pr);
  const candidates = new Map();
  for (const repo of [...pool, ...[...unique.values()].map((pr) => pr.repo), ...matched.map((m) => m.repo)]) {
    if (!candidates.has(lower(repo))) candidates.set(lower(repo), repo);
  }
  const scanned = [...candidates.values()];
  if (scanned.length > ALIAS_SCAN_LIMIT) notes.aliases.push(`only the first ${ALIAS_SCAN_LIMIT} of ${scanned.length} candidate repositories were read`);
  const names = [];
  for (const repo of poolRepos(scanned.slice(0, ALIAS_SCAN_LIMIT))) {
    if (repo.host !== 'github') {
      notes.aliases.push(`${repo.id}: GitLab: not searched`);
      continue;
    }
    const recent = await guard(notes.aliases, repo.id, () => githubRecentNames(hosts.github(), repo.path));
    if (!recent) continue;
    names.push(...recent.pullRequests, ...recent.branches.map((branch) => ({ repo: repo.id, title: null, branch })));
  }
  return { hits: [...unique.values()], matched, names, notes };
}

/**
 * The pool candidates: each repository with its pull requests carrying the key or an alias (`hits`)
 * and the patterns it matched, marked when already in the pool or in the extended set; most hits first.
 *
 * @param {object[]} hits pull requests `{ repo }` from `searchProjectSetup`
 * @param {{repo: string, pattern: string}[]} matched from `searchProjectSetup`
 * @param {string[]} pool the project's repositories
 * @param {string[]} [extended] the project's extended set (D08)
 * @returns {{ repo: string, hits: number, patterns: string[], inPool: boolean, inExtended: boolean }[]}
 */
export function poolCandidates(hits, matched, pool, extended = []) {
  const byRepo = new Map();
  const entry = (repo) => {
    const key = lower(repo);
    if (!byRepo.has(key)) {
      byRepo.set(key, { repo, hits: 0, patterns: [], inPool: pool.some((p) => lower(p) === key), inExtended: extended.some((p) => lower(p) === key) });
    }
    return byRepo.get(key);
  };
  for (const pr of hits) entry(pr.repo).hits += 1;
  for (const { repo, pattern } of matched) if (!entry(repo).patterns.includes(pattern)) entry(repo).patterns.push(pattern);
  return [...byRepo.values()].sort((a, b) => b.hits - a.hits || a.repo.localeCompare(b.repo));
}

// == wording ==

const indented = (text) => String(text).trim().split('\n').map((l) => `  ${l}`);

/** The `## Workflow` lines of the report. */
export function workflowLines(statuses, coverage, { configPath, projectKey, error }) {
  const out = ['## Workflow'];
  if (error) return [...out, `  not read — ${error}`];
  out.push(`  Statuses (${statuses.length}): ${statuses.join(', ') || '(none)'}`);
  if (!coverage.rules.length) {
    return [...out, `  No rules in ${configPath} for ${projectKey}: every move takes the default (${coverage.defaultMode}).`];
  }
  out.push(`  Rules: ${coverage.own ? `the project's own (${configPath}.projects.${projectKey}.transitions)` : `${configPath}.defaults.transitions`}; a move no rule covers is ${coverage.defaultMode}`);
  for (const { origin, rule, moves, missing } of coverage.rules) {
    out.push(`  ${origin}: ${statusesText(rule.from)} → ${statusesText(rule.to)}, ${rule.mode} — ${moves.length} move(s)`);
    const byFrom = new Map();
    for (const [from, to] of moves) byFrom.set(from, [...(byFrom.get(from) || []), to]);
    for (const [from, tos] of byFrom) out.push(`      ${from} → ${tos.join(', ')}`);
    if (missing.length) out.push(`      not in the workflow: ${missing.join(', ')}`);
  }
  out.push(coverage.uncovered.length
    ? `  No rule covers: ${coverage.uncovered.join(', ')} — moves into and out of them stay ${coverage.defaultMode === 'person' ? "a person's" : coverage.defaultMode}`
    : '  Every workflow status is covered by some rule.');
  return out;
}

const flowStatus = (status) => (status === ANY ? `"${ANY}"` : status);
const listsStatus = (value, status) => (Array.isArray(value) ? value : [value]).some((s) => lower(s) === lower(status));

/** The fix of one rule's conflicts: per person-only status it lets a move into or out of, what to change. */
function policyFixes(rule, conflicts, personOnly) {
  const only = new Set(personOnly.map((p) => lower(p.status)));
  const fixes = [];
  const seen = new Set();
  for (const { from, to } of conflicts) {
    for (const [status, into] of [[to, true], [from, false]]) {
      if (!only.has(lower(status)) || seen.has(`${lower(status)}|${into}`)) continue;
      seen.add(`${lower(status)}|${into}`);
      const personRule = into ? `{ from: "${ANY}", to: ${flowStatus(status)}, mode: person }` : `{ from: ${flowStatus(status)}, to: "${ANY}", mode: person }`;
      if (!rule) fixes.push(`set defaults.default to person — or put ${personRule} into the rules`);
      else if (listsStatus(into ? rule.to : rule.from, status)) fixes.push(`take ${status} out of its ${into ? 'to' : 'from'} — or put ${personRule} before it`);
      else fixes.push(`put ${personRule} before it`);
    }
  }
  return [...new Set(fixes)];
}

/**
 * The `## Policy` lines of the report (ADR 0004 D02): the person-only statuses with the paths that
 * name them and the policy's sources, then each rule — or `defaults.default` — that lets a move into
 * or out of one run in a mode other than `person`: its path, the moves and the fix. A conflict stops
 * nothing; such a move is refused as `person` when it runs.
 *
 * @param {object[]} conflicts from `policyConflicts`
 * @param {{ personOnly: object[], sources: object[] }} policy from `effectivePolicy`
 * @param {{ configPath: string, projectKey: string, workflow: boolean, proposed?: boolean }} options
 *   `workflow` whether the conflicts were sought among the workflow's statuses; `proposed` whether the
 *   policy includes the proposed block
 * @returns {string[]}
 */
export function policyLines(conflicts, policy, { configPath, projectKey, workflow, proposed = false }) {
  const out = ['## Policy'];
  if (!policy.personOnly.length) {
    return [...out, `  No policy in ${configPath} (defaults.policy, projects.${projectKey}.policy): the rules alone decide who moves.`];
  }
  const shownStatuses = policy.personOnly.map((p) => `${p.status} (${p.origins.join(', ')})`).join(', ');
  out.push(`  Person-only${proposed ? ', with the proposed block' : ''}: ${shownStatuses} — only a person moves a task into or out of them`);
  out.push(policy.sources.length
    ? `  Source: ${policy.sources.map((s) => `${s.source} (${s.origin})`).join(', ')} — read it to check the rules (scenarios/policy-check.md)`
    : '  Source: none recorded — add the knowledge-base page with --policy-source <url>');
  out.push(`  Checked: ${workflow ? "every move between the workflow's statuses" : `the statuses the rules and the policy name, and "${ANY}" for any other (the workflow was not read)`}`);
  if (!conflicts.length) return [...out, "  No conflict: every move into or out of a person-only status is a person's."];
  const groups = new Map();
  for (const conflict of conflicts) {
    if (!groups.has(conflict.origin)) groups.set(conflict.origin, []);
    groups.get(conflict.origin).push(conflict);
  }
  out.push(`  Conflicts (${groups.size}): a move by these is refused as person when it runs — fix the rules, or keep the policy's word:`);
  for (const [origin, list] of groups) {
    const { rule, mode } = list[0];
    out.push(rule ? `  ${configPath}.${origin}: ${statusesText(rule.from)} → ${statusesText(rule.to)}, ${mode}` : `  ${configPath}.${origin} (${mode})`);
    out.push(`      ${list.map((c) => `${c.from} → ${c.to}`).join(', ')}`);
    for (const fix of policyFixes(rule, list, policy.personOnly)) out.push(`      fix: ${fix}`);
  }
  return out;
}

/** The `## Key aliases` lines of the report. */
export function aliasLines(candidates, { configured, error, notes = [] }) {
  const out = ['## Key aliases'];
  const set = new Set(configured.map((a) => String(a).toUpperCase()));
  out.push(`  Configured: ${configured.length ? configured.join(', ') : '(none)'}`);
  if (error) out.push(`  not searched — ${error}`);
  else {
    const proposed = candidates.filter((c) => c.count >= ALIAS_MIN_COUNT);
    if (!proposed.length) out.push(`  No other prefix names a task number of the project at least ${ALIAS_MIN_COUNT} times.`);
    for (const c of proposed) {
      out.push(`  ${c.prefix.padEnd(10)} ${String(c.count).padStart(3)}×${set.has(c.prefix) ? '  (configured)' : ''}  e.g. ${c.example}`);
    }
  }
  out.push(...notes.map((n) => `  ${n}`));
  return out;
}

/**
 * The `## Repository pool` lines of the report: the pool, the extended set, and each candidate — marked
 * `*` in the pool, `+` in the extended set, else followed by the two commands that add it to one or
 * the other (`tool` and `projectKey` make them).
 */
export function poolLines(candidates, { pool, extended = [], owners, since, patterns, notes = [], skipped, tool, projectKey }) {
  const out = ['## Repository pool'];
  out.push(`  In the pool: ${pool.length ? pool.join(', ') : '(none)'}`);
  out.push(`  In the extended set (searched only with --extended): ${extended.length ? extended.join(', ') : '(none)'}`);
  if (skipped) return [...out, `  ${skipped}`];
  out.push(`  Searched: ${owners.map((o) => o.id).join(', ')}; pull requests updated since ${since}${patterns.length ? `; name patterns ${patterns.join(', ')} (a search aid, never stored)` : ''}`);
  if (!candidates.length) out.push('  (no candidates found)');
  for (const c of candidates) {
    const why = [c.hits ? `${c.hits} pull request(s)` : '', c.patterns.length ? `matches ${c.patterns.join(', ')}` : ''].filter(Boolean).join('; ');
    out.push(`  ${c.inPool ? '*' : c.inExtended ? '+' : ' '} ${c.repo}  — ${why}`);
    if (!c.inPool && !c.inExtended) {
      out.push(`      pool:     ${tool} repos add ${projectKey} ${c.repo} --dry-run`,
        `      extended: ${tool} repos add --extended ${projectKey} ${c.repo} --dry-run`);
    }
  }
  if (candidates.some((c) => c.inPool)) out.push('  * = already in the pool');
  if (candidates.some((c) => c.inExtended)) out.push('  + = already in the extended set');
  out.push(...notes.map((n) => `  ${n}`));
  return out;
}

/** The `## Results and epics` lines of the report: the project's prose, or what to ask the user. */
export function proseLines(project) {
  const out = ['## Results and epics'];
  const ask = {
    results: "ask the user where the results of this project's tasks usually are",
    epics: "ask the user how this project's epics are split (optional)",
  };
  for (const field of ['results', 'epics']) {
    if (project?.[field]) out.push(`  ${field}:`, ...indented(project[field]).map((l) => `  ${l}`));
    else out.push(`  ${field}: not set — ${ask[field]}`);
  }
  return out;
}
