#!/usr/bin/env node
// Parking a work package for another session (ADR 0005): the session's working files are copied
// to `.local/<task-key-lowercase>/` (or `.local/<slug>/` for work with no key), a HANDOFF.md
// skeleton is written there for the agent to fill, the task's line in `.local/TASKS.md` is
// upserted, and the one prompt that resumes it is printed. A local write of open, git-ignored
// files only (D03): it previews unless --yes, takes no --dry-run and is not a guarded write.
//
// What --from may name is the rule of `jira attach` (tools/common/local-files.mjs), shared: every
// file, a folder's each one, by its real path inside the installation or a scratch folder, never in
// a closed store of `.local/`, never an `.env*` file, never under a dot-named entry outside a working
// folder of `.local/`. A scratch folder is the one $OIKOS_SCRATCH names or a Claude Code session
// scratchpad of THIS installation (`<tmp>/claude-<uid>/<slug>/<session>/scratchpad`, D-PARK-SCRATCH) —
// not the temporary folder at large; it is no source itself and a file inside it is carried only when
// the current user owns it (scratchProblem); one that is, holds or lies in the home folder, or lies
// in a `.local/`, is no root at all ($TMPDIR can move it). One refused entry refuses the park before anything is copied,
// and so does a destination that would leave `.local/<package>/` through a symlink.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { installRoot, localPath, realOf } from '../common/paths.mjs';
import { FOLDS_CASE, HOME_OR_NETWORK, PRIVATE_FOLDER, fileRoots, inside, nameProblem, pathProblem, scratchProblem } from '../common/local-files.mjs';
import { isStoreName } from '../hooks/host.mjs';
import { DESK_FOLDER } from '../common/desk.mjs';

const TOOL = 'node oikos/tools/handoff/cli.mjs';
const HANDOFF = 'HANDOFF.md';
const BACKLOG = 'TASKS.md';
const TASK_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const LINE = /^- (\S+) · (.*) · (\S+) · \[handoff\]\(([^)]+)\)\s*$/;
const SHOWN_CONFLICTS = 5;
/** What the park does to `.local/TASKS.md`, by upsertLine's action. */
const BACKLOG_FATES = { create: 'created with the line', append: 'the line appended', replace: 'the line replaced', keep: 'the line already there' };

// == the package: its key and folder ==

/**
 * The package `values` (--task or --name) names, as { key, folder }: a task key uppercased, its
 * folder lowercased (`PROJ-123` → `proj-123`), or a slug as both. The folder is never a closed or
 * legacy store name of `.local/` (isStoreName, ADR 0002 D01) — the next session's file tools
 * could not read it — and never path-like.
 */
export function packageOf(values) {
  const { task, name } = values;
  if (Boolean(task) === Boolean(name)) throw new UsageError('name the package with one of --task KEY (e.g. PROJ-123) or --name <slug> (work with no task key)');
  refuseFolderName(task || name);
  if (task) {
    if (!TASK_KEY.test(task)) throw new UsageError(`--task '${task}' is not a task key like PROJ-123; work with no key takes --name <slug>`);
    return { key: task.toUpperCase(), folder: task.toLowerCase() };
  }
  const slug = name.toLowerCase();
  if (!SLUG.test(slug)) throw new UsageError(`--name '${name}': latin letters, digits and '-', starting with a letter or digit (e.g. api-review)`);
  return { key: slug, folder: slug };
}

/** Throws when `given` would make a closed (isStoreName) or path-like folder name in `.local/`, or the desk's folder. */
function refuseFolderName(given) {
  if (given.toLowerCase() === DESK_FOLDER) {
    throw new UsageError(`Refusing package '${given}': ${PRIVATE_FOLDER}/${DESK_FOLDER}/ is the desk agent's folder, not a package (ADR 0006 D03); choose another name`);
  }
  if (isStoreName(given) || isStoreName(given.toLowerCase())) {
    throw new UsageError(`Refusing package '${given}': it is a closed store name of ${PRIVATE_FOLDER}/ (a name starting with '.', or a legacy store such as browser, google in any case) — the next session could not read the folder; choose another name`);
  }
  if (/[\\/:]/.test(given) || given === '.' || given === '..') throw new UsageError(`Refusing package '${given}': a package is one folder name in ${PRIVATE_FOLDER}/, not a path`);
}

