// What a shell command may do at the boundary of an installation (ADR 0007 D02 and D05), judged from
// the command's text through the shared parser (shell.mjs). Three rules, in this order:
//
//   1. an installation writes only into itself: a redirection into a mount, or a `git` call that
//      writes (any subcommand not on the read allow-list) into a mount, is denied. The repository
//      a `git` call works in is taken from `-C`, `--git-dir`, `--work-tree`, the variables
//      `GIT_DIR` and `GIT_WORK_TREE` and a `cd` before it. A call that recurses into submodules
//      (`submodule foreach|update`, `--recurse-submodules`) or runs `clean -ff`, in this installation,
//      writes into every inside mount; a read that carries `-c`, `--config-env` or the variables
//      that do the same counts as a write, since a configuration value can run code
//      (`core.fsmonitor`);
//   2. a search whose scope is a folder above this installation's root is denied — it would reach
//      every installation beside it (F10). A search without a path searches the folder it runs in;
//   3. any command, whatever the program, that names a path in another installation that is not
//      registered as a mount is denied (F10);
//   and a redirection into a file with more than one hard link is denied with rule 1: the other name
//   of the file may lie in a mount (D02).
//
// Paths are judged as D02 says: real, component by component (`realOf`), contained by the identity
// of the folders above them (boundary.mjs). Best effort against accidents, like every shell guard:
// what a command substitution or a script expands to is not looked at, a variable only when it is
// `~`, `$HOME`, `$PWD` or one the command itself sets (`V=vault; git -C $V …`), and a `cd` whose
// target cannot be read leaves the relative words after it unjudged. A word with an expansion is
// judged by the folder before the first expansion character (a glob at its start: by the folder it is
// read from), and a relative word only when its first name is a folder or a link of the folder it is
// read from (anything else is new, below that folder). A command in a substitution inside double quotes
// is judged as a command of its own. A git write is also judged by the paths it names (`git rm -r vault`).
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { shellSegments } from './common.mjs';
import { assignedVars, dirsAlong, gitCalls, gitPlacesAll, homed, quotedSubstitutions, redirectionTargets, unique, withoutRedirections, withVariables } from './shell.mjs';
import { aboveInstallation, foreignInstallation, hardLinked, hardLinkReason, inside, mountHolding, scopeReason } from './boundary.mjs';
import { idOf, realOf } from '../common/paths.mjs';

