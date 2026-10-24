// Status transition rules of a tracker (ADR 0001 D01, D02): the `task-tracking.<connector>` part
// of `oikos.yaml` — who may move a task, structured; what is enough to move it, prose. Pure
// functions shared by the tracker connectors: the structure check and the rule a move falls under.
//
//   task-tracking:
//     jira:
//       defaults:
//         default: person                     # a move no rule describes (person when unset)
//         transitions:                        # ordered; the first matching rule wins
//           - { from: [To Do, In Progress], to: [To Do, In Progress, Review], mode: agent }
//           - { from: Review, to: [Test, Done], mode: confirm, requires: <prose> }
//           - { from: "*", to: Closed, mode: confirm, requires: <prose> }
//         number_patterns: ["FIX[{n}]"]       # how a bare task number is written (D11)
//         policy:                             # the organization's policy (ADR 0004 D01)
//           person_only: [Review]             # only a person moves a task into or out of these
//           source: https://kb.example.com/tracker-rules   # the page it comes from, never fetched
//       projects:
//         PROJ:
//           key_aliases: [PJ]
//           repos: [github:acme/web-ui, gitlab:acme/backend]
//           extended_repos: [github:acme/legacy-ui]   # searched only on request (D08)
//           number_repos: [github:acme/web-ui]        # a bare FIX[123] there is PROJ-123 (D11)
//           number_patterns: ["FIX[{n}]"]             # replaces defaults.number_patterns (D11)
//           results: <prose>
//           epic_roles: { fixes: PROJ-10, features: PROJ-11 }   # general epics by role (D09)
//           epic_projects: [PLAN]                     # whose open epics are candidates too (D10)
//           epics: <prose>
//           transitions: [ … ]                # replaces defaults.transitions wholesale
//           policy: { person_only: [Acceptance] }   # adds to defaults.policy, never replaces it
//
// `requires`, `results` and `epics` are free text: printed for the agent, never interpreted.

/** The modes a move can take, fixed in the core (D02). */
export const MODES = Object.freeze(['agent', 'confirm', 'person']);

/** The connectors a `task-tracking` part may describe. */
export const TRACKERS = Object.freeze(['jira', 'github-issues', 'gitlab-issues']);

/** The mode of a move no rule describes, when `defaults.default` is not set. */
export const DEFAULT_MODE = 'person';

/** A status that stands for any status in `from` or `to`. */
export const ANY = '*';

const REPO_HOSTS = ['github', 'gitlab'];
const RULE_KEYS = ['from', 'to', 'mode', 'requires'];
const PART_KEYS = ['defaults', 'projects'];
const DEFAULTS_KEYS = ['default', 'transitions', 'number_patterns', 'policy'];
const POLICY_KEYS = ['person_only', 'source'];
const PROJECT_KEYS = [
  'key_aliases', 'repos', 'extended_repos', 'number_repos', 'number_patterns', 'results', 'epic_roles', 'epic_projects', 'epics', 'transitions', 'policy',
];
/** The repository lists of a project: the pool (D05) and the extended set (D08); a repository is in one at most. */
export const REPO_LISTS = Object.freeze(['repos', 'extended_repos']);

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const shown = (value) => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));

function unknownKeys(map, allowed, path, problems) {
  for (const key of Object.keys(map)) {
    if (!allowed.includes(key)) problems.push(`${path}.${key}: unknown key (expected ${allowed.join(', ')})`);
  }
}

function checkMode(value, path, problems) {
  if (!MODES.includes(value)) problems.push(`${path}: ${shown(value)} is not one of ${MODES.join(', ')}`);
}

function checkStatuses(value, path, problems) {
  if (value === undefined || value === null) {
    problems.push(`${path}: missing (a status, a list of statuses, or "${ANY}")`);
    return;
  }
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) problems.push(`${path}: an empty list matches nothing`);
  list.forEach((status, i) => {
    if (!isText(status)) problems.push(`${path}${Array.isArray(value) ? `[${i}]` : ''}: ${shown(status)} is not a status name`);
  });
}

