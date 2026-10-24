// Edits of one tracker project in the installation's `oikos.yaml` (ADR 0001 D05, D07):
// `task-tracking.<connector>.projects.<KEY>` — its `key_aliases`, `repos`, `extended_repos` (D08),
// `number_repos`, `number_patterns` (D11) and `epic_projects` (D10) grow, so does the mapping
// `epic_roles` (D09) by new roles; its `results` and `epics` are replaced; its `policy` (ADR 0004
// D01) grows by new `person_only` statuses and has its `source` replaced. Shared by the tracker
// connectors' `repos add` and `project-init`.
//
// The file is the installation's and is edited in place, so only the changed text moves: the edit is
// spliced into the source at the node it touches — an item appended to a list (flow `[a, b]` or
// block `- a`), a pair added to a mapping, a scalar replaced — and every other byte, comment and key
// order stays. The spliced text is parsed again and must equal the intended configuration, and the
// whole `task-tracking` part must pass `taskTrackingProblems`; otherwise nothing is written.
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { UsageError } from './cli.mjs';
import { isRepo, numberOwner, REPO_LISTS, taskTrackingProblems, TRACKERS } from './transitions.mjs';

/** The lists of a project that grow, in the order a new project block writes its keys. */
export const PROJECT_LISTS = Object.freeze(['key_aliases', 'repos', 'extended_repos', 'number_repos', 'number_patterns', 'epic_projects']);
/** The prose fields of a project that an edit replaces. */
export const PROJECT_TEXTS = Object.freeze(['results', 'epics']);
/** The mappings of a project that grow by new keys (D09: a role name → an epic); a key held with another value is refused. */
export const PROJECT_MAPS = Object.freeze(['epic_roles']);
/** The policy of a project (ADR 0004 D01): its `person_only` statuses grow, its `source` is replaced (`policy.source` in `replaced`). */
export const PROJECT_POLICY = 'policy';
const POLICY_SOURCE = `${PROJECT_POLICY}.source`;

const ROOT = 'task-tracking';
const INDENT = 2;
const lower = (text) => String(text).trim().toLowerCase();

/**
 * The repositories given for a pool, checked: each `<host>:<owner>/<name>`; a name pattern is
 * refused, since the pool stores explicit names (D05). Returns them trimmed.
 *
 * @param {string[]} repos the values as given
 * @param {string} tool the tracker tool's command, for the message
 * @returns {string[]}
 */
export function poolRepoArgs(repos, tool) {
  return repos.map((given) => {
    const repo = String(given).trim();
    if (repo.includes('*') || repo.includes('?')) {
      throw new UsageError(`'${repo}' is a pattern: the pool stores explicit names only. A pattern is a search aid of `
        + `\`${tool} project-init <KEY> --pattern <glob> --dry-run\`, which lists the repositories it matches.`);
    }
    if (!isRepo(repo)) throw new UsageError(`'${repo}' is not <host>:<owner>/<name> with host github or gitlab (e.g. github:acme/web-ui)`);
    return repo;
  });
}

// == reading a document ==

function parsed(text) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new UsageError(`oikos.yaml does not parse: ${doc.errors[0].message.split('\n')[0]}`);
  return doc;
}

const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key);
const isNullNode = (node) => node === null || node === undefined || (YAML.isScalar(node) && node.value === null);

/** The pair of `map` under `key` (compared case-insensitively when `anyCase`), or undefined. */
function pairOf(map, key, anyCase = false) {
  return map.items.find((pair) => (anyCase ? lower(keyOf(pair)) === lower(key) : String(keyOf(pair)) === key));
}

/** The project's key as the file spells it, or `projectKey` upper-cased when the file has none. */
function projectKeyIn(doc, connector, projectKey) {
  const projects = doc.getIn([ROOT, connector, 'projects'], true);
  const pair = YAML.isMap(projects) ? pairOf(projects, projectKey, true) : undefined;
  return pair ? String(keyOf(pair)) : String(projectKey).trim().toUpperCase();
}

