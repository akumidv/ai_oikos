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
//   of the file may lie in a mount (D02). A redirection, and the output file or folder a git call is
//   given (`--output=`, `--output-directory=`, `-o`, `config --file`), into the hook state folder is
//   denied too: it would forge the record of a dry run. A word that starts with `~name` (another
//   user's home) is denied, as the file guard does: no guard can tell what the shell expands it to.
//
// Paths are judged as D02 says: real, component by component (`realOf`), contained by the identity
// of the folders above them (boundary.mjs). Best effort against accidents, like every shell guard:
// what a command substitution or a script expands to is not looked at, a variable only when it is
// `~`, `$HOME`, `$PWD`, `$TMPDIR` or one an assignment in the command sets (`V=vault; git -C $V …`, also
// as the program: `G=git; $G …`) — not a loop variable (`for d in vault; do git -C $d …`: accepted
// gap, task L5) — and a `cd` whose target cannot be read leaves the relative words after it unjudged.
// A brace group is expanded (64 forms). A word with another expansion is judged by the folder before
// the first expansion character (a glob at its start: by the folder it is read from), and a relative
// word only when its first name is a folder or a link of the folder it is read from (anything else is
// new, below that folder). Where a word is written to (a redirection, a git target or output, a git
// write's path) a glob is also expanded against the file system, bounded (`globPlaces`), so
// `vau*/inbox/n.md` and `git -C v?ult …` are the mount they name; one too wide to expand is taken to
// name every mount below its folder. A command in a substitution inside double quotes is judged as a
// command of its own. A git write is also judged by the paths it names (`git rm -r vault`).
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { shellSegments, STATE_DIR } from './common.mjs';
import { assignedVars, dirsAlong, gitCalls, gitPlacesAll, globPlaces, hasGlob, homed, inputRedirections, MAX_WORD, mergedVars, newBudget, quotedSubstitutions, redirectionTargets, unique, withoutRedirections, withPrefix, withProgramVariables, withVariables } from './shell.mjs';
import { isUserHome } from './host.mjs';
import { aboveInstallation, foreignInstallation, hardLinked, hardLinkReason, inside, mountHolding, otherInstallation, scopeReason } from './boundary.mjs';
import { idOf, isWithin, realOf, sameFile } from '../common/paths.mjs';