/** The resume prompt of the package `pkg`. */
export const resumePrompt = (pkg) => `Resume ${pkg.key}: read ${PRIVATE_FOLDER}/${pkg.folder}/${HANDOFF} and continue from "Next steps".`;

/** The `.local/TASKS.md` line of the package `pkg` (ADR 0005 D01). */
export const backlogLine = (pkg, title) => `- ${pkg.key} · ${title} · parked · [handoff](${pkg.folder}/${HANDOFF})`;

/**
 * The backlog `text` (null: no file yet) with `line` for `key`: { text, action } — the first line
 * starting with `- <key> ` replaced, else `line` appended; every other line kept as it is.
 */
export function upsertLine(text, key, line) {
  if (text == null) return { text: `${line}\n`, action: 'create' };
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`- ${key} `));
  if (at >= 0) {
    if (lines[at] === line) return { text, action: 'keep' };
    lines[at] = line;
    return { text: lines.join('\n'), action: 'replace' };
  }
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return { text: `${body}${line}\n`, action: 'append' };
}

// == the sources: every file judged before anything is copied ==

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const anyLocalFolder = (path) => path.split(/[\\/]/).some((part) => (FOLDS_CASE ? part.toLowerCase() : part) === PRIVATE_FOLDER);

/**
 * Why the real folder `path` is no source root, or null: it is the file system's root, the home
 * folder, a folder holding it or lying in it (a $TMPDIR pointed at `~/.ssh` would make the keys a
 * scratchpad), or it lies inside a `.local/` folder (any installation's closed stores).
 */
function scratchRefusal(path) {
  const home = realOrNull(homedir()) || resolve(homedir());
  if (dirname(path) === path) return `${path} is the root of the file system`;
  if (inside(path, home) || inside(home, path)) return `${path} is, holds or lies in the home folder ${home}`;
  if (anyLocalFolder(path)) return `${path} lies inside a ${PRIVATE_FOLDER}/ folder`;
  return null;
}

/** The folder name Claude Code gives the project at `root`: every `/` and `_` becomes `-`. */
export const projectSlug = (root) => root.replace(/[/_]/g, '-');