function checkText(value, path, problems) {
  if (value !== undefined && value !== null && typeof value !== 'string') problems.push(`${path}: must be text`);
}

function checkTextList(value, path, problems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`${path}: must be a list`);
    return [];
  }
  value.forEach((item, i) => { if (!isText(item)) problems.push(`${path}[${i}]: ${shown(item)} is not text`); });
  return value.filter(isText);
}

function checkRules(rules, path, problems) {
  if (rules === undefined || rules === null) return;
  if (!Array.isArray(rules)) {
    problems.push(`${path}: must be a list of rules`);
    return;
  }
  rules.forEach((rule, i) => {
    const at = `${path}[${i}]`;
    if (!isMap(rule)) {
      problems.push(`${at}: must be a mapping with from, to, mode`);
      return;
    }
    unknownKeys(rule, RULE_KEYS, at, problems);
    checkStatuses(rule.from, `${at}.from`, problems);
    checkStatuses(rule.to, `${at}.to`, problems);
    if (rule.mode === undefined) problems.push(`${at}.mode: missing (one of ${MODES.join(', ')})`);
    else checkMode(rule.mode, `${at}.mode`, problems);
    checkText(rule.requires, `${at}.requires`, problems);
  });
}

/** A `policy` part (ADR 0004 D01): `person_only` a list of status names, `source` text. */
function checkPolicy(value, path, problems) {
  if (value === undefined || value === null) return;
  if (!isMap(value)) {
    problems.push(`${path}: must be a mapping with person_only and source`);
    return;
  }
  unknownKeys(value, POLICY_KEYS, path, problems);
  const statuses = value.person_only;
  if (statuses !== undefined && statuses !== null) {
    if (!Array.isArray(statuses)) problems.push(`${path}.person_only: must be a list of status names, e.g. [Review]`);
    else {
      statuses.forEach((status, i) => {
        if (!isText(status)) problems.push(`${path}.person_only[${i}]: ${shown(status)} is not a status name`);
        else if (status.trim() === ANY) problems.push(`${path}.person_only[${i}]: "${ANY}" is not a status — name each person-only status`);
      });
    }
  }
  if (value.source !== undefined && value.source !== null && !isText(value.source)) {
    problems.push(`${path}.source: must be text — the knowledge-base page the policy comes from`);
  }
}

const asTextList = (value) => (Array.isArray(value) ? value.filter(isText) : []);

function checkRepoList(value, path, problems) {
  if (!checkTextList(value, path, problems).length) return;
  value.forEach((repo, i) => {
    if (isText(repo) && !isRepo(repo)) {
      problems.push(`${path}[${i}]: '${repo}' is not <host>:<owner>/<name> with host ${REPO_HOSTS.join(' or ')}`);
    }
  });
}

const sameName = (value) => String(value).trim().toLowerCase();

/** The placeholder of the task's number in a `number_patterns` template (D11): `FIX[{n}]`. */
export const NUMBER = '{n}';
const ROLE = /^[a-z][a-z0-9_-]*$/;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

/**
 * Why `pattern` is not a number template, or null when it is one: literal text holding `{n}` exactly
 * once, with at least one other non-blank character (a bare number is never matched, D11).
 *
 * @param {string} pattern a `number_patterns` entry
 * @returns {string|null}
 */
export function numberPatternProblem(pattern) {
  const text = String(pattern);
  if (text.split(NUMBER).length - 1 !== 1) return `must hold ${NUMBER} exactly once`;
  if (!text.replace(NUMBER, '').trim()) return `needs literal text beside ${NUMBER} — a bare number is not matched`;
  return null;
}

function checkPatterns(value, path, problems) {
  if (!checkTextList(value, path, problems).length) return;
  value.forEach((pattern, i) => {
    const problem = isText(pattern) ? numberPatternProblem(pattern) : null;
    if (problem) problems.push(`${path}[${i}]: '${pattern}' ${problem}`);
  });
}

const validPatterns = (value) => asTextList(value).filter((pattern) => !numberPatternProblem(pattern));