const EXPANSION = /[$`*?[{]/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const MAX_DEPTH = 3;

/** The git subcommands that only read; any other subcommand counts as a write. */
const GIT_READS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'blame', 'annotate',
  'grep', 'describe', 'shortlog', 'whatchanged', 'show-ref', 'show-branch', 'for-each-ref', 'name-rev', 'merge-base', 'diff-tree',
  'diff-files', 'diff-index', 'check-ignore', 'check-attr', 'check-ref-format', 'var', 'version', 'help', 'count-objects',
  'verify-commit', 'verify-tag', 'cherry', 'range-diff', 'get-tar-commit-id',
]);
const positionals = (words) => words.filter((word) => !word.startsWith('-'));
const hasFlag = (words, pattern) => words.some((word) => pattern.test(word));
/** The long options of `git config` that write. */
const CONFIG_WRITES = ['--add', '--unset', '--unset-all', '--replace-all', '--edit', '--rename-section', '--remove-section'];
/** Whether the word `word` is the long option `name` or an abbreviation of it (`--fil` for `--file`, `--unset-a`): git takes any unambiguous prefix of an option it parses itself, with its value after `=` or as the next word. */
function abbreviates(word, names) {
  const flag = word.split('=', 1)[0];
  return flag.length > 2 && flag.startsWith('--') && [names].flat().some((name) => name.startsWith(flag));
}
/** Whether `git config` reads: a get or list (also as the subcommands of git 2.46), or a lone key; `edit`, `set`, `unset` and the section and option flags write. */
function configReads(rest) {
  const [first] = positionals(rest);
  if (['edit', 'set', 'unset', 'rename-section', 'remove-section'].includes(first)) return false;
  if (rest.some((word) => word === '-e' || abbreviates(word, CONFIG_WRITES))) return false;
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
 * made it the folder before the expansion and the whole word as its `glob` when it holds one; null when
 * nothing can be told (it starts with a variable or a substitution, or is a `~user`). A word that starts
 * with a glob is the folder it is read from, any of whose entries it may name.
 */
function named(word) {
  const text = homed(word);
  if (text === null) return null;
  const cut = text.search(EXPANSION);
  const glob = hasGlob(text) && !BRACKETS.test(text) ? text : null;
  if (cut === 0) return /^[*?[{]/.test(text) && !BRACKETS.test(text) ? { text: '.', expands: true, glob } : null;
  if (cut < 0) return { text, expands: false, glob: null };
  return { text: text.slice(0, text.lastIndexOf('/', cut) + 1) || '.', expands: true, glob };
}

/** The real path of what `word` names from `dir` (component by component, ADR 0007 D02), with `expands`, the `glob` word and the folder `from` it is read from, or null. */
function located(word, dir, boundary) {
  const at = word.length > MAX_WORD ? null : named(word);
  return at && { real: realOf(at.text, dir, boundary.links), expands: at.expands, glob: at.glob, from: dir };
}

/**
 * What a judgement reads besides the command's words: the variables it sets (assignedVars), `listed`, the
 * cache of {@link foldersOf}, the real hook state folder, `budget` — what the whole command may spend on
 * expanding braces and globs (newBudget), shared by every word and by the commands inside it — and `placed`,
 * the places of each git call per folder ({@link placesFor}), `judged`, what {@link elsewhere} found for a real path, and `inherited`,
 * the variables an outer command passes in (the `vars` of a command inside another also hold them).
 */
const readingOf = (segments, budget, inherited) => ({
  vars: mergedVars(inherited.vars, assignedVars(segments)), inherited: inherited.vars, listed: new Map(), state: realOf(STATE_DIR), budget, placed: new Map(), judged: new Map(),
});

/** The options {@link withVariables} reads a word with: its braces (unless the shell reads it inside quotes) and the command's budget. */
const expanding = (reading, braces = true) => ({ braces, budget: reading.budget });

/** The places a git call works in from the folder `dir` ({@link gitPlacesAll}), found once for the command. */
function placesFor(call, dir, reading) {
  if (!reading.placed.has(call)) reading.placed.set(call, new Map());
  const byDir = reading.placed.get(call);
  if (!byDir.has(dir)) byDir.set(dir, gitPlacesAll(call, dir, reading.vars, reading.budget));
  return byDir.get(dir);
}

/**
 * The real paths the glob of the located word `at` may name, expanded against the file system; when the
 * glob is too wide to expand (or the command's budget is spent), the mounts below the folder before it (it
 * may name any). None for a word without a glob. Remembered on `at`.
 */
function globbed(at, boundary, reading) {
  if (!at.glob) return [];
  at.matches ??= (() => {
    const { places, complete } = globPlaces(at.glob, at.from, boundary.links, reading.budget);
    return complete ? places : [...places, ...boundary.mounts.filter((m) => isWithin(m.root, at.real)).map((m) => m.root)];
  })();
  return at.matches;
}

const mountReason = (what, mount) => `oikos mount guard: ${what} writes into the mount \`${mount.path}\` — an installation writes only into itself `
  + `(ADR 0007 D02), so a mount is changed in a session opened there: open a session in \`${mount.path}\` to change it. Reading it is open.`;

const stateReason = (what, state) => `oikos mount guard: ${what} writes into the hook state folder (${state}), where the write guard records which guarded writes `
  + 'were shown and the user had the word for — a write there could forge a dry run and run a guarded write without one. Write the file elsewhere.';

/** The mount the real path `real` is in or — when `holds` — holds; null when none. With `rootOk`, a path that is a mount's own folder is none: it is the repository nested in this one, not a file in it. */
function mountAt(real, holds, boundary, rootOk) {
  const found = mountHolding(real, boundary);
  if (found) return rootOk && sameFile(real, found.root) ? null : found;
  return holds ? mountUnder(real, boundary) : null;
}

/** The mount the located path `at` is in, or — when `holds` — holds, or one its glob may name; null when none (`rootOk`: see {@link mountAt}; it is read for the names of a glob only, a word that spells a mount's folder out is still that mount). */
function mountNamed(at, holds, boundary, reading, rootOk = false) {
  if (!at) return null;
  const direct = mountAt(at.real, holds && !at.expands, boundary, false);
  if (direct) return direct;
  for (const real of globbed(at, boundary, reading)) {
    const mount = mountAt(real, holds, boundary, rootOk);
    if (mount) return mount;
  }
  return null;
}

/**
 * What denies a write to the file or folder `word`, read from `dir`, for landing in a mount (`holds`: or in a
 * folder that holds one), in the hook state folder or — `hardLinks` — in a file with a second name; or null.
 * `how` is `{ what, holds, hardLinks }`, `what` naming the write.
 */
function writeProblem(word, dir, { what, holds, hardLinks }, boundary, reading) {
  for (const spelled of withVariables(word, reading.vars, dir, expanding(reading))) {
    const at = located(spelled, dir, boundary);
    const mount = mountNamed(at, holds, boundary, reading);
    if (mount) return mountReason(what, mount);
    if (at && [at.real, ...globbed(at, boundary, reading)].some((real) => inside(real, reading.state, idOf(reading.state), boundary))) return stateReason(what, reading.state);
    if (hardLinks && at && !at.expands && hardLinked(at.real)) return hardLinkReason(what, word);
  }
  return null;
}

/** What denies a file redirection of `command` — into a mount, the hook state folder, or to a file with a second name — or null. */
function redirectProblem(command, dirs, boundary, reading) {
  for (const { target } of redirectionTargets(command)) {
    for (const dir of dirs) {
      const problem = writeProblem(target, dir, { what: `the redirection \`> ${target}\``, holds: false, hardLinks: true }, boundary, reading);
      if (problem) return problem;
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
function gitMount(call, dir, boundary, reading) {
  for (const { workTree, gitDir, wide } of placesFor(call, dir, reading)) {
    if (wide) {
      const any = mountHolding(workTree, boundary) ?? mountUnder(workTree, boundary);
      if (any) return { mount: any, recurses: false };
    }
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

/**
 * The mount the pathspec `word` names, read from the work place `place` of a git call, or null. A glob that
 * matches a mount's own folder names none for the calls that only `tracked` files and the index (`checkout`,
 * `restore`, `rm --cached`; not `add`, `mv` or `rm`, which take the folder as a path): `git
 * checkout -- *`, `git restore *` and `git rm --cached *` change the tracked files and the index of the
 * repository they work in, and a mount is a repository of its own that this one does not track. The mount
 * as the work place of the call is judged apart (gitMount), and so is a word that spells a path inside it.
 */
function pathspecNamed(word, place, { moves, tracked }, boundary, reading) {
  const { from, path } = pathspecOf(word, place);
  for (const spelled of path === '' ? [] : withVariables(path, reading.vars, from, expanding(reading))) {
    if (!leads(spelled, from, reading.listed)) continue;
    const mount = mountNamed(located(spelled, from, boundary), moves, boundary, reading, tracked);
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
  const tracked = call.sub === 'checkout' || call.sub === 'restore' || (call.sub === 'rm' && !moves);
  for (const place of placesFor(call, dir, reading)) {
    for (const word of positionals(call.rest)) {
      const mount = pathspecNamed(word, place, { moves, tracked }, boundary, reading);
      if (mount) return { mount, word };
    }
  }
  return null;
}

/**
 * The values of the options `names` among `words`, up to a lone `--`: `--name=value`, `--name value`, and for a
 * short one `-nvalue`. With `abbreviated`, a long option is also met under any shorter spelling of three
 * characters or more (`--sep=x` for `--separate-git-dir`): the subcommands that parse their own options with
 * git's option parser take any unambiguous prefix, and an ambiguous one fails, so reading every prefix is safe.
 */
function optionValues(words, names, abbreviated = false) {
  const end = words.indexOf('--');
  const values = (end < 0 ? words : words.slice(0, end)).flatMap((word, i) => names.map((name) => valueOf(word, words[i + 1], name, abbreviated)));
  return values.filter((value) => value);
}

/** The value the option `name` gives at `word` (`next` is the word after it), or undefined when `word` is not that option; see {@link optionValues}. */
function valueOf(word, next, name, abbreviated) {
  if (word === name) return next;
  if (!name.startsWith('--')) return word.startsWith(name) && !word.startsWith('--') ? word.slice(name.length) : undefined;
  const [flag, ...attached] = word.split('=');
  if (flag !== name && !(abbreviated && abbreviates(flag, name))) return undefined;
  return attached.length ? attached.join('=') : next;
}

/**
 * The options besides `--output` whose value a subcommand writes to: `files` and `folders`; `abbreviated`
 * says the subcommand's option parser takes a prefix of a long option (checked with real git: `config
 * --fil`, `init --sep=`, `clone --sep=`, `checkout-index --pre=` work; the revision-parsing `diff`/`log`/`format-patch`
 * and `archive`, `fast-export` take only the exact spelling).
 */
const OUTPUT_OPTIONS = {
  archive: { files: ['-o'] },
  'index-pack': { files: ['-o'] },
  'fast-export': { files: ['--export-marks'] },
  'fast-import': { files: ['--export-marks'] },
  'format-patch': { folders: ['-o', '--output-directory'] },
  'checkout-index': { folders: ['--prefix'], abbreviated: true },
  init: { folders: ['--separate-git-dir'], abbreviated: true },
  clone: { folders: ['--separate-git-dir'], abbreviated: true },
};

/**
 * The paths a git call is told to write to, besides its repository: the file of `--output` (any
 * subcommand: `diff`, `log`, `show`, `archive`), of `-o` (`archive`, `index-pack`), of `--export-marks`
 * and of `config --file` (a configuration change only); and, as `folder`, the folder of `-o` and
 * `--output-directory` (`format-patch`), `--prefix` (`checkout-index`) and `--separate-git-dir`
 * (`init`, `clone`), where a folder that holds a mount counts too.
 */
function outputsOf(call) {
  const own = Object.hasOwn(OUTPUT_OPTIONS, call.sub) ? OUTPUT_OPTIONS[call.sub] : {};
  const files = [...(own.files ?? []), ...(call.sub === 'config' && !gitReads(call) ? ['--file', '-f'] : [])];
  const abbreviated = own.abbreviated || call.sub === 'config';
  return [
    ...optionValues(call.rest, ['--output']).map((word) => ({ word, folder: false })),
    ...optionValues(call.rest, files, abbreviated).map((word) => ({ word, folder: false })),
    ...optionValues(call.rest, own.folders ?? [], abbreviated).map((word) => ({ word, folder: true })),
  ];
}

/** What denies the output a git call writes to (`git diff --output=vault/n.md`), judged like a redirection target read from the folder git works in; or null. */
function outputProblem(call, dirs, boundary, reading) {
  const outputs = outputsOf(call);
  for (const dir of outputs.length ? dirs : []) {
    for (const { base } of placesFor(call, dir, reading)) {
      for (const { word, folder } of outputs) {
        const problem = writeProblem(word, base, { what: `\`git ${call.sub}\` with the output \`${word}\``, holds: folder, hardLinks: false }, boundary, reading);
        if (problem) return problem;
      }
    }
  }
  return null;
}

/** What denies a git call that writes into a mount, from any folder the command may run in, or null. */
function gitProblem(call, dirs, boundary, reading) {
  if (gitReads(call) && !call.configured) return null;
  const what = `\`git ${call.sub ?? ''}\`${call.configured ? ' (with a configuration value, which can run code)' : ''}`;
  for (const dir of dirs) {
    const found = gitMount(call, dir, boundary, reading);
    if (found) return mountReason(found.recurses ? `${what}, which recurses into the repositories below this folder,` : what, found.mount);
    const path = gitReads(call) ? null : pathspecMount(call, dir, boundary, reading);
    if (path) return mountReason(`${what}, which names \`${path.word}\`,`, path.mount);
  }
  return null;
}

/** What denies a git write when a `cd` may have led anywhere below a folder of `wide` (a glob or brace group too wide to expand) that holds a mount, or null. */
function wideProblem(call, wide, boundary) {
  if (gitReads(call) && !call.configured) return null;
  for (const folder of wide) {
    const mount = mountHolding(folder, boundary) ?? mountUnder(folder, boundary);
    if (mount) return mountReason(`\`git ${call.sub ?? ''}\`, run after a \`cd\` that may lead into a mount,`, mount);
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
    return explicit.flatMap((word) => here.flatMap((dir) => withVariables(word, reading.vars, dir, expanding(reading))
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
    return searching ? { name: 'git grep', searcher: GIT_GREP, args: call.rest, here: unique(folders.flatMap((dir) => placesFor(call, dir, reading).map(({ base }) => base))) } : null;
  }
  const searcher = Object.hasOwn(SEARCHERS, segment.exe) ? SEARCHERS[segment.exe] : null;
  return searcher && (!searcher.when || searcher.when(segment.args)) ? { name: segment.exe, searcher, args: segment.args, here: folders } : null;
}

/** What denies a search of `command` whose scope is above this installation, or null. */
function scopeProblem(segments, calls, cwd, boundary, reading) {
  const { nows } = dirsAlong(segments, cwd, reading.budget, reading.inherited);
  for (const [i, segment] of segments.entries()) {
    const search = searchOf(segment, calls.get(segment), unique([cwd, ...nows[i]]), reading);
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

const homeReason = (word) => `oikos mount guard: \`${word}\` is a path in another user's home (\`~name\`), which no guard can judge (the shell decides what it `
  + 'expands to), so the command is denied. Name the path by its absolute path.';

/** `~name/…`: a word that is a path in another user's home wherever it stands (a bare `~name` is judged only where a path is known to stand, {@link homeProblem}). */
const USER_HOME_PATH = /^~[^/]+\//;

/** What denies a path in another user's home (`~name`, the user's own too) where the command takes a path for sure — a redirection target, a `cd` target, a git `-C`, `--git-dir` or `--work-tree` — or null. */
function homeProblem(command, segments, calls, cwd, reading) {
  const words = [
    ...redirectionTargets(command).map(({ target }) => target),
    ...segments.filter(({ exe }) => exe === 'cd' || exe === 'pushd').flatMap(({ args }) => args.filter((arg) => !arg.startsWith('-'))),
    ...[...calls.values()].flatMap(({ chdirs, gitDir, workTree }) => [...chdirs, gitDir, workTree]),
  ];
  for (const word of words.filter(Boolean)) {
    const found = withVariables(word, reading.vars, cwd, expanding(reading)).find(isUserHome);
    if (found) return homeReason(found);
  }
  return null;
}

/**
 * What denies the word `word`, read from `dirs`, for naming a path in another installation, or null;
 * `reading` is what {@link readingOf} gives. `live` says what the shell still expands in the word
 * (`tilde`, `brace`: shellSegments' `quoting`): text in quotes or in a heredoc body is not expanded, so
 * a quoted `~bob/notes` or `{../other,x}` names no path there.
 */
function wordProblem(word, dirs, boundary, reading, live) {
  for (const dir of dirs) {
    for (const spelled of withVariables(word, reading.vars, dir, expanding(reading, live.brace))) {
      if (live.tilde && USER_HOME_PATH.test(spelled)) return homeReason(spelled);
      const found = leads(spelled, dir, reading.listed) ? spelledProblem(word, located(spelled, dir, boundary), boundary, reading) : null;
      if (found) return found;
    }
  }
  return null;
}

/** What denies the word `word` for the path `at` it names (located), or null. */
function spelledProblem(word, at, boundary, reading) {
  const other = at && elsewhere(at.real, boundary, reading);
  if (other?.foreign) return foreignReason(word, other.foreign);
  return at?.expands && other?.above ? foreignReason(word, `an installation below ${at.real}`) : null;
}

/** Where the real path `real` stands to the other installations: `{foreign, above}` ({@link foreignInstallation}, {@link aboveInstallation}), found once for the command — a long command names few distinct places, and each look reads the disk; a path no guarded mount holds skips the walk over the mounts that `foreignInstallation` makes first. */
function elsewhere(real, boundary, reading) {
  if (!reading.judged.has(real)) {
    const foreign = mountHolding(real, boundary) ? foreignInstallation(real, boundary) : otherInstallation(real, boundary);
    reading.judged.set(real, { foreign, above: aboveInstallation(real, boundary) });
  }
  return reading.judged.get(real);
}

/** What the shell expands in a word: all of it when that is not known, none in a heredoc body. */
const EVERYTHING_LIVE = { tilde: true, brace: true };
const NOTHING_LIVE = { tilde: false, brace: false };

/** What denies a path in another installation that is not registered, named anywhere in `command`'s words, or null. */
function namedProblem(command, cwd, boundary, reading) {
  const segments = shellSegments(command);
  const { along } = dirsAlong(segments, cwd, reading.budget, reading.inherited);
  const seen = new Set();
  for (const [i, { tokens, quoting, heredoc }] of segments.entries()) {
    for (const [j, token] of tokens.entries()) {
      const live = heredoc ? NOTHING_LIVE : (quoting?.[j] ?? EVERYTHING_LIVE);
      for (const word of candidates(token)) {
        const key = `${along[i].length}\0${live.tilde}${live.brace}\0${word}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const found = wordProblem(word, isAbsolute(word) ? [cwd] : along[i], boundary, reading, live);
        if (found) return found;
      }
    }
  }
  return null;
}

const foreignReason = (word, other) => `oikos boundary guard: \`${word}\` names a path in another installation (${other}) that is not registered `
  + 'as a mount (ADR 0007 D05). Register it in `.local/mounts.yaml` (a mount without `use`) to read it; material moves between installations only through `setup transfer`.';

/** The words of a command as one command line: a word with more than path characters is quoted. */
const commandLine = (words) => words.map((word) => (/^[\w@%+:./=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(' ');

/** What a `find` word that stands for the match (`{}`) or a positional parameter a shell is handed (`$1`, `"$@"`) looks like. */
const MATCH_WORD = /\{\}|\$(?:\d|\{\d|[@*])/;

/**
 * The commands `find` runs for its matches (`-exec`, `-execdir`, `-ok`, `-okdir` up to `;` or `+`), as command lines with
 * `starts`: the paths `find` starts from when the command may run below them — `-execdir`, and a command that is given the
 * match (`{}` or a positional parameter in its words), which may `cd` to it — else null.
 */
function findRuns(args) {
  const paths = findPaths(args);
  const runs = [];
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i])) continue;
    let end = i + 1;
    while (end < args.length && args[end] !== ';' && args[end] !== '+') end++;
    const words = args.slice(i + 1, end);
    const below = args[i].endsWith('dir') || words.some((word) => MATCH_WORD.test(word));
    runs.push({ text: commandLine(words), starts: below ? (paths.length ? paths : ['.']) : null });
    i = end;
  }
  return runs;
}

/** A script a shell reads from its standard input, named as a file. */
const STDIN_SCRIPT = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/\d+)$/;
const SHELL_COMMAND = /^-[A-Za-z]*c[A-Za-z]*$/;

/**
 * The commands a shell program is given, and whether it reads a script no word of the command shows. With `-c` it is the
 * first word after it that is no `--` and no option (`bash -c -- 'x'`). With no `-c` it reads a script file (`sh f.sh`:
 * not looked into, an accepted residual) or its standard input — `-s`, no operand, `/dev/stdin`: the text of a
 * here-string (`stdin.here`) is the command; a file or a heredoc is read as any other input; a pipe or a process
 * substitution (`<(…)`) is a script the guard cannot see (`unknown`).
 */
function shellInput(args, stdin) {
  const at = args.findIndex((a) => SHELL_COMMAND.test(a));
  if (at >= 0) {
    const text = args.slice(at + 1).find((a) => a !== '--' && !a.startsWith('-'));
    return { inner: text === undefined ? [] : [{ text }], unknown: false };
  }
  const operand = args.find((a) => !a.startsWith('-') || a === '-');
  const reads = operand === undefined || STDIN_SCRIPT.test(operand) || args.some((a) => /^-[A-Za-z]*s[A-Za-z]*$/.test(a));
  if (!reads) return { inner: [], unknown: false };
  if (stdin.here.length) return { inner: stdin.here.map((text) => ({ text })), unknown: false };
  return { inner: [], unknown: !stdin.other };
}

/** The command `script -c` (`-qc`, `--command`) runs. */
function scriptInners(args) {
  const at = args.findIndex((a) => SHELL_COMMAND.test(a) || a === '--command');
  const text = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith('--command='))?.slice('--command='.length);
  return text === undefined ? [] : [{ text }];
}

/** The commands a segment's program runs inside itself (`bash -c '…'`, `script -c …`, `eval …`, `find … -exec …`): `inner` as `{text, starts}`, and whether it is a shell that reads a script the guard cannot see (`unknown`). */
function innersOf({ exe, args }, stdin) {
  if (SHELLS.has(exe)) return shellInput(args, stdin);
  if (exe === 'eval') return { inner: [{ text: args.join(' ') }], unknown: false };
  if (exe === 'script') return { inner: scriptInners(args), unknown: false };
  return { inner: exe === 'find' ? findRuns(args) : [], unknown: false };
}

const depthReason = () => `oikos mount guard: commands run inside commands (\`bash -c\`, \`eval\`, \`find -exec\`, a substitution in quotes) more than ${MAX_DEPTH} levels deep, `
  + 'which the guard does not read, so the command is denied. Run the innermost command directly.';
const judgedReason = () => 'oikos mount guard: the command holds more commands inside other commands than the guard can read '
  + '(each is judged from every folder the command may be in), so it is denied. Split it into smaller commands.';

/**
 * What denies `inner` (a command inside the command being judged) run from `folder`, or null: judged as a command of its
 * own, with the variables and the wide folders of the one it is in (`outer`: `vars`, `wide`, `depth`), each of which it is
 * judged for once, within the budget of the command's `judgements`. `inner.starts` — the paths a `find` starts from — are wide.
 */
function judgeInner(inner, folder, outer, boundary, reading) {
  const { budget } = reading;
  const below = (inner.starts ?? []).map((word) => realOf(named(word)?.text ?? '/', folder, boundary.links));
  const wide = unique([...outer.wide, ...below]);
  const key = `${outer.depth}\0${folder}\0${wide.join(':')}\0${JSON.stringify([...outer.vars])}\0${inner.text}`;
  if (budget.inner.has(key)) return null;
  budget.inner.add(key);
  if (budget.judgements-- <= 0) return judgedReason();
  return shellMountProblem(inner.text, folder, boundary, { depth: outer.depth + 1, budget, vars: outer.vars, wide });
}

/**
 * What denies the commands a shell is told to run inside `segments` (`inners`: {@link innersOf} of each; `bash -c '…'`, `eval …`,
 * `find -exec …`, a here-string), or null. Each runs in the folders the command may have reached before it (`along`, `nows`:
 * {@link dirsAlong}), not only in `cwd`, with the variables the command sets or gives it (`CDPATH=dir bash -c …`) and the folders
 * a glob too wide left (`wide`). Past MAX_DEPTH, one that exists is denied: the guard does not read it.
 */
function innerProblem(segments, inners, { reached, wide, depth }, boundary, reading) {
  for (const [i, segment] of segments.entries()) {
    if (inners[i].inner.length && depth >= MAX_DEPTH) return depthReason();
    const vars = withPrefix(reading.vars, segment);
    for (const inner of inners[i].inner) {
      for (const folder of unique([...reached.along[i], ...reached.nows[i]])) {
        const found = judgeInner(inner, folder, { vars, wide, depth }, boundary, reading);
        if (found) return found;
      }
    }
  }
  return null;
}

/** What denies the commands inside the substitutions that stand in double quotes in `command` (`echo "$(git -C vault commit)"`): each is judged as a command of its own, or null. */
function substitutionProblem(command, cwd, { wide, depth }, boundary, reading) {
  for (const text of quotedSubstitutions(command)) {
    if (depth >= MAX_DEPTH) return depthReason();
    const found = judgeInner({ text }, cwd, { vars: reading.vars, wide, depth }, boundary, reading);
    if (found) return found;
  }
  return null;
}

/** The programs this guard looks into, which a variable the command sets may stand for (`G=git; $G …`). */
const runsToJudge = (exe) => {
  if (exe === 'git') return 2;
  return exe === 'eval' || SHELLS.has(exe) || (exe !== null && Object.hasOwn(SEARCHERS, exe)) ? 1 : 0;
};

/**
 * What denies a relative redirection (`> n.md`) of `command` after a `cd` that may have led below a folder of `wide` — a glob or
 * brace group too wide to expand, a shell that reads a script no word shows — that holds a mount, or null.
 */
function wideRedirectProblem(command, wide, boundary) {
  if (wide.length === 0) return null;
  for (const { target } of redirectionTargets(command)) {
    if (isAbsolute(target) || target.startsWith('~') || /[$`]/.test(target)) continue;
    for (const folder of wide) {
      const mount = mountHolding(folder, boundary) ?? mountUnder(folder, boundary);
      if (mount) return mountReason(`the redirection \`> ${target}\`, run after a \`cd\` or in a shell that may lead into a mount,`, mount);
    }
  }
  return null;
}


/**
 * Why a shell command may not run, or null. `cwd` is the folder it starts in, `boundary` what
 * {@link boundaryOf} read. A command inside another is also given `nesting`: its `depth` (0 for a command of its own), the
 * outer command's `budget`, the `vars` the outer command sets or passes to it and the `wide` folders the outer one may be below.
 * @param {string} command the shell command
 * @param {string} cwd
 * @param {ReturnType<typeof import('./boundary.mjs').boundaryOf>} boundary
 * @param {{depth?: number, budget?: ReturnType<typeof newBudget>, vars?: Map<string, string[]>, wide?: string[]}} [nesting]
 * @returns {string|null}
 */
export function shellMountProblem(command, cwd, boundary, { depth = 0, budget = newBudget(), vars = new Map(), wide: outerWide = [] } = {}) {
  const inherited = { vars, wide: outerWide };
  const written = shellSegments(withoutRedirections(command));
  const reading = readingOf(written, budget, inherited);
  const segments = withProgramVariables(written, reading.vars, runsToJudge);
  const reached = dirsAlong(segments, cwd, budget, inherited.vars);
  const stdin = inputRedirections(command);
  const inners = segments.map((segment) => innersOf(segment, stdin));
  const { dirs } = reached;
  const wide = unique([...inherited.wide, ...reached.wide, ...(inners.some(({ unknown }) => unknown) ? [resolve('/')] : [])]);
  const calls = gitCalls(segments);
  const inside = { reached, wide, depth };
  const checks = [
    () => redirectProblem(command, dirs, boundary, reading),
    () => wideRedirectProblem(command, wide, boundary),
    () => homeProblem(command, segments, calls, cwd, reading),
    () => [...calls.values()].map((call) => outputProblem(call, dirs, boundary, reading)).find(Boolean),
    () => [...calls.values()].map((call) => gitProblem(call, dirs, boundary, reading)).find(Boolean),
    () => [...calls.values()].map((call) => wideProblem(call, wide, boundary)).find(Boolean),
    () => scopeProblem(segments, calls, cwd, boundary, reading),
    () => namedProblem(command, cwd, boundary, reading),
    () => innerProblem(segments, inners, inside, boundary, reading),
    () => substitutionProblem(command, cwd, inside, boundary, reading),
  ];
  for (const check of checks) {
    const problem = check();
    if (problem) return problem;
  }
  return null;
}