/** Whether `path` is a folder of the current user (any folder, where there is no user id). */
function ownedFolder(path, uid) {
  try {
    const stat = statSync(path);
    return stat.isDirectory() && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
}

/**
 * The scratch folder `path` as { root } by its real path, { refusal } when it exists but is unfit —
 * not the user's, or refused by scratchRefusal, or (`within` given) leading out of `within` through
 * a symlink — or {} when there is none.
 */
function fitScratch(path, uid, within) {
  const real = realOrNull(path);
  if (!real) return {};
  const refusal = !ownedFolder(real, uid)
    ? `${real} is not a folder of yours`
    : scratchRefusal(real) || (within && !inside(real, within) ? `${real} leads out of ${within}` : null);
  return refusal ? { refusal } : { root: real };
}

/** The names in the folder `path`, none where it cannot be read. */
function namesIn(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * The Claude Code session scratchpads of this installation, each judged by fitScratch:
 * `<tmp>/claude-<uid>/<slug>/<session>/scratchpad`, <tmp> the temporary folder (os.tmpdir(), which
 * $TMPDIR moves), <slug> the installation's path as projectSlug writes it, <session> any one folder.
 * None where there is no user id (Windows); the temporary folder itself refused (scratchRefusal) is
 * named, not used.
 */
function sessionScratchpads(uid) {
  const tmp = realOrNull(tmpdir());
  const refusal = tmp && scratchRefusal(tmp);
  if (refusal) return [{ refusal: `the temporary folder ${refusal}` }];
  if (!tmp || uid === undefined || !ownedFolder(join(tmp, `claude-${uid}`), uid)) return [];
  const slugs = new Set([installRoot(), realOrNull(installRoot() || '')].filter(Boolean).map(projectSlug));
  return [...slugs].flatMap((slug) => {
    const project = join(tmp, `claude-${uid}`, slug);
    return namesIn(project).map((session) => fitScratch(join(project, session, 'scratchpad'), uid, tmp));
  });
}

/**
 * The folders a --from file may come from besides the installation (ADR 0005 D02, D-PARK-SCRATCH), as
 * { roots, refusals }: the folder `env.OIKOS_SCRATCH` names, when set, and this installation's Claude
 * Code session scratchpads (sessionScratchpads). Each root passes fitScratch; a refused one is named in
 * `refusals`, for the refusal of a source that lay only there.
 */
export function scratchRoots(env, uid) {
  const named = env.OIKOS_SCRATCH ? fitScratch(resolve(env.OIKOS_SCRATCH), uid) : {};
  const own = env.OIKOS_SCRATCH && !named.root && !named.refusal ? { refusal: `${env.OIKOS_SCRATCH} does not exist` } : named;
  const fits = [own, ...sessionScratchpads(uid)];
  return {
    roots: fits.filter((f) => f.root).map((f) => f.root),
    refusals: fits.filter((f) => f.refusal).map((f) => (f === own ? `$OIKOS_SCRATCH ${f.refusal}` : f.refusal)),
  };
}

/** What a park's --from may name outside the installation, as a refusal says it. */
const scratchWhere = (uid) => `the installation, this installation's session scratchpad (${join(tmpdir(), `claude-${uid ?? '<uid>'}`, projectSlug(installRoot() || '<installation>'), '<session>', 'scratchpad')}) or $OIKOS_SCRATCH`;

/**
 * The roots --from is judged by: the installation (fileRoots) and the scratch folders (scratchRoots,
 * also as `scratch`, with the current user's id as `uid` — undefined where there is none). The
 * scratch folders refused as roots are named in `scratchRefusal`, for the refusal of a source that
 * lay only there.
 */
function sourceRoots() {
  const uid = process.getuid?.();
  const roots = fileRoots(null, scratchWhere(uid));
  const { roots: scratch, refusals } = scratchRoots(process.env, uid);
  return { ...roots, allowed: [...roots.allowed, ...scratch], scratch, uid, scratchRefusal: refusals.join('; ') };
}

/** pathProblem of the real `path`, naming the scratch folders refused as roots (`roots.scratchRefusal`) when `path` is outside the roots. */
function outsideProblem(path, roots) {
  const problem = pathProblem(path, roots);
  return problem && roots.scratchRefusal && problem.startsWith('it resolves outside')
    ? `${problem}; not taken as a source root: ${roots.scratchRefusal}`
    : problem;
}

/**
 * The files of the --from `target` as { from, to, dir, files: [{ source, to, size }] }: a file, or
 * every file of a folder (symlinks followed, a loop refused), each by its real path through
 * pathProblem and by the path it is reached by through nameProblem; the temporary folder itself and
 * a file's owner through scratchProblem (`roots.scratch`, `roots.uid`). `to` keeps the names as given.
 */
export function sourceOf(target, roots) {
  const top = basename(resolve(roots.base, target));
  const refused = (rel, why) => new UsageError(`Refusing --from '${target}'${rel === top ? '' : ` (${rel})`}: ${why}. Nothing was copied.`);
  if (HOME_OR_NETWORK.test(target)) throw refused(top, `a home or network path is not read — name a file or folder in ${roots.where}`);
  const files = [];
  const walk = (logical, rel, ancestors) => {
    let real;
    try {
      real = realpathSync(logical);
    } catch (e) {
      throw refused(rel, `the path cannot be resolved (${e.code || e.message})`);
    }
    const stat = statSync(real);
    const problem = outsideProblem(real, roots) || nameProblem(logical, roots) || scratchProblem(real, stat, roots);
    if (problem) throw refused(rel, problem);
    if (stat.isFile()) {
      files.push({ source: real, to: rel, size: stat.size });
      return;
    }
    if (!stat.isDirectory()) throw refused(rel, 'it is neither a file nor a folder');
    if (ancestors.includes(real)) throw refused(rel, 'a symlink leads back into its own folder');
    for (const entry of readdirSync(real).sort()) walk(join(logical, entry), `${rel}/${entry}`, [...ancestors, real]);
  };
  const given = resolve(roots.base, target);
  walk(given, top, []);
  return { from: target, to: top, dir: statSync(given).isDirectory(), real: realpathSync(given), files };
}

/**
 * Why writing `dest` would not stay in the package folder `folderReal` (its real path), or null:
 * `dest` is itself a symlink, or its nearest existing ancestor resolves (realOf) outside the folder
 * — a symlinked subfolder leads out of `.local/<package>/`.
 */
function escapeOf(dest, folderReal) {
  if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) return 'is a symlink — a park writes plain files only';
  const real = realOf(dest);
  return inside(real, folderReal) ? null : `resolves outside the package folder (${real})`;
}

/** Throws, naming the first of `conflicts`, when there are any: the refusal of a park that would not stay in its folder. */
function refuseConflicts(conflicts) {
  if (!conflicts.length) return;
  const more = conflicts.length > SHOWN_CONFLICTS ? `; and ${conflicts.length - SHOWN_CONFLICTS} more` : '';
  throw new UsageError(`Refusing to park: ${conflicts.slice(0, SHOWN_CONFLICTS).join('; ')}${more}. Nothing was copied.`);
}

/**
 * What becomes of copying `file` to `dest`: { fate } new, same (identical content) or replace, or
 * { conflict, at } — a name taken by other content without `replace`, or by something not a file, or
 * a destination that leaves the package folder `folderReal` (escapeOf).
 */
function fateOf(file, dest, replace, folderReal) {
  const escaped = escapeOf(dest, folderReal);
  if (escaped) return { at: dest, conflict: escaped };
  let at = dirname(dest);
  while (!existsSync(at)) at = dirname(at);
  if (!statSync(at).isDirectory()) return { at, conflict: 'is not a folder' };
  const there = lstatSync(dest, { throwIfNoEntry: false });
  if (!there) return { fate: 'new' };
  if (!there.isFile()) return { at: dest, conflict: 'exists and is not a plain file' };
  if (readFileSync(dest).equals(readFileSync(file.source))) return { fate: 'same' };
  return replace ? { fate: 'replace' } : { at: dest, conflict: 'exists with other content (--replace overwrites it)' };
}

/** Sets each file's fate (fateOf) in `folder`; throws, naming the first conflicts, when any name is taken. */
function judgeFates(sources, folder, replace) {
  const folderReal = realOf(folder);
  const conflicts = [];
  for (const f of sources.flatMap((s) => s.files)) {
    const r = fateOf(f, join(folder, f.to), replace, folderReal);
    if (r.conflict) conflicts.push(`${relative(installRoot(), r.at)} ${r.conflict}`);
    f.fate = r.fate;
  }
  refuseConflicts(conflicts);
}

/** Throws when the package `folder` is a symlink: a park writes inside the real folder `.local/<package>/` only. */
function refuseSymlinkedFolder(folder) {
  if (!lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  throw new UsageError(`Refusing to park: ${relative(installRoot(), folder)} is a symlink, not a folder of ${PRIVATE_FOLDER}/. Nothing was copied.`);
}

/**
 * Throws when HANDOFF.md (`handoff` is 'write') or the backlog (its `action` is not 'keep') would be
 * written through a symlink, or out of the package folder / out of `.local/` (a symlinked `.local/`
 * itself is followed): judged before anything is written.
 */
function judgeWrites(folder, handoff, backlog) {
  const conflicts = [];
  const check = (dest, root) => {
    const escaped = escapeOf(dest, root);
    if (escaped) conflicts.push(`${relative(installRoot(), dest)} ${escaped}`);
  };
  if (handoff === 'write') check(join(folder, HANDOFF), realOf(folder));
  if (backlog.action !== 'keep') check(localPath(BACKLOG), realOf(localPath()));
  refuseConflicts(conflicts);
}

/**
 * The park of `pkg`: the sources of `targets`, each file's fate in `folder`, the HANDOFF.md action
 * and the backlog line — judged in full before anything is written; throws on any refusal.
 */
function planOf(pkg, targets, { title, replace }) {
  const roots = sourceRoots();
  const folder = localPath(pkg.folder);
  const sources = targets.map((t) => sourceOf(t, roots));
  const names = sources.map((s) => s.to);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new UsageError(`Refusing to park: two --from give the name '${twice}' in ${PRIVATE_FOLDER}/${pkg.folder}/. Nothing was copied.`);
  refuseSymlinkedFolder(folder);
  const folderReal = realOf(folder);
  const holding = sources.find((s) => s.dir && inside(folderReal, s.real));
  if (holding) throw new UsageError(`Refusing --from '${holding.from}': the package folder ${PRIVATE_FOLDER}/${pkg.folder}/ lies in it. Nothing was copied.`);
  judgeFates(sources, folder, replace);
  const backlogFile = localPath(BACKLOG);
  const before = existsSync(backlogFile) ? readFileSync(backlogFile, 'utf8') : null;
  const line = backlogLine(pkg, title || titleIn(before, pkg.key) || 'untitled');
  const handoff = existsSync(join(folder, HANDOFF)) || names.includes(HANDOFF) ? 'keep' : 'write';
  const backlog = upsertLine(before, pkg.key, line);
  judgeWrites(folder, handoff, backlog);
  return { pkg, folder, sources, handoff, line, backlog, prompt: resumePrompt(pkg) };
}

/** The title in the backlog `text`'s line for `key`, or null. */
function titleIn(text, key) {
  const found = (text || '').split('\n').find((l) => l.startsWith(`- ${key} `));
  return found ? found.split(' · ')[1] || null : null;
}

// == HANDOFF.md ==

const bytes = (files) => files.reduce((n, f) => n + f.size, 0);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What a source is in "Where things are": its name, size and, for a folder, its file count. */
const sourceSummary = (s) => (s.dir ? `\`${s.to}/\` — ${plural(s.files.length, 'file')}, ${bytes(s.files)} bytes` : `\`${s.to}\` — ${bytes(s.files)} bytes`);

/** The HANDOFF.md skeleton of `plan` (ADR 0005 D01): the five headings, the copied files, the resume prompt. */
export function skeleton(plan, title) {
  return [
    `# ${plan.pkg.key} — ${title}`,
    '',
    '## Where things are',
    ...plan.sources.map((s) => `- ${sourceSummary(s)}: <what it is>`),
    '- <outside this folder: vault notes, branches, pull requests, tracker comments, drafts — by link>',
    '',
    '## Agreed rules',
    '<what the user asked for and ruled out: language, tone, scope, what not to touch>',
    '',
    '## Decisions',
    '<each decision made, with why, and what was rejected>',
    '',
    '## Next steps',
    '1. <the next concrete action>',
    '',
    '## How to start',
    '<what to read first, what to check live before acting (statuses, open pull requests)>',
    '',
    'To resume, start a session with:',
    '',
    `    ${plan.prompt}`,
    '',
  ].join('\n');
}

// == park: preview, or copy and write ==

/** The fates of a source's files, counted: `2 new, 1 replaced`. */
function fates(files) {
  const count = (fate) => files.filter((f) => f.fate === fate).length;
  return [[count('new'), 'new'], [count('replace'), 'replaced'], [count('same'), 'unchanged']]
    .filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(', ') || 'empty';
}

/** The lines that say what the park of `plan` copies and writes. */
function planLines(plan, written) {
  const at = `${PRIVATE_FOLDER}/${plan.pkg.folder}/`;
  const handoff = plan.handoff === 'write'
    ? `  ${HANDOFF}: the skeleton — five headings, the copied files, the resume prompt; the agent fills the rest`
    : `  ${HANDOFF}: kept as it is — add the newly copied files under "Where things are"`;
  return [
    `${written ? 'Parked' : 'Would park'} ${plan.pkg.key} in ${at}:`,
    ...plan.sources.map((s) => `  ${s.to}${s.dir ? '/' : ''} ← ${s.from}: ${s.dir ? `${plural(s.files.length, 'file')}, ` : ''}${bytes(s.files)} bytes — ${fates(s.files)}`),
    handoff,
    `  ${PRIVATE_FOLDER}/${BACKLOG}: ${BACKLOG_FATES[plan.backlog.action]}`,
    `    ${plan.line}`,
  ];
}

/** Copy the files of `plan`, write the skeleton when there is none, write the backlog. */
function writePlan(plan, title) {
  mkdirSync(plan.folder, { recursive: true });
  for (const f of plan.sources.flatMap((s) => s.files)) {
    if (f.fate === 'same') continue;
    const dest = join(plan.folder, f.to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(f.source, dest);
  }
  if (plan.handoff === 'write') writeFileSync(join(plan.folder, HANDOFF), skeleton(plan, title), { flag: 'wx' });
  if (plan.backlog.action !== 'keep') writeFileSync(localPath(BACKLOG), plan.backlog.text);
}

/** The JSON of `plan`. */
const planJson = (plan, written) => ({
  key: plan.pkg.key,
  folder: `${PRIVATE_FOLDER}/${plan.pkg.folder}/`,
  sources: plan.sources.map((s) => ({ from: s.from, to: s.to, dir: s.dir, files: s.files.map((f) => ({ to: f.to, size: f.size, fate: f.fate })) })),
  handoff: plan.handoff,
  backlog: { action: plan.backlog.action, line: plan.line },
  prompt: plan.prompt,
  written,
});

// == list: the parked packages ==

/** The packages in `.local/`: each folder with a HANDOFF.md and each backlog line with a handoff link, by folder. */
function parkedPackages() {
  const local = localPath();
  const byFolder = new Map();
  const entry = (folder) => byFolder.get(folder) || byFolder.set(folder, { folder, line: null, handoff: false }).get(folder);
  const backlog = localPath(BACKLOG);
  for (const text of existsSync(backlog) ? readFileSync(backlog, 'utf8').split('\n') : []) {
    const m = text.match(LINE);
    if (m && !isStoreName(m[4].split('/')[0]) && m[4].split('/')[0] !== DESK_FOLDER) Object.assign(entry(m[4].split('/')[0]), { line: text, key: m[1], title: m[2], status: m[3] });
  }
  for (const d of existsSync(local) ? readdirSync(local, { withFileTypes: true }) : []) {
    // The desk is its own tool's folder, not a parked package (ADR 0006 D03).
    if (d.isDirectory() && !isStoreName(d.name) && d.name !== DESK_FOLDER && existsSync(join(local, d.name, HANDOFF))) entry(d.name).handoff = true;
  }
  return [...byFolder.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

/** One line of `list` for the package `p`. */
function packageLine(p) {
  const what = p.line ? `${p.key} · ${p.title} · ${p.status}` : `(no line in ${PRIVATE_FOLDER}/${BACKLOG})`;
  const where = p.handoff ? `${PRIVATE_FOLDER}/${p.folder}/${HANDOFF}` : `${HANDOFF} missing in ${PRIVATE_FOLDER}/${p.folder}/`;
  return `${p.folder}  ${what} — ${where}`;
}

const commands = {
  park: {
    help: 'park a work package: park --task KEY | --name SLUG [--title T] --from PATH… [--replace]; preview unless --yes',
    options: {
      task: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' },
      from: { type: 'string', multiple: true }, replace: { type: 'boolean' }, yes: { type: 'boolean' },
    },
    run(values) {
      const pkg = packageOf(values);
      if (!values.from?.length) throw new UsageError('--from <file or folder> is required, once per source (the session scratchpad\'s working files)');
      if (values.title != null && /[\r\n]/.test(values.title)) throw new UsageError('--title is one line');
      const plan = planOf(pkg, values.from, { title: values.title?.trim(), replace: values.replace });
      const title = plan.line.split(' · ')[1];
      if (values.yes) writePlan(plan, title);
      if (values.json) return printJson(planJson(plan, Boolean(values.yes)));
      for (const l of planLines(plan, values.yes)) console.log(l);
      if (!values.yes) return console.log('preview only — nothing written; --yes parks it');
      console.log(`\n${plan.prompt}`);
    },
  },
  list: {
    help: `the parked packages: folders of ${PRIVATE_FOLDER}/ with a ${HANDOFF} and ${PRIVATE_FOLDER}/${BACKLOG} lines with a handoff link`,
    options: {},
    run(values) {
      const found = parkedPackages();
      if (values.json) return printJson(found);
      if (!found.length) return console.log(`no parked packages — park one: ${TOOL} park --task KEY --from …`);
      for (const p of found) console.log(packageLine(p));
    },
  },
};

if (isMain(import.meta.url)) runCli('handoff', commands);