// == the intended change, on plain data ==

const asList = (value) => (Array.isArray(value) ? value : []);
const isPlainMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Refuse a repository given for `number_repos` (D11) that is in neither list of the project after the
 * change, or whose bare numbers another project of the connector holds — naming that project.
 */
function refuseNumberRepos(part, key, after, given, at) {
  const listed = [...asList(after.repos), ...asList(after.extended_repos)];
  for (const repo of given || []) {
    const owner = numberOwner(part, repo, key);
    if (owner) throw new UsageError(`'${repo}' carries the bare numbers of ${owner} (${at.replace(/[^.]+$/, owner)}.number_repos) — a repository's numbers belong to one project, so it is not added to ${at}.number_repos.`);
    if (!listed.some((r) => lower(r) === lower(repo))) {
      throw new UsageError(`'${repo}' is in neither ${at}.repos nor ${at}.extended_repos — add it to one of them first (repos add ${key} ${repo}, with --extended for the extended set); number_repos says only how its numbers match.`);
    }
  }
}

/**
 * Refuse a repository given for one list of the project (the pool or the extended set) that the
 * other list holds, or that the change gives for both: a repository belongs to one list. Moving it
 * between the lists is not an edit this module makes.
 */
function refuseCrossList(before, change, at) {
  const [pool, extended] = REPO_LISTS;
  for (const [list, other] of [[pool, extended], [extended, pool]]) {
    const held = [...asList(before?.[other]), ...(list === extended ? asList(change[other]) : [])];
    for (const repo of change[list] || []) {
      if (!held.some((r) => lower(r) === lower(repo))) continue;
      const where = asList(before?.[other]).some((r) => lower(r) === lower(repo)) ? `is already in ${at}.${other}` : `is given for ${other} too`;
      throw new UsageError(`'${repo}' ${where} — a repository belongs to one list, so it is not added to ${list}. `
        + 'Moving a repository between the lists is not done here: edit oikos.yaml by hand.');
    }
  }
}

/**
 * The project after `change`: the lists grown by the values not yet in them (compared
 * case-insensitively), the prose fields replaced, everything else as it was.
 */
function changedProject(before, change) {
  const after = { ...(before || {}) };
  const added = {};
  const present = {};
  for (const list of PROJECT_LISTS) {
    const had = asList(after[list]);
    added[list] = [];
    present[list] = [];
    const given = new Set();
    for (const value of change[list] || []) {
      if (given.has(lower(value))) continue; // the same value given twice counts once
      given.add(lower(value));
      const known = had.some((v) => lower(v) === lower(value));
      (known ? present[list] : added[list]).push(value);
    }
    if (added[list].length) after[list] = [...had, ...added[list]];
  }
  for (const map of PROJECT_MAPS) {
    const had = isPlainMap(after[map]) ? after[map] : {};
    const grown = {};
    added[map] = [];
    present[map] = [];
    for (const [entry, value] of Object.entries(change[map] || {})) {
      const held = Object.keys(had).find((k) => k === entry);
      if (held !== undefined && lower(had[held]) === lower(value)) present[map].push(`${entry}: ${had[held]}`);
      else if (held !== undefined) {
        throw new UsageError(`${map}.${entry} is ${had[held]} already, not ${value} — an edit here only adds; change it in oikos.yaml by hand.`);
      } else if (!(entry in grown)) {
        grown[entry] = value;
        added[map].push(`${entry}: ${value}`);
      }
    }
    if (Object.keys(grown).length) after[map] = { ...had, ...grown };
  }
  const replaced = [];
  for (const field of PROJECT_TEXTS) {
    const value = change[field];
    if (value === undefined || value === null) continue;
    if (after[field] !== value) replaced.push(field);
    after[field] = value;
  }
  changedPolicy(after, change[PROJECT_POLICY], added, present, replaced);
  return { after, added, present, replaced };
}