function checkEpicRoles(value, projectKey, path, problems) {
  if (value === undefined || value === null) return;
  if (!isMap(value)) {
    problems.push(`${path}: must be a mapping of a role name to an epic of the project (fixes: ${projectKey}-10)`);
    return;
  }
  for (const [role, key] of Object.entries(value)) {
    if (!ROLE.test(role)) problems.push(`${path}.${role}: '${role}' is not a lowercase role name`);
    const m = typeof key === 'string' ? ISSUE_KEY.exec(key.trim()) : null;
    if (!m) problems.push(`${path}.${role}: ${shown(key)} is not an issue key like ${projectKey}-10`);
    else if (m[1].toUpperCase() !== projectKey.toUpperCase()) {
      problems.push(`${path}.${role}: '${key}' is not an epic of ${projectKey} — a role epic is the project's own; another project's epics come through epic_projects`);
    }
  }
}

function checkEpicProjects(value, projectKey, path, problems) {
  if (!Array.isArray(value)) {
    checkTextList(value, path, problems);
    return;
  }
  const seen = new Map();
  value.forEach((key, i) => {
    if (!isText(key) || !PROJECT_KEY.test(key.trim())) problems.push(`${path}[${i}]: ${shown(key)} is not a project key like PLAN`);
    else if (key.trim().toUpperCase() === projectKey.toUpperCase()) problems.push(`${path}[${i}]: '${key}' is the project itself — its own open epics are candidates already`);
    else if (seen.has(key.trim().toUpperCase())) problems.push(`${path}[${i}]: '${key}' is listed already at [${seen.get(key.trim().toUpperCase())}] — its open epics would be read twice`);
    else seen.set(key.trim().toUpperCase(), i);
  });
}

function checkNumberRepos(project, path, defaults, problems) {
  checkRepoList(project.number_repos, `${path}.number_repos`, problems);
  const numbered = asTextList(project.number_repos);
  if (!numbered.length) return;
  const listed = new Set([...asTextList(project.repos), ...asTextList(project.extended_repos)].map(sameName));
  numbered.forEach((repo, i) => {
    if (isRepo(repo) && !listed.has(sameName(repo))) {
      problems.push(`${path}.number_repos[${i}]: '${repo}' is in neither ${path}.repos nor ${path}.extended_repos — those say when it is searched`);
    }
  });
  const own = Array.isArray(project.number_patterns);
  if (!validPatterns(own ? project.number_patterns : defaults?.number_patterns).length) {
    problems.push(`${path}.number_repos: no number pattern in reach — set ${path}.number_patterns${own ? '' : ' or defaults.number_patterns'}`);
  }
}

function checkProject(project, key, path, defaults, problems) {
  if (project === null || project === undefined) return; // a key with only comments under it
  if (!isMap(project)) {
    problems.push(`${path}: must be a mapping`);
    return;
  }
  unknownKeys(project, PROJECT_KEYS, path, problems);
  checkTextList(project.key_aliases, `${path}.key_aliases`, problems);
  for (const list of REPO_LISTS) checkRepoList(project[list], `${path}.${list}`, problems);
  const pool = new Set(asTextList(project.repos).map(sameName));
  asTextList(project.extended_repos).forEach((repo, i) => {
    if (pool.has(sameName(repo))) {
      problems.push(`${path}.extended_repos[${i}]: '${repo}' is also in ${path}.repos — a repository belongs to one list`);
    }
  });
  checkPatterns(project.number_patterns, `${path}.number_patterns`, problems);
  checkNumberRepos(project, path, defaults, problems);
  checkText(project.results, `${path}.results`, problems);
  checkEpicRoles(project.epic_roles, key, `${path}.epic_roles`, problems);
  checkEpicProjects(project.epic_projects, key, `${path}.epic_projects`, problems);
  checkText(project.epics, `${path}.epics`, problems);
  checkRules(project.transitions, `${path}.transitions`, problems);
  checkPolicy(project.policy, `${path}.policy`, problems);
}