const EXPANSION = /[$`*?[{]/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const MAX_DEPTH = 3;
const MAX_WORD = 4096;

/** The git subcommands that only read; any other subcommand counts as a write. */
const GIT_READS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'blame', 'annotate',
  'grep', 'describe', 'shortlog', 'whatchanged', 'show-ref', 'show-branch', 'for-each-ref', 'name-rev', 'merge-base', 'diff-tree',
  'diff-files', 'diff-index', 'check-ignore', 'check-attr', 'check-ref-format', 'var', 'version', 'help', 'count-objects',
  'verify-commit', 'verify-tag', 'cherry', 'range-diff', 'get-tar-commit-id',
]);
const positionals = (words) => words.filter((word) => !word.startsWith('-'));
const hasFlag = (words, pattern) => words.some((word) => pattern.test(word));
/** Whether `git config` reads: a get or list (also as the subcommands of git 2.46), or a lone key; `edit`, `set`, `unset` and the section and option flags write. */
function configReads(rest) {
  const [first] = positionals(rest);
  if (['edit', 'set', 'unset', 'rename-section', 'remove-section'].includes(first)) return false;
  if (hasFlag(rest, /^--(?:add|unset|unset-all|replace-all|edit|rename-section|remove-section)$|^-e$/)) return false;
  return ['get', 'list'].includes(first) || hasFlag(rest, /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/) || positionals(rest).length <= 1;
}
/** Subcommands that read in some forms: the form is told from the words after the subcommand. */
const GIT_FORMS = {
  branch: (rest) => !hasFlag(rest, /^(?:-[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))\b/)
    && (positionals(rest).length === 0 || hasFlag(rest, /^(?:-[lar]|--list|--all|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at)\b/)),
  tag: (rest) => !hasFlag(rest, /^(?:-[dasfmFu]|--(?:delete|annotate|sign|force|local-user))\b/) && (positionals(rest).length === 0 || hasFlag(rest, /^(?:-l|--list)$/)),
  remote: (rest) => positionals(rest).length === 0 || ['show', 'get-url'].includes(positionals(rest)[0]),
  config: configReads,
  stash: (rest) => ['list', 'show'].includes(positionals(rest)[0]),
  worktree: (rest) => positionals(rest)[0] === 'list',
  submodule: (rest) => positionals(rest).length === 0 || ['status', 'summary'].includes(positionals(rest)[0]),
  reflog: (rest) => !['expire', 'delete'].includes(positionals(rest)[0]),
  notes: (rest) => positionals(rest).length === 0 || ['list', 'show'].includes(positionals(rest)[0]),
};

/** Whether a git call only reads — `--output` writes a file, and a call with no subcommand (`git --version`) reads. */
function gitReads({ sub, rest }) {
  if (sub === undefined) return true;
  if (hasFlag(rest, /^--output(?:=|$)/)) return false;
  if (sub in GIT_FORMS) return GIT_FORMS[sub](rest);
  return GIT_READS.has(sub);
}

/** How many times `-f`/`--force` appears among the words, a combined `-ffdx` counting each `f`. */
function forces(words) {
  let count = 0;
  for (const word of words) {
    if (word === '--force') count++;
    else if (/^-[A-Za-z]+$/.test(word)) count += word.split('f').length - 1;
  }
  return count;
}

/** Whether a git call recurses into submodules or removes nested repositories, so it reaches the mounts below the folder it runs in. */
function gitRecurses({ sub, rest }) {
  if (hasFlag(rest, /^--recurse-submodules(?:=|$)/) || (sub === 'clone' && rest.includes('--recursive'))) return true;
  if (sub === 'submodule') return ['foreach', 'update', 'deinit', 'absorbgitdirs', 'sync', 'set-url'].includes(positionals(rest)[0]);
  return sub === 'clean' && forces(rest) >= 2;
}

/** A word that is no glob though it starts with a bracket or a brace: `[` and `]` of `test`, a `{` of a block. */
const BRACKETS = /^[[\]{}]+$/;

/**
 * The path `word` names, to be resolved from the folder the command runs in, with whether an expansion
 * made it the folder before the expansion; null when nothing can be told (it starts with a variable or
 * a substitution, or is a `~user`). A word that starts with a glob is the folder it is read from, any of
 * whose entries it may name.
 */
function named(word) {
  const text = homed(word);
  if (text === null) return null;
  const cut = text.search(EXPANSION);
  if (cut === 0) return /^[*?[{]/.test(text) && !BRACKETS.test(text) ? { text: '.', expands: true } : null;
  if (cut < 0) return { text, expands: false };
  return { text: text.slice(0, text.lastIndexOf('/', cut) + 1) || '.', expands: true };
}

/** The real path of what `word` names from `dir` (component by component, ADR 0007 D02), with `expands`, or null. */
function located(word, dir, boundary) {
  const at = word.length > MAX_WORD ? null : named(word);
  return at && { real: realOf(at.text, dir, boundary.links), expands: at.expands };
}

/** What a judgement reads besides the command's words: the variables it sets (assignedVars) and `listed`, the cache of {@link foldersOf}. */
const readingOf = (segments) => ({ vars: assignedVars(segments), listed: new Map() });

const mountReason = (what, mount) => `oikos mount guard: ${what} writes into the mount \`${mount.path}\` — an installation writes only into itself `
  + `(ADR 0007 D02), so a mount is changed in a session opened there: open a session in \`${mount.path}\` to change it. Reading it is open.`;

/** What denies a file redirection of `command` — into a mount, or to a file with a second name — or null. */
function redirectProblem(command, dirs, boundary, reading) {
  for (const { target } of redirectionTargets(command)) {
    const what = `the redirection \`> ${target}\``;
    for (const dir of dirs) {
      for (const spelled of withVariables(target, reading.vars, dir)) {
        const at = located(spelled, dir, boundary);
        const mount = at && mountHolding(at.real, boundary);
        if (mount) return mountReason(what, mount);
        if (at && !at.expands && hardLinked(at.real)) return hardLinkReason(what, target);
      }
    }
  }
  return null;
}

/** The mount a recursing git call, run in the work tree `tree` (real), writes into: one below that folder, or — in this installation — any inside mount. */
function mountBelow(tree, boundary) {
  const treeId = idOf(tree);
  const inInstall = inside(tree, boundary.install, boundary.installId, boundary);
  return boundary.mounts.find((m) => inside(m.root, tree, treeId, boundary)
    || (inInstall && inside(m.root, boundary.install, boundary.installId, boundary))) ?? null;
}

/** The mount a git call writes into when run from `dir`: its work tree, its git directory, or — recursing — a mount below its folder. */
function gitMount(call, dir, boundary, vars) {
  for (const { workTree, gitDir } of gitPlacesAll(call, dir, vars)) {
    const direct = [workTree, gitDir].map((place) => place && mountHolding(realOf(place, dir, boundary.links), boundary)).find(Boolean);
    if (direct) return { mount: direct, recurses: false };
    const below = gitRecurses(call) ? mountBelow(realOf(workTree, dir, boundary.links), boundary) : null;
    if (below) return { mount: below, recurses: true };
  }
  return null;
}

/** The subcommands whose words are names of branches, remotes, tags, configuration keys and values, never paths. */
const GIT_NO_PATHS = new Set(['push', 'fetch', 'pull', 'merge', 'rebase', 'branch', 'tag', 'remote', 'cherry-pick', 'revert', 'config', 'update-ref', 'symbolic-ref', 'notes', 'reflog', 'switch']);
/** A pathspec's leading magic (`:/`, `:!`, `:(top,exclude)`), with whether it counts from the top of the work tree. */
const PATHSPEC_MAGIC = /^:(?:\(([^)]*)\)|([!^/]*))/;

/** The mount below the real folder `path`, or null. */
const mountUnder = (path, boundary) => boundary.mounts.find((m) => inside(m.root, path, idOf(path), boundary)) ?? null;

/** The folder a pathspec `word` of a call working in `place` is read from, and its path with the magic taken off. */
function pathspecOf(word, { base, workTree }) {
  const magic = PATHSPEC_MAGIC.exec(word);
  if (!magic) return { from: base, path: word };
  return { from: /top|\//.test(magic[1] ?? magic[2]) ? workTree : base, path: word.slice(magic[0].length) };
}

/** The mount the located path `at` is in, or — when `moves` — holds; null when none. */
const mountNamed = (at, moves, boundary) => (at ? mountHolding(at.real, boundary) ?? (moves && !at.expands ? mountUnder(at.real, boundary) : null) : null);

/** The mount the pathspec `word` names, read from the work place `place` of a git call, or null. */
function pathspecNamed(word, place, moves, boundary, reading) {
  const { from, path } = pathspecOf(word, place);
  for (const spelled of path === '' ? [] : withVariables(path, reading.vars, from)) {
    if (!leads(spelled, from, reading.listed)) continue;
    const mount = mountNamed(located(spelled, from, boundary), moves, boundary);
    if (mount) return mount;
  }
  return null;
}

/**
 * The mount a git write names among its words, read as paths (a pathspec: `git rm -r vault`, `git mv vault
 * vault2`, `git checkout -- vault/a.md`) from `dir` — judged as a redirection target is, so a word inside a
 * mount counts; `rm` and `mv` (without `--cached`) also remove or move the folder that holds a mount, so a
 * word that is such a folder counts for them. A word counts only when it can lead out of the folder it is read
 * from (`leads`). `{mount, word}`, or null.
 */
function pathspecMount(call, dir, boundary, reading) {
  if (GIT_NO_PATHS.has(call.sub)) return null;
  const moves = (call.sub === 'rm' || call.sub === 'mv') && !call.rest.includes('--cached');
  for (const place of gitPlacesAll(call, dir, reading.vars)) {
    for (const word of positionals(call.rest)) {
      const mount = pathspecNamed(word, place, moves, boundary, reading);
      if (mount) return { mount, word };
    }
  }
  return null;
}

/** What denies a git call that writes into a mount, from any folder the command may run in, or null. */
function gitProblem(call, dirs, boundary, reading) {
  if (gitReads(call) && !call.configured) return null;
  const what = `\`git ${call.sub ?? ''}\`${call.configured ? ' (with a configuration value, which can run code)' : ''}`;
  for (const dir of dirs) {
    const found = gitMount(call, dir, boundary, reading.vars);
    if (found) return mountReason(found.recurses ? `${what}, which recurses into the repositories below this folder,` : what, found.mount);
    const path = gitReads(call) ? null : pathspecMount(call, dir, boundary, reading);
    if (path) return mountReason(`${what}, which names \`${path.word}\`,`, path.mount);
  }
  return null;
}

/** Whether a grep-like command searches below its paths: `-r`, `-R`, `--recursive` or `-d recurse`. */
const recursiveGrep = (args) => args.some((a, i) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a) || /^--(?:dereference-)?recursive$/.test(a)
  || a === '--directories=recurse' || (a === '-d' && args[i + 1] === 'recurse'));
const clusterHas = (letters) => (args) => args.some((a) => new RegExp(`^-[A-Za-z]*[${letters}][A-Za-z]*$`).test(a) || /^--(?:recursive|archive)$/.test(a));

/** The options of the searching programs that take a value, so the value is not read as a path: grep's, and those of `rg`, `ag`, `ack` and `fd`. */
const GREP_VALUES = new Set([
  '-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--include', '--exclude', '--exclude-dir', '--exclude-from',
  '--label', '--binary-files', '--context', '--after-context', '--before-context', '--color', '--colour', '--devices', '--directories',
]);
const RG_VALUES = new Set([
  '-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M', '-j', '-r', '-E', '-d', '-S', '-x', '--max-depth', '--glob', '--iglob', '--type', '--type-not',
  '--type-add', '--regexp', '--file', '--threads', '--max-count', '--replace', '--encoding', '--sort', '--sortr', '--ignore-file', '--pre', '--pre-glob',
  '--context', '--after-context', '--before-context', '--max-columns', '--colors', '--color', '--extension', '--exclude', '--size',
]);
const PATTERN_GIVEN = new Set(['-e', '-f', '--regexp', '--file']);

/** The words of `args` that are no option and no option's value (`values` are the options that take one), up to a lone `--` and after it. */
function plainWords(args, values) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { words.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a.length > 1) { if (values.has(a)) i++; } else words.push(a);
  }
  return words;
}