/**
 * The project's policy after `given` ({ person_only, source }), into `after`: the statuses not yet in
 * `person_only` (compared case-insensitively) appended, `source` replaced; `added` / `present` name
 * the statuses under `policy`, `replaced` gets `policy.source` when its text changes.
 */
function changedPolicy(after, given, added, present, replaced) {
  added[PROJECT_POLICY] = [];
  present[PROJECT_POLICY] = [];
  if (!given) return;
  const had = isPlainMap(after[PROJECT_POLICY]) ? after[PROJECT_POLICY] : {};
  const statuses = asList(had.person_only);
  const seen = new Set();
  for (const status of given.person_only || []) {
    if (seen.has(lower(status))) continue;
    seen.add(lower(status));
    (statuses.some((s) => lower(s) === lower(status)) ? present : added)[PROJECT_POLICY].push(status);
  }
  const next = { ...had };
  if (added[PROJECT_POLICY].length) next.person_only = [...statuses, ...added[PROJECT_POLICY]];
  if (given.source !== undefined && given.source !== null && had.source !== given.source) {
    next.source = given.source;
    replaced.push(POLICY_SOURCE);
  }
  if (added[PROJECT_POLICY].length || replaced.includes(POLICY_SOURCE)) after[PROJECT_POLICY] = next;
}

// == splicing into the source ==

/** The text of `value` as one YAML scalar, safe in a flow collection when `flow`. */
function scalarText(value, { flow = false } = {}) {
  if (typeof value === 'string' && value.includes('\n')) return JSON.stringify(value);
  const doc = new YAML.Document(flow ? [value] : value);
  if (flow) doc.contents.flow = true;
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trim();
  return flow ? text.slice(1, -1) : text;
}

/** `value` (a mapping) as block YAML whose lists are flow `[a, b]`, its lines indented by `indent`. */
function blockText(value, indent) {
  const doc = new YAML.Document(value);
  YAML.visit(doc, { Seq: (_, node) => { node.flow = true; } });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false, indent: INDENT }).trimEnd()
    .split('\n').map((line) => `${' '.repeat(indent)}${line}`).join('\n');
}

/** `value` (a mapping's entries) as the inside of a flow mapping: `a: [x], b: y`. */
function flowEntries(value) {
  const doc = new YAML.Document(value);
  YAML.visit(doc, { Map: (_, node) => { node.flow = true; }, Seq: (_, node) => { node.flow = true; } });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trim().slice(1, -1);
}

const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (text, at) => {
  const end = text.indexOf('\n', at);
  return end < 0 ? text.length : end;
};
const column = (text, at) => at - lineStart(text, at);
/** Where a node's content ends, without the line breaks a block node's range carries. */
function contentEnd(text, node) {
  let end = node.range[1];
  while (end > node.range[0] && /\s/.test(text[end - 1])) end -= 1;
  return end;
}

/** One splice: replace `[from, to)` of the source with `insert`. */
const splice = (from, to, insert) => ({ from, to, insert });

/** The splice that appends `values` to the list node `seq`. */
function appendToSeq(text, seq, values) {
  if (seq.flow) {
    const close = text.lastIndexOf(']', seq.range[1]);
    let at = close;
    while (at > seq.range[0] + 1 && /\s/.test(text[at - 1])) at -= 1;
    const items = values.map((v) => scalarText(v, { flow: true })).join(', ');
    return splice(at, at, `${seq.items.length ? ', ' : ''}${items}`);
  }
  const last = seq.items[seq.items.length - 1];
  const dash = ' '.repeat(column(text, seq.range[0]));
  const at = lineEnd(text, contentEnd(text, last));
  return splice(at, at, values.map((v) => `\n${dash}- ${scalarText(v)}`).join(''));
}