/** A repository in the `number_repos` of two projects of one connector (D11): one problem per later entry. */
function checkNumberOwners(projects, path, problems) {
  const owner = new Map();
  for (const [key, project] of Object.entries(projects)) {
    if (!isMap(project)) continue;
    asTextList(project.number_repos).forEach((repo, i) => {
      const held = owner.get(sameName(repo));
      if (held === undefined) owner.set(sameName(repo), key);
      else if (held !== key) {
        problems.push(`${path}.projects.${key}.number_repos[${i}]: '${repo}' is also in ${path}.projects.${held}.number_repos — a repository's bare numbers belong to one project`);
      }
    });
  }
}

/** Whether `repo` names one repository as `<host>:<owner>/<name>` (a GitLab path may have subgroups). */
export function isRepo(repo) {
  const m = /^(?<host>[a-z]+):(?<path>[^\s:/][^\s:]*\/[^\s:]*[^\s:/])$/.exec(String(repo).trim());
  return Boolean(m) && REPO_HOSTS.includes(m.groups.host) && !m.groups.path.includes('//') && !m.groups.path.includes('*');
}

/**
 * Every structure problem of one connector's part (`task-tracking.<connector>`), each naming its
 * path under `path`; empty when the part is well formed or absent.
 *
 * @param {unknown} part the parsed `task-tracking.<connector>` value
 * @param {string} path where the part sits, e.g. `task-tracking.jira`
 * @returns {string[]}
 */
export function trackerProblems(part, path) {
  const problems = [];
  if (part === undefined || part === null) return problems;
  if (!isMap(part)) return [`${path}: must be a mapping with defaults and projects`];
  unknownKeys(part, PART_KEYS, path, problems);
  const { defaults, projects } = part;
  if (defaults !== undefined && defaults !== null) {
    if (!isMap(defaults)) problems.push(`${path}.defaults: must be a mapping with default and transitions`);
    else {
      unknownKeys(defaults, DEFAULTS_KEYS, `${path}.defaults`, problems);
      if (defaults.default !== undefined) checkMode(defaults.default, `${path}.defaults.default`, problems);
      checkRules(defaults.transitions, `${path}.defaults.transitions`, problems);
      checkPatterns(defaults.number_patterns, `${path}.defaults.number_patterns`, problems);
      checkPolicy(defaults.policy, `${path}.defaults.policy`, problems);
    }
  }
  if (projects !== undefined && projects !== null) {
    if (!isMap(projects)) problems.push(`${path}.projects: must be a mapping of project keys`);
    else {
      const shared = isMap(defaults) ? defaults : null;
      for (const [key, project] of Object.entries(projects)) checkProject(project, key, `${path}.projects.${key}`, shared, problems);
      checkNumberOwners(projects, path, problems);
    }
  }
  return problems;
}

/**
 * Every structure problem of the whole `task-tracking` part, each naming its path.
 *
 * @param {unknown} part the parsed `task-tracking` value
 * @returns {string[]}
 */
export function taskTrackingProblems(part) {
  if (part === undefined || part === null) return [];
  if (!isMap(part)) return ['task-tracking: must be a mapping keyed by connector'];
  const problems = [];
  for (const [connector, value] of Object.entries(part)) {
    if (!TRACKERS.includes(connector)) problems.push(`task-tracking.${connector}: not a tracker connector (one of ${TRACKERS.join(', ')})`);
    else problems.push(...trackerProblems(value, `task-tracking.${connector}`));
  }
  return problems;
}

const normal = (status) => String(status).trim().toLowerCase();
const statusList = (value) => (Array.isArray(value) ? value : [value]).map(normal);
const covers = (value, status) => statusList(value).some((s) => s === ANY || s === normal(status));

/**
 * The project of `projectKey` in a connector's part, or null when the part does not list it.
 *
 * @param {object} part the `task-tracking.<connector>` mapping
 * @param {string|null} projectKey a project key, e.g. PROJ (case-insensitive); null for none
 * @returns {{ key: string, config: object } | null}
 */
export function trackerProject(part, projectKey) {
  if (projectKey === null || projectKey === undefined) return null;
  const projects = isMap(part?.projects) ? part.projects : {};
  const key = Object.keys(projects).find((k) => k.toUpperCase() === String(projectKey).toUpperCase());
  return key === undefined ? null : { key, config: projects[key] || {} };
}

