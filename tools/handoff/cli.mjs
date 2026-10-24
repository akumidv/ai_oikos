#!/usr/bin/env node
// Parking a work package for another session (ADR 0005): the session's working files are copied
// to `.local/<task-key-lowercase>/` (or `.local/<slug>/` for work with no key), a HANDOFF.md
// skeleton is written there for the agent to fill, the task's line in `.local/TASKS.md` is
// upserted, and the one prompt that resumes it is printed. A local write of open, git-ignored
// files only (D03): it previews unless --yes, takes no --dry-run and is not a guarded write.
//
// What --from may name is the rule of `jira attach` (tools/common/local-files.mjs), shared: every
// file, a folder's each one, by its real path inside the installation or the session scratchpad,
// never in a closed store of `.local/`, never an `.env*` file, never under a dot-named entry outside
// a working folder of `.local/`. One refused entry refuses the park before anything is copied.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { installRoot, localPath, realOf } from '../common/paths.mjs';
import { HOME_OR_NETWORK, PRIVATE_FOLDER, fileRoots, inside, nameProblem, pathProblem } from '../common/local-files.mjs';
import { isStoreName } from '../hooks/host.mjs';

const TOOL = 'node oikos/tools/handoff/cli.mjs';
const HANDOFF = 'HANDOFF.md';
const BACKLOG = 'TASKS.md';
const TASK_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_ROOTS = 'the installation or the session scratchpad (the temporary folder)';
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

/** Throws when `given` would make a closed (isStoreName) or path-like folder name in `.local/`. */
function refuseFolderName(given) {
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

/**
 * The machine's temporary folder by its real path — where an agent host keeps its session
 * scratchpad (Claude Code: `<tmp>/claude-<uid>/<project>/<session>/scratchpad`) — or null when it
 * is the file system's root, the home folder or a folder holding it: a scratchpad is a temporary
 * folder, never the user's home.
 */
export function scratchRoot() {
  const tmp = realOrNull(tmpdir());
  if (!tmp || dirname(tmp) === tmp) return null;
  const home = realOrNull(homedir()) || resolve(homedir());
  return inside(home, tmp) ? null : tmp;
}

/** The roots --from is judged by: the installation (fileRoots) and the scratchpad (scratchRoot). */
function sourceRoots() {
  const roots = fileRoots(null, SOURCE_ROOTS);
  const scratch = scratchRoot();
  return { ...roots, allowed: scratch ? [...roots.allowed, scratch] : roots.allowed };
}

/**
 * The files of the --from `target` as { from, to, dir, files: [{ source, to, size }] }: a file, or
 * every file of a folder (symlinks followed, a loop refused), each by its real path through
 * pathProblem and by the path it is reached by through nameProblem. `to` keeps the names as given.
 */
function sourceOf(target, roots) {
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
    const problem = pathProblem(real, roots) || nameProblem(logical, roots);
    if (problem) throw refused(rel, problem);
    const stat = statSync(real);
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
 * What becomes of copying `file` to `dest`: { fate } new, same (identical content) or replace, or
 * { conflict, at } — a name taken by other content without `replace`, or by something not a file.
 */
function fateOf(file, dest, replace) {
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
  const conflicts = [];
  for (const f of sources.flatMap((s) => s.files)) {
    const r = fateOf(f, join(folder, f.to), replace);
    if (r.conflict) conflicts.push(`${relative(installRoot(), r.at)} ${r.conflict}`);
    f.fate = r.fate;
  }
  if (!conflicts.length) return;
  const more = conflicts.length > SHOWN_CONFLICTS ? `; and ${conflicts.length - SHOWN_CONFLICTS} more` : '';
  throw new UsageError(`Refusing to park: ${conflicts.slice(0, SHOWN_CONFLICTS).join('; ')}${more}. Nothing was copied.`);
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
  const folderReal = realOf(folder);
  const holding = sources.find((s) => s.dir && inside(folderReal, s.real));
  if (holding) throw new UsageError(`Refusing --from '${holding.from}': the package folder ${PRIVATE_FOLDER}/${pkg.folder}/ lies in it. Nothing was copied.`);
  judgeFates(sources, folder, replace);
  const backlog = localPath(BACKLOG);
  const before = existsSync(backlog) ? readFileSync(backlog, 'utf8') : null;
  const line = backlogLine(pkg, title || titleIn(before, pkg.key) || 'untitled');
  const handoff = existsSync(join(folder, HANDOFF)) || names.includes(HANDOFF) ? 'keep' : 'write';
  return { pkg, folder, sources, handoff, line, backlog: upsertLine(before, pkg.key, line), prompt: resumePrompt(pkg) };
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
    if (m && !isStoreName(m[4].split('/')[0])) Object.assign(entry(m[4].split('/')[0]), { line: text, key: m[1], title: m[2], status: m[3] });
  }
  for (const d of existsSync(local) ? readdirSync(local, { withFileTypes: true }) : []) {
    if (d.isDirectory() && !isStoreName(d.name) && existsSync(join(local, d.name, HANDOFF))) entry(d.name).handoff = true;
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