/** The splice that adds the entries of `value` (a plain object) to the mapping node `map`. */
function addToMap(text, map, value) {
  if (map.flow || !map.items.length) {
    const close = text.lastIndexOf('}', map.range[1]);
    let at = close;
    while (at > map.range[0] + 1 && /\s/.test(text[at - 1])) at -= 1;
    return splice(at, at, `${map.items.length ? ', ' : ''}${flowEntries(value)}`);
  }
  const indent = column(text, map.items[0].key.range[0]);
  const last = map.items[map.items.length - 1];
  const at = lineEnd(text, contentEnd(text, last.value ?? last.key));
  return splice(at, at, `\n${blockText(value, indent)}`);
}

/** The splice that gives the pair `pair`, whose value is empty (null), the mapping `value`. */
function fillPair(text, pair, value) {
  const indent = column(text, pair.key.range[0]) + INDENT;
  const empty = pair.value;
  const from = empty?.range && empty.range[1] > empty.range[0] ? empty.range[0] : null;
  const at = lineEnd(text, from ?? pair.key.range[1]);
  if (from === null) return [splice(at, at, `\n${blockText(value, indent)}`)];
  // An explicit `null` or `~` after the key goes, with the blank before it: the mapping takes its
  // place on the next lines.
  let start = from;
  while (start > 0 && text[start - 1] === ' ') start -= 1;
  return [splice(start, empty.range[1], ''), splice(at, at, `\n${blockText(value, indent)}`)];
}

/** The splices that add `value` under `path` (from the top level), creating what is missing. */
function addUnder(text, doc, path, value) {
  let node = doc.contents;
  if (!YAML.isMap(node)) {
    if (!isNullNode(node)) throw new UsageError('oikos.yaml: the top level must be a mapping');
    return [splice(text.length, text.length, `${text && !text.endsWith('\n') ? '\n' : ''}${blockText(nest(path, value), 0)}\n`)];
  }
  for (let i = 0; i < path.length; i += 1) {
    const pair = pairOf(node, path[i]);
    const rest = nest(path.slice(i + 1), value);
    if (!pair) {
      if (node === doc.contents && !node.flow) {
        // A new top-level part goes at the end of the file, after whatever comments close it.
        return [splice(text.length, text.length, `${text && !text.endsWith('\n') ? '\n' : ''}${blockText({ [path[i]]: rest }, 0)}\n`)];
      }
      return [addToMap(text, node, { [path[i]]: rest })];
    }
    if (isNullNode(pair.value)) return fillPair(text, pair, rest);
    if (!YAML.isMap(pair.value)) throw new UsageError(`oikos.yaml: ${path.slice(0, i + 1).join('.')} must be a mapping`);
    node = pair.value;
  }
  return [addToMap(text, node, value)];
}

const nest = (path, value) => path.reduceRight((inner, key) => ({ [key]: inner }), value);