/**
 * The rule a move falls under. The project's own `transitions` replace `defaults.transitions`
 * wholesale; the first rule whose `from` and `to` cover the move wins (`"*"` covers any status;
 * statuses compare case-insensitively by trimmed name). A move no rule covers takes
 * `defaults.default`, else `person`.
 *
 * @param {object} part the validated `task-tracking.<connector>` mapping
 * @param {string} projectKey the task's project, e.g. PROJ
 * @param {string} from the task's current status
 * @param {string} to the status asked for
 * @returns {{ mode: string, rule: object | null, project: object | null, origin: string }}
 *   `rule` is null when the default decided; `project` is the project's mapping, or null when the
 *   part does not list it; `origin` is the rule's path under the part
 *   (`projects.PROJ.transitions[1]`, `defaults.transitions[0]`, `defaults.default`).
 */
export function resolveTransition(part, projectKey, from, to) {
  const project = trackerProject(part, projectKey);
  const own = Array.isArray(project?.config.transitions);
  const rules = own ? project.config.transitions : (part?.defaults?.transitions || []);
  const base = own ? `projects.${project.key}.transitions` : 'defaults.transitions';
  const index = rules.findIndex((rule) => covers(rule.from, from) && covers(rule.to, to));
  const projectConfig = project ? project.config : null;
  if (index >= 0) return { mode: rules[index].mode, rule: rules[index], project: projectConfig, origin: `${base}[${index}]` };
  return { mode: part?.defaults?.default || DEFAULT_MODE, rule: null, project: projectConfig, origin: 'defaults.default' };
}

/** A rule's statuses as written, for a message: `To Do, In Progress` or `*`. */
export const statusesText = (value) => (Array.isArray(value) ? value : [value]).join(', ');

// == the organization's policy (ADR 0004) ==

/**
 * The policy that holds for a project (ADR 0004 D01): the person-only statuses of `defaults.policy`
 * and of the project's own `policy`, joined — a project's policy adds to the defaults', it never
 * replaces them (unlike `transitions`) — each status once (compared as statuses are) with the paths
 * that name it; and the `source` of each part that has one. Empty lists when there is no policy.
 *
 * @param {object} part the validated `task-tracking.<connector>` mapping
 * @param {string|null} projectKey the project, e.g. PROJ; null for the defaults alone
 * @returns {{ personOnly: { status: string, origins: string[] }[], sources: { origin: string, source: string }[] }}
 */
export function effectivePolicy(part, projectKey) {
  const project = trackerProject(part, projectKey);
  const parts = [{ origin: 'defaults.policy', policy: part?.defaults?.policy }];
  if (project) parts.push({ origin: `projects.${project.key}.policy`, policy: project.config.policy });
  const personOnly = [];
  const sources = [];
  for (const { origin, policy } of parts) {
    if (!isMap(policy)) continue;
    for (const status of asTextList(policy.person_only)) {
      if (status.trim() === ANY) continue;
      const held = personOnly.find((p) => normal(p.status) === normal(status));
      if (!held) personOnly.push({ status: status.trim(), origins: [origin] });
      else if (!held.origins.includes(origin)) held.origins.push(origin);
    }
    if (isText(policy.source)) sources.push({ origin, source: policy.source.trim() });
  }
  return { personOnly, sources };
}

/**
 * The conflict of one move with the policy (ADR 0004 D03), or null: a move into or out of a
 * person-only status whose rule — or `defaults.default` — is not `person`. The stricter of rule and
 * policy wins, so such a move is a person's: `confirm` does not satisfy `person_only` either.
 *
 * @param {object} part the validated `task-tracking.<connector>` mapping
 * @param {string|null} projectKey the task's project, e.g. PROJ
 * @param {string} from the task's current status
 * @param {string} to the status asked for
 * @param {object} [resolved] the move's `resolveTransition`, when the caller has it
 * @returns {{ from: string, to: string, statuses: { status: string, origins: string[] }[], mode: string,
 *   rule: object|null, origin: string, sources: { origin: string, source: string }[] } | null}
 *   `statuses` are the person-only statuses of the move, `origin` the path of the rule it falls under.
 */