/** The paths of a `find`: the words before its first expression, past its leading options. */
function findPaths(args) {
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-H', '-L', '-P'].includes(a) || /^-O\d?$/.test(a)) continue;
    if (a === '-D') { i++; continue; }
    if (a.startsWith('-') || ['(', '!', ','].includes(a)) break;
    paths.push(a);
  }
  return paths;
}

const grepLike = { patterned: true, implicit: true, values: GREP_VALUES };
const rgLike = { ...grepLike, values: RG_VALUES };
/**
 * The programs that read below the paths they are given: `when` says whether the call recurses,
 * `paths` which words are the scopes (the first plain word of a `patterned` one is its pattern), and
 * `implicit` that a call with no path searches the folder it runs in.
 */
const SEARCHERS = {
  rg: rgLike, ag: rgLike, ack: rgLike, fd: rgLike, fdfind: rgLike,
  grep: { ...grepLike, when: recursiveGrep }, egrep: { ...grepLike, when: recursiveGrep }, fgrep: { ...grepLike, when: recursiveGrep },
  zgrep: { ...grepLike, when: recursiveGrep }, ugrep: { ...grepLike, when: recursiveGrep },
  find: { paths: findPaths, implicit: true },
  ls: { when: clusterHas('R'), implicit: true },
  tree: { implicit: true },
  cp: { when: clusterHas('rRa') }, rsync: { when: clusterHas('ra') }, zip: { when: clusterHas('r') }, tar: {},
};