/** The splices that turn the existing project mapping `project` into `after`. */
function editProjectNode(text, project, after, added, replaced) {
  const splices = [];
  const missing = {};
  for (const list of PROJECT_LISTS) {
    if (!added[list].length) continue;
    const pair = pairOf(project, list);
    if (!pair || isNullNode(pair.value)) {
      if (pair) throw new UsageError(`oikos.yaml: ${list} of the project is empty — write it as a list or remove the key`);
      missing[list] = after[list];
    } else if (YAML.isSeq(pair.value)) splices.push(appendToSeq(text, pair.value, added[list]));
    else throw new UsageError(`oikos.yaml: ${list} of the project must be a list`);
  }
  for (const map of PROJECT_MAPS) {
    if (!added[map].length) continue;
    const pair = pairOf(project, map);
    const grown = Object.fromEntries(Object.entries(after[map]).filter(([entry]) => !(pair && YAML.isMap(pair.value) && pairOf(pair.value, entry))));
    if (!pair) missing[map] = after[map];
    else if (isNullNode(pair.value)) throw new UsageError(`oikos.yaml: ${map} of the project is empty — write it as a mapping or remove the key`);
    else if (YAML.isMap(pair.value)) splices.push(addToMap(text, pair.value, grown));
    else throw new UsageError(`oikos.yaml: ${map} of the project must be a mapping`);
  }
  if (added[PROJECT_POLICY].length || replaced.includes(POLICY_SOURCE)) {
    const change = { statuses: added[PROJECT_POLICY], source: replaced.includes(POLICY_SOURCE) };
    splices.push(...policySplices(text, project, after[PROJECT_POLICY], change, missing));
  }
  for (const field of replaced.filter((f) => PROJECT_TEXTS.includes(f))) {
    const pair = pairOf(project, field);
    const value = scalarText(after[field], { flow: Boolean(project.flow) });
    const node = pair?.value;
    if (!pair) missing[field] = after[field];
    else if (node?.range && node.range[1] > node.range[0]) splices.push(splice(node.range[0], contentEnd(text, node), value));
    else {
      // `results:` with nothing after it: the value goes right after the colon, before any comment.
      const colon = text.indexOf(':', pair.key.range[1]) + 1;
      splices.push(splice(colon, colon, ` ${value}`));
    }
  }
  if (Object.keys(missing).length) splices.push(addToMap(text, project, missing));
  return splices;
}

/** The text of a scalar node `node` of the pair `pair`, replaced by `value`, or set when it is empty. */
function scalarSplice(text, pair, value) {
  const node = pair.value;
  if (node?.range && node.range[1] > node.range[0]) return splice(node.range[0], contentEnd(text, node), value);
  // `results:` with nothing after it: the value goes right after the colon, before any comment.
  const colon = text.indexOf(':', pair.key.range[1]) + 1;
  return splice(colon, colon, ` ${value}`);
}

/**
 * The splices that bring the project's `policy` to `policy`: `change.statuses` appended to
 * `person_only`, `source` replaced when `change.source` is set; a missing `policy` goes into `missing` whole.
 */
function policySplices(text, project, policy, { statuses, source }, missing) {
  const pair = pairOf(project, PROJECT_POLICY);
  if (!pair) {
    missing[PROJECT_POLICY] = policy;
    return [];
  }
  if (isNullNode(pair.value)) throw new UsageError('oikos.yaml: policy of the project is empty — write it as a mapping or remove the key');
  if (!YAML.isMap(pair.value)) throw new UsageError('oikos.yaml: policy of the project must be a mapping');
  const node = pair.value;
  const splices = [];
  const grown = {};
  if (statuses.length) {
    const list = pairOf(node, 'person_only');
    if (!list) grown.person_only = policy.person_only;
    else if (YAML.isSeq(list.value)) splices.push(appendToSeq(text, list.value, statuses));
    else throw new UsageError('oikos.yaml: policy.person_only of the project must be a list');
  }
  if (source) {
    const held = pairOf(node, 'source');
    if (!held) grown.source = policy.source;
    else splices.push(scalarSplice(text, held, scalarText(policy.source, { flow: Boolean(node.flow) })));
  }
  if (Object.keys(grown).length) splices.push(addToMap(text, node, grown));
  return splices;
}

function applied(text, splices) {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.from - a.from)) out = `${out.slice(0, s.from)}${s.insert}${out.slice(s.to)}`;
  return out;
}