export function policyConflict(part, projectKey, from, to, resolved = resolveTransition(part, projectKey, from, to)) {
  if (resolved.mode === 'person') return null;
  const policy = effectivePolicy(part, projectKey);
  const statuses = policy.personOnly.filter((p) => normal(p.status) === normal(from) || normal(p.status) === normal(to));
  if (!statuses.length) return null;
  return { from, to, statuses, mode: resolved.mode, rule: resolved.rule, origin: resolved.origin, sources: policy.sources };
}

/**
 * The mode a move runs in: the rule's (`resolveTransition`), or `person` where the policy names a
 * status of the move (ADR 0004 D03).
 *
 * @param {object} part the validated `task-tracking.<connector>` mapping
 * @param {string|null} projectKey the task's project
 * @param {string} from the current status
 * @param {string} to the status asked for
 * @returns {string} one of MODES
 */
export function effectiveMode(part, projectKey, from, to) {
  const resolved = resolveTransition(part, projectKey, from, to);
  return policyConflict(part, projectKey, from, to, resolved) ? 'person' : resolved.mode;
}

/** The statuses the rules in reach of a project and its policy name, each once as first written, then `"*"`. */
function namedStatuses(part, projectKey, policy) {
  const project = trackerProject(part, projectKey);
  const own = Array.isArray(project?.config.transitions);
  const rules = own ? project.config.transitions : (Array.isArray(part?.defaults?.transitions) ? part.defaults.transitions : []);
  const seen = new Map();
  const add = (status) => {
    if (isText(status) && status.trim() !== ANY && !seen.has(normal(status))) seen.set(normal(status), status.trim());
  };
  for (const rule of rules) for (const status of [rule.from, rule.to].flatMap((v) => (Array.isArray(v) ? v : [v]))) add(status);
  for (const { status } of policy.personOnly) add(status);
  return [...seen.values(), ANY];
}

/**
 * Every move between two of `statuses` that conflicts with the policy (`policyConflict`), each
 * ordered pair once. Without `statuses` (no workflow read) they are the statuses the rules in reach
 * and the policy name, plus `"*"` standing for any other status — so a `"*"` rule and
 * `defaults.default` are caught either way. No policy → no conflict.
 *
 * @param {object} part the validated `task-tracking.<connector>` mapping
 * @param {string|null} projectKey the project, e.g. PROJ; null for the defaults alone
 * @param {string[]|null} [statuses] the workflow's statuses, or null
 * @returns {object[]} as `policyConflict` returns them
 */
export function policyConflicts(part, projectKey, statuses = null) {
  const policy = effectivePolicy(part, projectKey);
  if (!policy.personOnly.length) return [];
  const list = statuses ?? namedStatuses(part, projectKey, policy);
  const out = [];
  for (const from of list) {
    for (const to of list) {
      if (normal(from) === normal(to)) continue;
      const conflict = policyConflict(part, projectKey, from, to);
      if (conflict) out.push(conflict);
    }
  }
  return out;
}

/**
 * Why a conflicting move is a person's, for a message: the person-only statuses, the policy paths
 * that name them under `path`, and their sources (each part's own; else every source; else that
 * none is recorded) — `Review is person-only by task-tracking.jira.defaults.policy (source: <url>)`.
 *
 * @param {object} conflict from `policyConflict`
 * @param {string} path where the part sits, e.g. `task-tracking.jira`
 * @returns {string}
 */
export function policyReason(conflict, path) {
  const names = conflict.statuses.map((p) => p.status);
  const origins = [...new Set(conflict.statuses.flatMap((p) => p.origins))];
  const own = conflict.sources.filter((s) => origins.includes(s.origin));
  const sources = (own.length ? own : conflict.sources).map((s) => s.source);
  const verb = names.length > 1 ? 'are' : 'is';
  return `${names.join(' and ')} ${verb} person-only by ${origins.map((o) => `${path}.${o}`).join(' and ')} `
    + `(${sources.length ? `source: ${sources.join(', ')}` : 'no source recorded'})`;
}