/** `git grep --no-index`: it searches the files of a folder, tracked or not, with no repository to bound it. */
const GIT_GREP_VALUES = new Set(['-e', '-f', '-A', '-B', '-C', '-m', '-O', '--regexp', '--file', '--max-count', '--max-depth', '--threads', '--context', '--after-context', '--before-context', '--open-files-in-pager']);
const GIT_GREP = { patterned: true, implicit: true, values: GIT_GREP_VALUES };

/** The words of a search call that may be its scopes. */
function scopeWords(searcher, args) {
  if (searcher.paths) return searcher.paths(args);
  const words = plainWords(args, searcher.values ?? GREP_VALUES);
  return searcher.patterned && !args.some((a) => PATTERN_GIVEN.has(a)) ? words.slice(1) : words;
}

/** Whether a scope word of a search names a place — it has a `/`, expands, is `.`, `..` or `~…`, or exists in one of `dirs`. */
const namesPlace = (word, dirs) => pathLike(word) || dirs.some((dir) => existsSync(resolve(dir, word)));

/** The real paths a search call reads below, with how each was named: its explicit scopes from each folder it may run in, else — for a program that searches where it runs — those folders. */
function scopesOf(searcher, args, here, boundary, reading) {
  const explicit = scopeWords(searcher, args).filter((word) => namesPlace(word, here));
  if (explicit.length) {
    return explicit.flatMap((word) => here.flatMap((dir) => withVariables(word, reading.vars, dir)
      .map((spelled) => ({ name: `\`${word}\``, at: located(spelled, dir, boundary) }))));
  }
  return searcher.implicit ? here.map((dir) => ({ name: 'the folder it runs in', at: { real: realOf(dir, dir, boundary.links) } })) : [];
}