/**
 * `text` (an `oikos.yaml`) with the project `projectKey` of `connector` changed: the lists
 * (`PROJECT_LISTS`) grown by the values not in them yet (a repository the other repository list
 * holds is refused; so is one for `number_repos` outside both lists, or whose numbers another
 * project holds), `epic_roles` grown by new roles (a role held with another epic is refused),
 * `results` and `epics` replaced, `policy.person_only` grown and `policy.source` replaced; the project block (and `task-tracking`, the connector, `projects`
 * above it) created when missing. Only the touched nodes' text changes. Throws a usage error when the
 * result would not parse to the intended configuration or the `task-tracking` part would have
 * problems — naming them.
 *
 * @param {string} text the file's text ('' for none)
 * @param {string} connector a tracker connector, e.g. jira
 * @param {string} projectKey the project, e.g. PROJ (an existing key matches case-insensitively)
 * @param {{ key_aliases?: string[], repos?: string[], extended_repos?: string[], number_repos?: string[], number_patterns?: string[],
 *   epic_projects?: string[], epic_roles?: Object<string, string>, results?: string, epics?: string,
 *   policy?: { person_only?: string[], source?: string } }} change
 * @returns {{ text: string, key: string, before: object|null, after: object, added: object, present: object, replaced: string[], changed: boolean }}
 *   `added` / `present` name per list (and per mapping, as `role: KEY`) the values appended / already
 *   there (`policy` names statuses); `replaced` the prose fields whose text changes (`policy.source` among them); `changed` whether `text` differs from the input.
 */
export function editTrackerProject(text, connector, projectKey, change) {
  if (!TRACKERS.includes(connector)) throw new UsageError(`${connector} is not a tracker connector (one of ${TRACKERS.join(', ')})`);
  const doc = parsed(text);
  const key = projectKeyIn(doc, connector, projectKey);
  const path = [ROOT, connector, 'projects', key];
  const current = doc.toJS() || {};
  const before = current[ROOT]?.[connector]?.projects?.[key] ?? null;
  if (before !== null && (typeof before !== 'object' || Array.isArray(before))) {
    throw new UsageError(`oikos.yaml: ${path.join('.')} must be a mapping`);
  }
  refuseCrossList(before, change, path.join('.'));
  const { after, added, present, replaced } = changedProject(before, change);
  refuseNumberRepos(current[ROOT]?.[connector], key, after, added.number_repos, path.join('.'));
  const changed = [...PROJECT_LISTS, ...PROJECT_MAPS, PROJECT_POLICY].some((field) => added[field].length) || replaced.length > 0;
  if (!changed) return { text, key, before, after, added, present, replaced, changed };

  const project = doc.getIn(path, true);
  const splices = YAML.isMap(project) ? editProjectNode(text, project, after, added, replaced) : addUnder(text, doc, path, after);
  const out = applied(text, splices);

  const result = YAML.parseDocument(out);
  const intended = structuredClone(current);
  let at = intended;
  for (const segment of path.slice(0, -1)) at = (at[segment] ??= {});
  at[key] = after;
  if (result.errors.length || !isDeepStrictEqual(result.toJS() || {}, intended)) {
    throw new UsageError(`the edit of ${path.join('.')} could not keep the layout of oikos.yaml — nothing written; `
      + 'make the change by hand');
  }
  const problems = taskTrackingProblems(intended[ROOT]);
  if (problems.length) throw new UsageError(`nothing written — ${ROOT} would have problems: ${problems.join('; ')}`);
  return { text: out, key, before, after, added, present, replaced, changed };
}

/**
 * The source text of the project `projectKey` of `connector` in `text`, from its key to its last
 * line — what a dry run shows — or null when the file has no such project.
 *
 * @param {string} text the file's text
 * @param {string} connector a tracker connector, e.g. jira
 * @param {string} projectKey the project, e.g. PROJ
 * @returns {string|null}
 */
export function trackerProjectText(text, connector, projectKey) {
  const doc = parsed(text);
  const projects = doc.getIn([ROOT, connector, 'projects'], true);
  const pair = YAML.isMap(projects) ? pairOf(projects, projectKey, true) : undefined;
  if (!pair) return null;
  const end = pair.value?.range ? contentEnd(text, pair.value) : pair.key.range[1];
  return text.slice(lineStart(text, pair.key.range[0]), lineEnd(text, end));
}

/**
 * Write `text` to `file` atomically: a temporary file beside it, then a rename over it.
 *
 * @param {string} text the new content
 * @param {string} file the path to replace
 */
export function writeFileAtomic(text, file) {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