const MOVES_SHOWN = 6;

/**
 * The policy conflicts of the whole `task-tracking` part (ADR 0004 D02) as warnings, one per rule
 * and scope, each naming the rule's path and the moves it lets run: the defaults' rules against the
 * defaults' policy, then each project whose own `transitions` or own `policy` change what holds for
 * it (a move already warned of is not repeated). A conflict is not a structure problem — it stops
 * nothing; a part with problems is left to them.
 *
 * @param {unknown} part the parsed `task-tracking` value
 * @returns {string[]}
 */
export function taskTrackingConflicts(part) {
  if (!isMap(part)) return [];
  const out = [];
  for (const [connector, value] of Object.entries(part)) {
    const path = `task-tracking.${connector}`;
    if (!TRACKERS.includes(connector) || !isMap(value) || trackerProblems(value, path).length) continue;
    const projects = isMap(value.projects) ? value.projects : {};
    const scopes = [null, ...Object.keys(projects).filter((k) => isMap(projects[k]) && (Array.isArray(projects[k].transitions) || isMap(projects[k].policy)))];
    const warned = new Set();
    for (const key of scopes) {
      const groups = new Map();
      for (const conflict of policyConflicts(value, key)) {
        const id = `${conflict.origin}|${normal(conflict.from)}|${normal(conflict.to)}`;
        if (warned.has(id)) continue;
        warned.add(id);
        if (!groups.has(conflict.origin)) groups.set(conflict.origin, []);
        groups.get(conflict.origin).push(conflict);
      }
      for (const list of groups.values()) out.push(conflictWarning(list, path, key));
    }
  }
  return out;
}

/** One warning for the conflicts of one rule (`list`, one origin) in the scope of `key` (null: the defaults). */
function conflictWarning(list, path, key) {
  const moves = list.map((c) => `${c.from} → ${c.to}`);
  const shownMoves = moves.length > MOVES_SHOWN ? [...moves.slice(0, MOVES_SHOWN), `${moves.length - MOVES_SHOWN} more`] : moves;
  return `${path}.${list[0].origin}${key ? ` (for ${key})` : ''}: mode ${list[0].mode} lets ${shownMoves.join(', ')} run, but `
    + `${policyReason({ ...list[0], statuses: mergedStatuses(list) }, path)} — such a move is refused as person; `
    + 'the fix is in project-init --dry-run, § Policy';
}

/** The person-only statuses of several conflicts, each once. */
function mergedStatuses(conflicts) {
  const out = [];
  for (const p of conflicts.flatMap((c) => c.statuses)) if (!out.some((q) => normal(q.status) === normal(p.status))) out.push(p);
  return out;
}

/**
 * The number templates in reach of a project (D11): its own `number_patterns` when it has the key —
 * they replace the defaults' — else `defaults.number_patterns`; only well-formed ones, trimmed.
 *
 * @param {object} part the `task-tracking.<connector>` mapping
 * @param {object|null} project the project's mapping
 * @returns {string[]}
 */
export function numberPatterns(part, project) {
  const own = Array.isArray(project?.number_patterns);
  return validPatterns(own ? project.number_patterns : part?.defaults?.number_patterns).map((pattern) => pattern.trim());
}

/**
 * The project other than `except` whose `number_repos` lists `repo` — whose bare numbers it carries
 * (D11) — or null.
 *
 * @param {object} part the `task-tracking.<connector>` mapping
 * @param {string} repo `host:owner/name`
 * @param {string} [except] a project key to leave out (case-insensitive)
 * @returns {string|null}
 */
export function numberOwner(part, repo, except) {
  const projects = isMap(part?.projects) ? part.projects : {};
  const found = Object.entries(projects).find(([key, project]) => key.toUpperCase() !== String(except ?? '').toUpperCase()
    && asTextList(project?.number_repos).some((r) => sameName(r) === sameName(repo)));
  return found ? found[0] : null;
}