/**
 * The program a segment searches with, its words and the folders it may run in, or null: a searcher
 * of SEARCHERS, or a `git grep --no-index` — then the folder git works in (`-C`), from each folder the
 * command may run in.
 */
function searchOf(segment, call, folders, reading) {
  if (call) {
    const searching = call.sub === 'grep' && call.rest.some((word) => /^--no-index$/.test(word));
    return searching ? { name: 'git grep', searcher: GIT_GREP, args: call.rest, here: unique(folders.flatMap((dir) => gitPlacesAll(call, dir, reading.vars).map(({ base }) => base))) } : null;
  }
  const searcher = Object.hasOwn(SEARCHERS, segment.exe) ? SEARCHERS[segment.exe] : null;
  return searcher && (!searcher.when || searcher.when(segment.args)) ? { name: segment.exe, searcher, args: segment.args, here: folders } : null;
}

/** What denies a search of `command` whose scope is above this installation, or null. */
function scopeProblem(segments, calls, cwd, boundary, reading) {
  const { now } = dirsAlong(segments, cwd);
  for (const [i, segment] of segments.entries()) {
    const search = searchOf(segment, calls.get(segment), unique([cwd, now[i]]), reading);
    if (!search) continue;
    const above = scopesOf(search.searcher, search.args, search.here, boundary, reading).find(({ at }) => at && aboveInstallation(at.real, boundary));
    if (above) return scopeReason(`\`${search.name}\``, above.name, above.at.real);
  }
  return null;
}

/** Whether a word can be a path with no look at the disk: it holds a `/`, is `.`, `..` or `~…`, or expands. */
function pathLike(word) {
  return word.includes('/') || word === '.' || word === '..' || word.startsWith('~') || EXPANSION.test(word);
}

/** An absolute or `~` path written inside a longer word (`open('/x/y')`, `--flag,/x`). */
const EMBEDDED_PATH = /(?<![\w.~-])~?\/[^\s'"`$;|&<>(){}[\]*?\\]+/g;

/** The paths a single word (no space in it) may name: the word, what follows `=` or `:`, the parts between commas, a value behind `@` (`curl -d @file`), an option's attached value, a path written inside it. */
function pathsOf(word) {
  const bare = /^\d*[<>]/.test(word) ? word.replace(/^\d*[<>]+&?/, '') : word;
  if (!/[/=:~,@]/.test(bare)) return bare.startsWith('-') ? [] : [bare];
  const found = !bare.startsWith('-') || bare.includes('/') ? [bare] : [];
  found.push(...partsOf(bare), ...[...bare.matchAll(EMBEDDED_PATH)].map(([embedded]) => embedded));
  return found;
}

/** The paths a word holds besides itself: what follows `=` or `:`, its comma-joined parts, a value behind `@`, an option's attached value. */
function partsOf(bare) {
  const parts = [];
  const eq = bare.indexOf('=');
  if (eq > 0 && !bare.slice(0, eq).includes('/')) parts.push(bare.slice(eq + 1));
  if (bare.includes(':')) parts.push(...bare.split(':'));
  if (bare.includes(',')) parts.push(...bare.split(',').flatMap((part) => pathsOf(part)));
  if (bare.startsWith('@') && bare.length > 1) parts.push(...pathsOf(bare.slice(1)));
  if (/^-[A-Za-z](?=[~./@])/.test(bare)) parts.push(...pathsOf(bare.slice(2)));
  return parts;
}

/** The words of one shell token that may be paths (a quoted token with spaces is also taken apart). */
const candidates = (token) => (/\s/.test(token) ? [token, ...token.split(/\s+/)] : [token]).flatMap(pathsOf).filter((word) => word && word.length <= MAX_WORD);

/** The names, lowercased, of the folders and links directly in `dir`: a bare word can lead into another installation only through one of them (or when `dir` is itself in one). `listed` remembers them per folder. */
function foldersOf(dir, listed) {
  if (!listed.has(dir)) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      listed.set(dir, new Set(entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name.toLowerCase())));
    } catch {
      listed.set(dir, new Set());
    }
  }
  return listed.get(dir);
}

/**
 * Whether the word `word`, read from `dir`, can lead out of `dir` into another installation: it is
 * absolute, `~…`, starts with `.`, `..` or an expansion, or its first name is a folder or a link of
 * `dir`. Any other relative word names something new below `dir`, which is no installation's root.
 */
function leads(word, dir, listed) {
  if (isAbsolute(word) || word.startsWith('~')) return true;
  const first = word.split('/', 1)[0];
  return first === '.' || first === '..' || EXPANSION.test(first) || foldersOf(dir, listed).has(first.toLowerCase());
}

/** What denies the word `word`, read from `dirs`, for naming a path in another installation, or null; `reading` is what {@link readingOf} gives. */
function wordProblem(word, dirs, boundary, reading) {
  for (const dir of dirs) {
    for (const spelled of withVariables(word, reading.vars, dir)) {
      if (!leads(spelled, dir, reading.listed)) continue;
      const at = located(spelled, dir, boundary);
      const other = at && foreignInstallation(at.real, boundary);
      if (other) return foreignReason(word, other);
      if (at?.expands && aboveInstallation(at.real, boundary)) return foreignReason(word, `an installation below ${at.real}`);
    }
  }
  return null;
}

/** What denies a path in another installation that is not registered, named anywhere in `command`'s words, or null. */
function namedProblem(command, cwd, boundary, reading) {
  const segments = shellSegments(command);
  const { along } = dirsAlong(segments, cwd);
  const seen = new Set();
  for (const [i, { tokens }] of segments.entries()) {
    for (const word of tokens.flatMap(candidates)) {
      const key = `${along[i].length}\0${word}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = wordProblem(word, isAbsolute(word) ? [cwd] : along[i], boundary, reading);
      if (found) return found;
    }
  }
  return null;
}

const foreignReason = (word, other) => `oikos boundary guard: \`${word}\` names a path in another installation (${other}) that is not registered `
  + 'as a mount (ADR 0007 D05). Register it in `.local/mounts.yaml` (a mount without `use`) to read it; material moves between installations only through `setup transfer`.';

/** The command a shell is asked to run (`bash -c '…'`, `eval …`), or null. */
function innerCommand({ exe, args }) {
  if (SHELLS.has(exe)) {
    const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : null;
  }
  return exe === 'eval' ? args.join(' ') : null;
}

/** What denies the commands a shell is told to run inside `segments` (`bash -c '…'`, `eval …`), or null. */
function innerProblem(segments, cwd, boundary, depth) {
  for (const segment of segments) {
    const inner = innerCommand(segment);
    const found = inner && shellMountProblem(inner, cwd, boundary, depth + 1);
    if (found) return found;
  }
  return null;
}

/** What denies the commands inside the substitutions that stand in double quotes in `command` (`echo "$(git -C vault commit)"`): each is judged as a command of its own, or null. */
function substitutionProblem(command, cwd, boundary, depth) {
  for (const inner of quotedSubstitutions(command)) {
    const found = shellMountProblem(inner, cwd, boundary, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Why a shell command may not run, or null. `cwd` is the folder it starts in, `boundary` what
 * {@link boundaryOf} read.
 * @param {string} command the shell command
 * @param {string} cwd
 * @param {ReturnType<typeof import('./boundary.mjs').boundaryOf>} boundary
 * @returns {string|null}
 */
export function shellMountProblem(command, cwd, boundary, depth = 0) {
  const segments = shellSegments(withoutRedirections(command));
  const { dirs } = dirsAlong(segments, cwd);
  const calls = gitCalls(segments);
  const reading = readingOf(segments);
  const checks = [
    () => redirectProblem(command, dirs, boundary, reading),
    () => [...calls.values()].map((call) => gitProblem(call, dirs, boundary, reading)).find(Boolean),
    () => scopeProblem(segments, calls, cwd, boundary, reading),
    () => namedProblem(command, cwd, boundary, reading),
    () => (depth < MAX_DEPTH ? innerProblem(segments, cwd, boundary, depth) : null),
    () => (depth < MAX_DEPTH ? substitutionProblem(command, cwd, boundary, depth) : null),
  ];
  for (const check of checks) {
    const problem = check();
    if (problem) return problem;
  }
  return null;
}
