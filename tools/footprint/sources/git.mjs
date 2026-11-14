// The git source: commits in local clones — what a person authored over the period, with the lines
// added and removed by kind of file (code, tests, docs, other; generated files counted apart and left out).
// The user's settings (places.mjs) leave out the commits that are a tool's snapshots (skip_commits),
// add paths whose lines are a tool's output (generated) and set apart the repositories whose lines are
// a pipeline's output (pipeline_repos). No request: `git` runs on the clones as they are, so what was
// not fetched is not seen.
//
// Beside the person's commits it reads the meaning of their changes and the repositories' own facts
// (ADR 0008, docs/design/footprint.md): the test functions, decision codes and task keys a commit
// names, the decision documents ever written under the configured folders, tags, CHANGELOG entries,
// the work not yet committed and the person's first commit. Facts carry `action: false`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { UsageError } from '../../common/cli.mjs';
import { missingMessage } from '../../common/files.mjs';
import { DEFAULT_DECISION_CODES, DEFAULT_DECISION_DIRS, LINE_KINDS, codesIn, keysIn, wordsOf } from '../meaning.mjs';
import { addDays } from '../report.mjs';
import { inWorkingPeriod, workingDate } from './period.mjs';

/** git's output for a long history is large: a year of a busy repository is tens of megabytes. */
const MAX_BUFFER = 1024 * 1024 * 1024;
/** How deep under a folder given as --repos the repositories are looked for. */
const REPO_DEPTH = 2;
/** Folders never searched for repositories: dependencies and tool state. */
const NOT_SEARCHED = new Set(['node_modules', 'vendor', 'dist', 'build', '.venv', 'venv']);

const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'uv.lock', 'cargo.lock', 'go.sum',
  'composer.lock', 'gemfile.lock', 'pipfile.lock',
]);
const GENERATED_FILE = /\.min\.(js|css)$|\.map$|\.snap$/i;
const GENERATED_DIR = /(^|\/)(node_modules|vendor|dist|build|\.venv)\//;
const DOCS_FILE = /\.(md|mdx|rst|txt|adoc|org|tex)$/i;
/** Config and data: a settings or data format, an example environment file. */
const OTHER_FILE = /\.(json|jsonc|yaml|yml|toml|ini|cfg|conf|csv|tsv|xml|properties)$|\.env\.example$/i;
/** Source code: a language's extension, wherever the file lies (a `data/` package of code is still code). */
const CODE_FILE = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|py|pyi|rb|go|rs|java|kt|kts|scala|swift|c|h|cc|cpp|cxx|hpp|hh|cs|fs|php|sh|bash|zsh|fish|ps1|bat|sql|lua|r|pl|pm|dart|ex|exs|erl|hs|clj|cljs|ml|vue|svelte|astro|css|scss|sass|less|html|htm|gradle|groovy|tf|nix|proto|graphql|gql|m|mm|jl|zig|v|vb)$/i;
/** Test code: a tests or spec folder, a `_test`/`.test`/`.spec` file, a `test_` file. */
const TESTS_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|(_test|\.test|\.spec)\.[^/]+$|(^|\/)test_[^/]+$/i;
/** The kinds of lines a commit carries, in the order of the totals and the breakdown. */
const KINDS = LINE_KINDS;
/** An added line that opens a test function, per language: Python, JavaScript, Rust, Go, Java. */
const TEST_FUNCTION = [/^\+\s*(async\s+)?def test_/, /^\+\s*(it|test)\s*\(/, /^\+\s*#\[test\]/, /^\+\s*func Test[A-Z_]/, /^\+\s*@Test\b/];
/** A document's status: the first line that starts with the word (after markdown markers), and the first word on it that decides. */
const STATUS_LINE = /^[\s#>*_-]*status(?![a-z0-9])/i; // not `\b`: `_Status_` (italic) ends in a word character
const STATUS_WORD = /accepted|superseded|proposed|draft/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
/** A version heading of a CHANGELOG: its version and the date on the same line. */
const CHANGELOG_HEADING = /^##\s*\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?.*?(\d{4}-\d{2}-\d{2})/;
const CHANGELOG_BREAKING = /^###\s*(breaking|⚠)/i;
/** An ADR's file name in an `adr` folder: `0008-title.md`. */
const ADR_NAME = /^\d{4}-.*\.md$/;
/** How many untracked files of one repository are read for their lines, and how large one may be. */
const UNTRACKED_MAX = 2000;
const UNTRACKED_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Settings that would change git's output, pinned whatever the user's configuration says. The rest
 * of that configuration applies (a global `safe.directory` among it). The mailmap is off, so an
 * author matches the address --email names, as written in the commit.
 */
const PLAIN = [
  '-c', 'core.quotepath=off', '-c', 'log.showSignature=false', '-c', 'color.ui=never', '-c', 'diff.renames=true',
  '-c', 'log.mailmap=false', '-c', 'log.decorate=false',
];
/**
 * The caller's variables that point git at another repository, object store or ref view, or add
 * configuration for one call: not passed to a git child. GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and
 * GIT_CONFIG_NOSYSTEM stay — they choose the user's own configuration files.
 */
const CALLER_ONLY = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS',
]);
/** The first git version with `--since-as-filter`: a committer-date filter that does not stop the walk. */
const SINCE_AS_FILTER = [2, 37];
/**
 * The refs read: branches, tags and remote-tracking branches — not the stash or notes, whose
 * commits are not work of their own (`--all` would count them).
 */
const REFS = ['--branches', '--tags', '--remotes'];
/** The escapes of a path git C-quotes (`"a\"b.md"`, `"tab\tc.md"`); a byte is `\ooo` in octal. */
const ESCAPES = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\' };

const isRepo = (dir) => existsSync(join(dir, '.git'));

/**
 * The checked-out submodules of `repo`, by the paths its `.gitmodules` names (read with `git config
 * --file`, nothing changed): those that are a repository on disk. None when it has no `.gitmodules`
 * or git cannot read it.
 *
 * @param {string} repo a repository path
 * @returns {string[]} the submodules' paths
 */
function submodulesOf(repo) {
  if (!existsSync(join(repo, '.gitmodules'))) return [];
  let out;
  try {
    out = execFileSync('git', ['-C', repo, 'config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], childOptions());
  } catch {
    return []; // no git, or a .gitmodules git cannot read: the repository alone
  }
  return out.split('\n').map((line) => line.replace(/^\S+\s/, '').trim()).filter(Boolean)
    .map((path) => join(repo, path)).filter((dir) => isRepo(dir));
}

/**
 * The repositories under the paths given as --repos: a path that is a repository is taken as is,
 * a folder is searched for repositories up to two levels below it, and every repository found brings
 * its checked-out submodules (and theirs), each a repository of its own. De-duplicated by real path.
 *
 * @param {string[]} paths what the user gave, relative to the working folder or absolute
 * @returns {string[]} the repositories' real paths
 */
export function findRepos(paths) {
  const found = new Set();
  const take = (repo) => {
    const real = realpathSync(repo);
    if (found.has(real)) return;
    found.add(real);
    for (const sub of submodulesOf(real)) take(sub);
  };
  const walk = (dir, depth) => {
    if (isRepo(dir)) { take(dir); return; }
    if (depth === REPO_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !NOT_SEARCHED.has(entry.name)) walk(join(dir, entry.name), depth + 1);
    }
  };
  for (const given of paths) {
    const path = resolve(given);
    if (!existsSync(path)) throw new UsageError(`--repos ${missingMessage(path, 'folder')}`);
    if (!statSync(path).isDirectory()) throw new UsageError(`--repos ${given} is not a folder`);
    const before = found.size;
    walk(path, 0);
    if (found.size === before && !isRepo(path)) throw new UsageError(`--repos ${given}: no git repository in it or ${REPO_DEPTH} levels below`);
  }
  return [...found].sort();
}

/**
 * What kind of file `path` is.
 *
 * @param {string} path a path in the repository
 * @param {RegExp[]} [generated] the user's paths whose lines are a tool's output (`generated` of the settings)
 * @returns {'generated'|'tests'|'other'|'docs'|'code'} generated: lock files, minified, maps,
 *   snapshots, vendored or built, and `generated`; tests: test folders and files, before the rest;
 *   other: config and data formats (`.json`, `.yaml`, `.toml`, …), before docs; docs: a doc extension
 *   wherever it lies; code: a known code extension wherever it lies; any other file (no extension, a
 *   dotfile, an unknown extension) is other
 */
export function fileKind(path, generated = []) {
  if (LOCK_FILES.has(basename(path).toLowerCase()) || GENERATED_FILE.test(path) || GENERATED_DIR.test(path)) return 'generated';
  if (generated.some((pattern) => pattern.test(path))) return 'generated';
  if (TESTS_FILE.test(path)) return 'tests';
  if (OTHER_FILE.test(path)) return 'other';
  if (DOCS_FILE.test(path)) return 'docs';
  return CODE_FILE.test(path) ? 'code' : 'other';
}

/** The path a numstat line names after a rename: `a => b` and `dir/{a => b}/f` → the new one. */
const renamedTo = (path) => path.replace(/\{[^{}]*? => ([^{}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');

/** The C-quoted path that starts at `start` of `text`: its value, and where it ends. */
function readQuoted(text, start) {
  const bytes = [];
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\' && /[0-7]/.test(text[i + 1] || '')) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 4;
    } else if (text[i] === '\\') {
      bytes.push(...Buffer.from(ESCAPES[text[i + 1]] ?? text[i + 1] ?? ''));
      i += 2;
    } else {
      bytes.push(...Buffer.from(text[i]));
      i += 1;
    }
  }
  return { value: Buffer.from(bytes).toString('utf8'), end: i + 1 };
}

/**
 * The path a numstat line names, after a rename the new one. A path with a quote, a backslash or
 * a control character stays C-quoted even with core.quotepath off, and a rename of one is then
 * written whole on each side (`"a\"b.md" => "c\"d.md"`), never in braces.
 */
function numstatPath(field) {
  if (!field.includes('"')) return renamedTo(field);
  const sides = [];
  for (let i = 0; i < field.length;) {
    if (field[i] === '"') {
      const quoted = readQuoted(field, i);
      sides.push(quoted.value);
      i = quoted.end;
    } else {
      const arrow = field.indexOf(' => ', i);
      const end = arrow < 0 ? field.length : arrow;
      sides.push(field.slice(i, end));
      i = end;
    }
    if (field.startsWith(' => ', i)) i += 4;
  }
  return sides.at(-1);
}

/** A literal in a git basic regular expression (the type forced by --basic-regexp). */
const literal = (text) => text.replace(/[\\.[\]*^$]/g, '\\$&');

/** The --author patterns: an email matches as `<email>` exactly, a name as a substring (case-insensitive). */
const authorPatterns = (authors) => authors.map((a) => (a.includes('@') ? `<${literal(a)}>` : literal(a)));

/**
 * The environment of a git child: `base` without the variables in CALLER_ONLY (nor
 * GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n), prompts off.
 *
 * @param {NodeJS.ProcessEnv} base the environment to start from (normally process.env)
 * @returns {Record<string, string>}
 */
export function gitChildEnvironment(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || CALLER_ONLY.has(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0' };
}

const childOptions = () => ({ encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'], env: gitChildEnvironment(process.env) });

const git = (repo, args) => execFileSync('git', ['-C', repo, ...PLAIN, ...args], childOptions());

/**
 * Run git in `repo` as this source does: the settings that change counts pinned (PLAIN), the caller's
 * repository variables shut out, prompts off. For the other sources that read the clones (team).
 *
 * @param {string} repo a repository path
 * @param {string[]} args git's arguments
 * @returns {string} its stdout
 * @throws {Error} when git exits non-zero (its stderr on `stderr`)
 */
export const runGit = (repo, args) => git(repo, args);

/** What `git version` prints here (for the other sources that read the clones, team), or '' when git does not run (every git log then fails and says why). */
export function installedGitVersion() {
  try {
    return execFileSync('git', ['version'], childOptions());
  } catch {
    return '';
  }
}

/**
 * The committer-date limit of git log for a period starting at `since`. git ≥ 2.37 filters with
 * `--since-as-filter` a day before `since` (the machine's zone may differ from --tz). An older git
 * has only `--since`, which stops the walk at the first commit committed before the date — after a
 * rebase with --committer-date-is-author-date, imported history or a skewed clock, the commits
 * behind it would be lost — so it gets no limit: with --author, git computes the numstat only for
 * the person's commits, and the author date decides in code.
 *
 * @param {string} versionText what `git version` printed, e.g. `git version 2.39.2 (Apple Git-143)`
 * @param {string} since the period's first date, `YYYY-MM-DD`
 * @returns {string[]} the arguments to add to git log
 */
export function dateLimit(versionText, since) {
  const [, major, minor] = String(versionText).match(/(\d+)\.(\d+)/) || [];
  const [needMajor, needMinor] = SINCE_AS_FILTER;
  const filters = Number(major) > needMajor || (Number(major) === needMajor && Number(minor) >= needMinor);
  return filters ? [`--since-as-filter=${addDays(since, -1)}T00:00`] : [];
}

/** The files of a `--numstat` listing: [{ path, added, deleted, binary }]. */
function numstatFiles(lines) {
  const files = [];
  for (const line of lines) {
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    files.push({ path: numstatPath(m[3]), added: Number(m[1]) || 0, deleted: Number(m[2]) || 0, binary: m[1] === '-' });
  }
  return files;
}

/**
 * The commits of one repository: [{ hash, at, email, subject, body, files }] — `body` the whole
 * message (subject included), `files` as `numstatFiles`.
 */
function commitsOf(repo, authors, limit) {
  // No --until: a commit authored in the period and rebased or amended after it keeps its author
  // date, which decides below in --tz.
  // A record starts at \x1e and its fields are split by \x1f: the message may hold newlines and tabs.
  const out = git(repo, [
    'log', ...REFS, '--no-merges', '--no-ext-diff', '--no-textconv', '--basic-regexp', '-i',
    ...limit,
    ...authorPatterns(authors).map((p) => `--author=${p}`),
    '--format=%x1e%H%x1f%aI%x1f%ae%x1f%s%x1f%B%x1f', '--numstat',
  ]);
  return out.split('\x1e').slice(1).map((chunk) => {
    const [hash, at, email, subject, body, numstat = ''] = chunk.split('\x1f');
    return { hash, at, email, subject, body, files: numstatFiles(numstat.split('\n')) };
  });
}

/** A plain authority — `host`, `host:port`, `[v6]`, `[v6]:port` — with no user or password in it. */
const PLAIN_AUTHORITY = /^([^:@[\]]*|\[[^\]]*\])(:\d*)?$/;

/**
 * A remote URL without its credentials: the user and password of a URL with a scheme
 * (`https://ada:token@host/x` → `https://host/x`) are dropped — up to the last `@` before the path
 * of the host, so a password with an unencoded `/` or `@` in it goes too; a URL whose `@` comes only
 * after a plain host (`https://host/o/r@x`) is in its path and stays. The scp form (`git@host:x`)
 * carries none and stays.
 *
 * @param {string} url a remote URL as git config holds it
 * @returns {string}
 */
export function withoutCredentials(url) {
  const text = String(url);
  const scheme = text.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0];
  if (!scheme) return text;
  const rest = text.slice(scheme.length);
  const firstAt = rest.indexOf('@');
  if (firstAt < 0) return text;
  const firstSlash = rest.indexOf('/');
  if (firstSlash >= 0 && firstSlash < firstAt && PLAIN_AUTHORITY.test(rest.slice(0, firstSlash))) return text;
  const pathAt = rest.indexOf('/', firstAt);
  const lastAt = rest.lastIndexOf('@', (pathAt < 0 ? rest.length : pathAt) - 1);
  return scheme + rest.slice(lastAt + 1);
}

/**
 * Where a remote points: its host ('' for a local path or a file URL) and its path without a leading
 * slash, a trailing slash or `.git`; null when it names no path.
 *
 * @param {string} url a remote URL (with a scheme, the scp form, or a local path)
 * @returns {{ host: string, path: string }|null}
 */
export function remoteLocation(url) {
  const text = withoutCredentials(String(url || '').trim());
  let host = '';
  let path = text;
  const scheme = text.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)(\/.*)?$/i);
  const scp = !scheme && text.match(/^(?:[^@/:]+@)?([^/:]{2,}):(.+)$/);
  if (scheme) [, host, path = ''] = scheme;
  else if (scp) [, host, path] = scp;
  if (/^file:/i.test(text)) host = '';
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return path ? { host: host.toLowerCase(), path } : null;
}

/**
 * A remote's identity, as the report matches a code host's repository against it: host and path,
 * lowercased, without scheme, credentials, port, trailing `.git` or `/` (`github.com/acme/app`,
 * `gitlab.example.com/group/sub/project`); null for a local path or a file URL, which no code host
 * serves.
 *
 * @param {string|null|undefined} url a remote URL (with a scheme, the scp form, or a local path)
 * @returns {string|null}
 */
export function remoteIdentity(url) {
  const at = remoteLocation(url);
  if (!at?.host) return null;
  return `${at.host.replace(/:\d*$/, '')}/${at.path}`.toLowerCase();
}

/**
 * The remote of `repo` (`remote.origin.url`) without its credentials, or null when it has none.
 *
 * @param {string} repo a repository path
 * @returns {string|null}
 */
function remoteOf(repo) {
  try {
    return withoutCredentials(git(repo, ['config', '--get', 'remote.origin.url']).trim()) || null;
  } catch {
    return null; // git config exits 1 when the key is not set
  }
}

/**
 * A short name per repository, the same for two clones of one remote: the remote's path
 * (`owner/name`, a GitLab `group/sub/project`) — with its host where two remotes share a path, the
 * folder name of a local remote — else the folder name, or parent/name where two share one.
 *
 * @param {string[]} repos repository paths
 * @param {Map<string, string|null>} remotes each one's remote (`remoteOf`)
 * @returns {Map<string, string>} repository path → label
 */
function repoLabels(repos, remotes) {
  const first = new Map(repos.map((r) => {
    const at = remoteLocation(remotes.get(r));
    if (!at) return [r, { key: `dir:${r}`, label: basename(r), wider: `${basename(dirname(r))}/${basename(r)}` }];
    const label = at.host ? at.path : basename(at.path);
    return [r, { key: `${at.host}:${at.path.toLowerCase()}`, label, wider: at.host ? `${at.host}/${at.path}` : `${basename(dirname(at.path))}/${label}` }];
  }));
  // A label two different repositories (keys) share is widened; clones of one remote keep theirs.
  const keys = new Map();
  for (const { key, label } of first.values()) keys.set(label, new Set([...(keys.get(label) || []), key]));
  return new Map(repos.map((r) => {
    const { label, wider } = first.get(r);
    return [r, keys.get(label).size > 1 ? wider : label];
  }));
}

const lines = (added, deleted) => `+${added} −${deleted}`;

/**
 * The address the user commits with in `repo`: its effective `git config user.email` (the
 * repository's own, else the user's), read with the git child's environment; null when none is set.
 *
 * @param {string} repo a repository path
 * @returns {string|null}
 */
export function repoUserEmail(repo) {
  try {
    return git(repo, ['config', 'user.email']).trim() || null;
  } catch {
    return null; // git config exits 1 when the key is not set
  }
}

/**
 * The text places match for `repo`: its path and its `remote.origin.url` without credentials (none
 * when it has no remote).
 *
 * @param {string} repo a repository path
 * @returns {string} `<path> <remote url>`, or the path alone
 */
export function repoWhere(repo) {
  const remote = remoteOf(repo);
  return remote ? `${repo} ${remote}` : repo;
}

/** The lines of `files` by kind — { code, tests, docs, other } as [added, deleted] — the generated ones and all of them summed. */
function linesOf(files, generated) {
  const byKind = zeroLines();
  let left = 0;
  let all = 0;
  for (const f of files) {
    if (f.binary) continue;
    all += f.added + f.deleted;
    const kind = fileKind(f.path, generated);
    if (kind === 'generated') { left += f.added + f.deleted; continue; }
    byKind[kind][0] += f.added;
    byKind[kind][1] += f.deleted;
  }
  return { byKind, generated: left, all };
}

function zeroLines() {
  return Object.fromEntries(KINDS.map((k) => [k, [0, 0]]));
}

function addLines(into, from) {
  for (const k of KINDS) {
    into[k][0] += from[k][0];
    into[k][1] += from[k][1];
  }
}

const sumLines = (byKind) => KINDS.reduce(([a, d], k) => [a + byKind[k][0], d + byKind[k][1]], [0, 0]);

/** Run git in `repo` as `git` does, with `input` on its stdin; its stdout as text, or a Buffer with `binary`. */
function gitInput(repo, args, input, binary = false) {
  const { encoding, ...options } = childOptions();
  return execFileSync('git', ['-C', repo, ...PLAIN, ...args], { ...options, ...(binary ? {} : { encoding }), input, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A path git may have C-quoted, as it is. */
const unquote = (field) => (field.startsWith('"') ? readQuoted(field, 0).value : field);

/** The path of a `+++ b/<path>` header line's text (without the `+++ `), or null for a deleted file. */
function plusPath(text) {
  const path = unquote(text.replace(/\t$/, ''));
  return path === '/dev/null' ? null : path.replace(/^b\//, '');
}

/** The longest pathspec, in characters, one `git log` call is given (the operating system limits an argument list). */
const PATHSPEC_BUDGET = 60000;
/** How a path is given to git literally — no glob, no magic. */
const PATHSPEC_MAGIC = ':(literal)';

/**
 * The tests-kind paths each of the commits `hashes` touched — the new path, and the old one of a
 * rename into a tests path (git pairs the two only when both are in the pathspec of the patch read).
 * One `git log --name-status` over them: no patches.
 *
 * @param {string} repo a repository path
 * @param {string[]} hashes full commit hashes
 * @param {RegExp[]} generated the user's generated paths
 * @returns {Map<string, string[]>} hash → paths
 */
function testPathsOf(repo, hashes, generated) {
  const out = gitInput(repo, [
    'log', '--stdin', '--no-walk=unsorted', '--no-ext-diff', '--no-textconv', '--name-status', '--format=%x1e%H',
  ], `${hashes.join('\n')}\n`);
  const paths = new Map();
  for (const chunk of out.split('\x1e').slice(1)) {
    const [hash, ...lines] = chunk.split('\n');
    const found = new Set();
    for (const line of lines) {
      const m = line.match(/^([A-Z])\d*\t(.+)$/);
      if (!m) continue;
      const names = m[2].split('\t').map(unquote);
      if (fileKind(names.at(-1), generated) === 'tests') names.forEach((name) => found.add(name));
    }
    if (found.size) paths.set(hash, [...found]); // no path: an empty pathspec would read every file
  }
  return paths;
}

/** The commits of `paths` (hash → its paths) in groups whose paths together fit one pathspec: [{ hashes, paths }]. */
function pathspecGroups(paths) {
  const groups = [];
  let group = null;
  let size = 0;
  for (const [hash, own] of paths) {
    const cost = (list) => list.reduce((n, p) => n + p.length + PATHSPEC_MAGIC.length, 0);
    if (group && size + cost(own.filter((p) => !group.paths.has(p))) > PATHSPEC_BUDGET) group = null;
    if (!group) {
      group = { hashes: [], paths: new Set() };
      groups.push(group);
      size = 0;
    }
    size += cost(own.filter((p) => !group.paths.has(p)));
    own.forEach((p) => group.paths.add(p));
    group.hashes.push(hash);
  }
  return groups;
}

/**
 * The test functions the commits `hashes` added: added lines of a tests-kind file that open a test
 * (`TEST_FUNCTION`), from `git log -p -U0` limited to the tests-kind paths the commits touched, so a
 * large lock or generated file in the same commit is never read.
 *
 * @param {string} repo a repository path
 * @param {string[]} hashes full commit hashes
 * @param {RegExp[]} generated the user's generated paths
 * @returns {Map<string, number>} hash → test functions added
 */
function testsAddedBy(repo, hashes, generated) {
  const counts = new Map();
  if (!hashes.length) return counts;
  for (const { hashes: group, paths } of pathspecGroups(testPathsOf(repo, hashes, generated))) {
    const out = gitInput(repo, [
      'log', '--stdin', '--no-walk=unsorted', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
      '-p', '-U0', '--format=%x1e%H', '--', ...[...paths].map((p) => PATHSPEC_MAGIC + p),
    ], `${group.join('\n')}\n`);
    for (const chunk of out.split('\x1e').slice(1)) {
      const [hash, ...patch] = chunk.split('\n');
      counts.set(hash, testFunctionsIn(patch, generated));
    }
  }
  return counts;
}

/** The added test functions in the lines of a `-U0` patch: those in the files of kind tests. */
function testFunctionsIn(patch, generated) {
  let header = false; // between a `diff --git` line and its first hunk: the lines there are not content
  let inTests = false;
  let count = 0;
  for (const line of patch) {
    if (line.startsWith('diff --git ')) {
      header = true;
      inTests = false;
    } else if (header && line.startsWith('+++ ')) {
      const path = plusPath(line.slice(4));
      inTests = path !== null && fileKind(path, generated) === 'tests';
    } else if (header) {
      header = !line.startsWith('@@');
    } else if (inTests && TEST_FUNCTION.some((pattern) => pattern.test(line))) {
      count += 1;
    }
  }
  return count;
}

/**
 * The tags of `repo` with their creator dates.
 *
 * @param {string} repo a repository path
 * @returns {{ name: string, at: string }[]} `at` an ISO instant
 */
function tagsOf(repo) {
  const out = git(repo, ['for-each-ref', 'refs/tags', '--format=%(refname:lstrip=2)%09%(creatordate:iso-strict)']);
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, at] = line.split('\t');
    return { name, at };
  });
}

/**
 * The oldest tag (by creator date, ties by name) containing each of the commits `wanted`, from one
 * `git rev-list` per tag — the commits a tag adds over the tags before it — instead of one
 * `git tag --contains` per commit; it stops at the tag that settles the last commit.
 *
 * @param {string} repo a repository path
 * @param {{ name: string, at: string }[]} tags the repository's tags
 * @param {Set<string>} wanted full commit hashes
 * @returns {Map<string, { tag: string, at: string }>} hash → its first tag; a commit no tag contains is left out
 */
function firstTagsOf(repo, tags, wanted) {
  const found = new Map();
  const ordered = [...tags].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.name.localeCompare(b.name));
  const before = [];
  for (const { name, at } of ordered) {
    if (found.size === wanted.size) break;
    const ref = `refs/tags/${name}^{commit}`;
    let out;
    try {
      out = gitInput(repo, ['rev-list', '--stdin'], `${ref}\n${before.map((earlier) => `^${earlier}`).join('\n')}\n`);
    } catch {
      continue; // a tag of a tree or a blob contains no commit
    }
    before.push(ref);
    for (const hash of out.split('\n')) if (wanted.has(hash) && !found.has(hash)) found.set(hash, { tag: name, at });
  }
  return found;
}

/**
 * Add what the commits mean to their events: the test functions added (one `git log -p` for the
 * commits with a test file) and, for those naming a code, a key or a decision folder, the oldest tag
 * containing them. A pipeline repository's commits add no tests (their lines are a tool's output).
 *
 * @param {string} repo a repository path
 * @param {{ commit: object, event: object, pipeline: boolean }[]} kept the repository's counted commits
 * @param {{ generated: RegExp[], tags: { name: string, at: string }[] }} context
 * @returns {number} the test functions added in all of them
 */
function addMeaning(repo, kept, { generated, tags }) {
  const tested = kept.filter(({ commit, pipeline }) => !pipeline
    && commit.files.some((f) => !f.binary && fileKind(f.path, generated) === 'tests')).map(({ commit }) => commit.hash);
  const counts = testsAddedBy(repo, tested, generated);
  const isNamed = ({ detail }) => detail.codes.length || detail.keys.length || detail.decisionDirs.length;
  const named = new Set(kept.filter(({ event }) => isNamed(event)).map(({ commit }) => commit.hash));
  const releases = tags.length && named.size ? firstTagsOf(repo, tags, named) : new Map();
  let total = 0;
  for (const { commit, event } of kept) {
    event.detail.testsAdded = counts.get(commit.hash) ?? 0;
    total += event.detail.testsAdded;
    if (releases.has(commit.hash)) event.detail.releasedIn = releases.get(commit.hash);
  }
  return total;
}

/** The blobs `specs` (`<sha>:<path>`) name, read in one `git cat-file --batch`: spec → text, absent ones left out. */
function blobTexts(repo, specs) {
  const texts = new Map();
  if (!specs.length) return texts;
  const out = gitInput(repo, ['cat-file', '--batch'], `${specs.join('\n')}\n`, true);
  let at = 0;
  for (const spec of specs) {
    const end = out.indexOf(10, at);
    const header = out.toString('utf8', at, end);
    at = end + 1;
    const m = header.match(/ (blob|tree|commit|tag) (\d+)$/);
    if (!m) continue; // `<spec> missing`
    const size = Number(m[2]);
    if (m[1] === 'blob') texts.set(spec, out.toString('utf8', at, at + size));
    at += size + 1;
  }
  return texts;
}

/**
 * The `.md` documents ever under `dir` on the read refs (one `git log --name-status` over them,
 * oldest first): per path the first add — the oldest, following a rename to its new name — and the
 * newest commit that touched it. A path added on two branches, or on one merged back, is one path.
 *
 * @param {string} repo a repository path
 * @param {string[]} dirs folders of the repository: one walk reads them all
 * @returns {Map<string, { first: object, last: { hash: string, at: string } }>} path → its history, of
 *   the paths under any of `dirs`; `first` is `{ at, name, email }`
 */
function documentHistory(repo, dirs) {
  const out = git(repo, [
    'log', ...REFS, '--no-merges', '--topo-order', '--reverse', '--no-ext-diff', '--name-status',
    '--format=%x1e%H%x1f%aI%x1f%an%x1f%ae', '--', ...dirs,
  ]);
  const docs = new Map();
  const touch = (path, commit, first) => {
    const known = docs.get(path);
    const older = !known || Date.parse(first.at) < Date.parse(known.first.at) ? first : known.first;
    const newest = !known || Date.parse(commit.at) >= Date.parse(known.last.at) ? { hash: commit.hash, at: commit.at } : known.last;
    docs.set(path, { first: older, last: newest });
  };
  for (const chunk of out.split('\x1e').slice(1)) {
    const [head, ...lines] = chunk.split('\n');
    const [hash, at, name, email] = head.split('\x1f');
    const commit = { hash, at, name, email };
    for (const line of lines) {
      const m = line.match(/^([A-Z])\d*\t(.+)$/);
      if (!m) continue;
      const paths = m[2].split('\t').map(unquote);
      const to = paths.at(-1);
      if (m[1] === 'R' && docs.has(paths[0])) touch(paths[0], commit, docs.get(paths[0]).first);
      if (!/\.md$/i.test(to)) continue;
      touch(to, commit, m[1] === 'R' ? (docs.get(paths[0])?.first ?? commit) : commit);
    }
  }
  return docs;
}

/**
 * The status a document's text states: the first line that starts with the word `status` (after
 * optional markdown markers — `#`, `>`, `*`, `_`, `-` — and spaces; a title that merely contains the
 * word does not count), read by the first of accepted, superseded, proposed or draft (draft is
 * proposed) on it, else `other`; and the first date on that line.
 *
 * @param {string} text a document's text
 * @returns {{ status: 'accepted'|'superseded'|'proposed'|'other', date: string|null }}
 */
export function statusOf(text) {
  const line = text.split('\n').find((l) => STATUS_LINE.test(l));
  if (line === undefined) return { status: 'other', date: null };
  const word = line.match(STATUS_WORD)?.[0].toLowerCase();
  const status = word === 'draft' ? 'proposed' : word || 'other';
  return { status, date: line.match(ISO_DATE)?.[0] ?? null };
}

/** Whether a commit author is the person: an email exactly, a name as a substring, case-insensitive (as `--author`). */
const isPerson = ({ name, email }, authors) => authors.some((a) => (a.includes('@')
  ? a.toLowerCase() === email.toLowerCase() : `${name} <${email}>`.toLowerCase().includes(a.toLowerCase())));

/**
 * The decision-document paths among the files a commit touched: the `.md` files under `dirs`, a path
 * once (the first folder that holds it), in an `adr` folder only files named `NNNN-*.md` — the rules
 * `decisionDocuments` applies, so a path here is the `detail.path` of that document's event.
 *
 * @param {{ path: string }[]} files the commit's files
 * @param {readonly string[]} dirs the decision folders, without a trailing slash
 * @returns {string[]} the paths, in the order of the files
 */
function decisionPathsOf(files, dirs) {
  const taken = new Set();
  for (const dir of dirs) {
    for (const { path } of files) {
      if (taken.has(path) || !path.startsWith(`${dir}/`) || !/\.md$/i.test(path) || path.includes('\n')) continue;
      if (basename(dir) === 'adr' && !ADR_NAME.test(basename(path))) continue;
      taken.add(path);
    }
  }
  return files.map((f) => f.path).filter((path, n, all) => taken.has(path) && all.indexOf(path) === n);
}

/**
 * The decision documents of `repo` whose first add or decision date is in the period, as events —
 * from every folder of `dirs`, over the read refs, a path once and only if it exists at the newest
 * commit that touched it; in an `adr` folder only files named `NNNN-*.md`.
 *
 * @param {string} repo a repository path
 * @param {{ dirs: readonly string[], codes: RegExp|string, authors: string[], label: string, where: string,
 *   period: { since: string, until: string, tz: string, dayStartsMin: number } }} context
 * @returns {{ events: object[], documents: number }} the events, and the documents read
 */
function decisionDocuments(repo, { dirs, codes, authors, label, where, period }) {
  const events = [];
  const taken = new Set();
  let documents = 0;
  const within = (date) => date >= period.since && date <= period.until;
  const folders = dirs.map((d) => d.replace(/\/+$/, '')).filter(Boolean);
  if (!folders.length) return { events, documents };
  const history = documentHistory(repo, folders);
  for (const dir of folders) {
    const kept = [...history].filter(([path]) => path.startsWith(`${dir}/`) && !taken.has(path) && !path.includes('\n')
      && (basename(dir) !== 'adr' || ADR_NAME.test(basename(path))));
    const texts = blobTexts(repo, kept.map(([path, { last }]) => `${last.hash}:${path}`));
    for (const [path, { first, last }] of kept) {
      const text = texts.get(`${last.hash}:${path}`);
      if (text === undefined) continue; // gone at the newest commit that touched it: deleted or renamed
      taken.add(path);
      documents += 1;
      const added = workingDate(first.at, period);
      const { status, date } = statusOf(text);
      const decided = date ?? added;
      if (!within(added) && !within(decided)) continue;
      events.push({
        id: `doc:${label}:${path}`, at: first.at, kind: 'decision document', action: false, what: `${label}: ${path}`, where,
        detail: {
          repo: label, path, dir, status, added, decided, firstAuthor: { name: first.name, email: first.email },
          byPerson: isPerson(first, authors), codes: codesIn(text, codes), words: wordsOf(text),
        },
      });
    }
  }
  return { events, documents };
}

/** The entries of a repository's `CHANGELOG.md` at HEAD that are dated: [{ version, date, breaking }]; none when it has none. */
function changelogEntries(repo) {
  let text;
  try {
    text = git(repo, ['show', 'HEAD:CHANGELOG.md']);
  } catch {
    return []; // no CHANGELOG.md at HEAD (or no commit yet)
  }
  const entries = [];
  let entry = null;
  for (const line of text.split('\n')) {
    if (/^##(?!#)/.test(line)) {
      const m = line.match(CHANGELOG_HEADING);
      entry = m ? { version: m[1], date: m[2], breaking: false } : null;
      if (entry) entries.push(entry);
    } else if (entry && CHANGELOG_BREAKING.test(line)) {
      entry.breaking = true;
    }
  }
  return entries;
}

/** The person's oldest non-merge commit over the read refs: { hash, at, subject }, or null when there is none. */
function firstCommitOf(repo, authors) {
  const out = git(repo, [
    'log', ...REFS, '--no-merges', '--no-ext-diff', '--basic-regexp', '-i',
    ...authorPatterns(authors).map((p) => `--author=${p}`), '--format=%H%x1f%aI%x1f%s',
  ]);
  const commits = out.split('\n').filter(Boolean).map((line) => {
    const [hash, at, subject] = line.split('\x1f');
    return { hash, at, subject };
  });
  return commits.reduce((oldest, c) => (!oldest || Date.parse(c.at) < Date.parse(oldest.at) ? c : oldest), null);
}

/** The lines of a text: its newline-ended lines, the last one counted without its newline. */
const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/**
 * The work in `repo` not yet committed, one event per file: tracked changes against HEAD (numstat)
 * and untracked files not ignored (their lines counted from the text), dated by the file's
 * modification time (a deleted file, now). Generated files are left out.
 *
 * @param {string} repo a repository path
 * @param {{ generated: RegExp[], label: string, where: string }} context
 * @returns {{ events: object[], unread: number }} the events, and the untracked files not read for lines (over the cap)
 */
function uncommittedWork(repo, { generated, label, where }) {
  const mtime = (path) => {
    try {
      return statSync(join(repo, path)).mtime.toISOString();
    } catch {
      return new Date().toISOString(); // a tracked file deleted in the working tree
    }
  };
  const event = (path, byKind, untracked) => ({
    id: `uncommitted:${label}:${path}`, at: mtime(path), kind: 'uncommitted', action: false, snapshot: true,
    what: `${label}: ${path} (not yet committed)`, where, lines: byKind, detail: { repo: label, path, untracked },
  });
  const events = [];
  let tracked = '';
  try {
    tracked = git(repo, ['diff', '--numstat', 'HEAD']);
  } catch {
    // no commit yet: nothing is tracked against HEAD
  }
  for (const file of numstatFiles(tracked.split('\n'))) {
    if (fileKind(file.path, generated) !== 'generated') events.push(event(file.path, linesOf([file], generated).byKind, false));
  }
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const path of untracked.slice(0, UNTRACKED_MAX)) {
    if (fileKind(path, generated) === 'generated') continue;
    const full = join(repo, path);
    let added = 0;
    try {
      if (statSync(full).size <= UNTRACKED_MAX_BYTES) {
        const content = readFileSync(full);
        added = content.includes(0) ? 0 : lineCount(content.toString('utf8'));
      }
    } catch {
      continue; // gone or unreadable since the listing
    }
    const byKind = zeroLines();
    byKind[fileKind(path, generated)][0] = added;
    events.push(event(path, byKind, true));
  }
  return { events, unread: Math.max(0, untracked.length - UNTRACKED_MAX) };
}

/**
 * The facts of one repository, as events with `action: false`: its decision documents, tags and
 * CHANGELOG entries of the period, the person's first commit (a snapshot) and, with `uncommitted`,
 * the work not yet committed (snapshots, not limited to the period).
 *
 * @param {string} repo a repository path
 * @param {{ label: string, where: string, authors: string[], dirs: string[], codes: RegExp|string,
 *   tags: { name: string, at: string }[], uncommitted: boolean, generated?: RegExp[],
 *   period: { since: string, until: string, tz: string, dayStartsMin: number } }} context
 * @returns {{ events: object[], documents: number, changelog: boolean, unread: number }}
 *   `documents` read, whether a CHANGELOG was found, untracked files not read
 */
function repositoryFacts(repo, { label, where, authors, dirs, codes, tags, uncommitted, generated = [], period }) {
  const documents = decisionDocuments(repo, { dirs, codes, authors, label, where, period });
  const events = [...documents.events];
  for (const { name, at } of tags) {
    if (!inWorkingPeriod(at, period)) continue;
    events.push({ id: `tag:${label}:${name}`, at, kind: 'tag', action: false, what: `${label}: ${name}`, where, detail: { repo: label, tag: name } });
  }
  const entries = changelogEntries(repo);
  for (const { version, date, breaking } of entries) {
    if (date < period.since || date > period.until) continue;
    events.push({
      id: `changelog:${label}:${version}`, date, kind: 'changelog entry', action: false, what: `${label}: ${version}`, where,
      detail: { repo: label, version, breaking },
    });
  }
  const first = firstCommitOf(repo, authors);
  if (first) {
    events.push({
      id: `first-commit:${label}`, at: first.at, kind: 'first commit', action: false, snapshot: true, what: `${label}: ${first.subject}`, where,
      detail: { repo: label, hash: first.hash },
    });
  }
  const work = uncommitted ? uncommittedWork(repo, { generated, label, where }) : { events: [], unread: 0 };
  return { events: [...events, ...work.events], documents: documents.documents, changelog: entries.length > 0, unread: work.unread };
}

/**
 * What the commits of one repository mean and its facts: the tests added and releasedIn put on
 * `kept`'s events, and `repositoryFacts`.
 *
 * @param {string} repo a repository path
 * @param {{ commit: object, event: object, pipeline: boolean }[]} kept the repository's counted commits
 * @param {object} context `repositoryFacts`' context without `tags`
 * @returns {{ events: object[], testsAdded: number, documents: number, tags: number, changelogs: number, unread: number }}
 *   `tags` read, `changelogs` 1 when a CHANGELOG was found
 */
function readMeaning(repo, kept, context) {
  const tags = tagsOf(repo);
  const testsAdded = addMeaning(repo, kept, { generated: context.generated, tags });
  const found = repositoryFacts(repo, { ...context, tags });
  return { events: found.events, testsAdded, documents: found.documents, tags: tags.length, changelogs: found.changelog ? 1 : 0, unread: found.unread };
}

/** Keep `fact` in `facts` by its id; of one repository cloned twice, a first commit is the older of the two. */
function keepFact(facts, fact) {
  const known = facts.get(fact.id);
  if (!known || (fact.kind === 'first commit' && Date.parse(fact.at) < Date.parse(known.at))) facts.set(fact.id, fact);
}

/** A skip_commits rule as the notes name it: its pattern, and the repositories it is limited to. */
const skipText = (rule) => (rule.repos.length ? `${rule.pattern.source} in ${rule.repos.join(', ')}` : rule.pattern.source);

/** `1 repository`, `3 repositories`. */
const repositories = (n) => `${n} repositor${n === 1 ? 'y' : 'ies'}`;

/**
 * The notes that say what a git collection read and what it left out (definitions of the kinds of
 * lines, tests, decision documents, `releasedIn`, uncommitted work, skipped commits, pipeline lines).
 *
 * @param {{ repos: string[], authors: string[], ownEmails: Map<string, string[]>, perRepo: Map<string, object>,
 *   generated: RegExp[], dirs: string[], seenFacts: { documents: number, tags: number, changelogs: number, unread: number },
 *   uncommitted: boolean, total: { skipped: number, skippedLines: number }, skipCommits: { pattern: RegExp, repos: string[] }[],
 *   pipelines: Map<string, number[]> }} read what `collectGit` gathered
 * @returns {string[]}
 */
function sourceNotes({ repos, authors, ownEmails, perRepo, generated, dirs, seenFacts, uncommitted, total, skipCommits, pipelines }) {
  return [
    `${repositories(repos.length)} searched, ${perRepo.size} with commits; authors matched: ${[...authors, ...ownEmails.keys()].join(', ')}`,
    ...(ownEmails.size ? [`with --me, the addresses the repositories' git configurations give (user.email) are matched in every repository: ${
      [...ownEmails].map(([email, where]) => `${email} (set in ${where.join(', ')})`).join('; ')}`] : []),
    'branches, tags and remote-tracking branches are read (not the stash or notes); they hold only what was fetched into the clones: fetch them first',
    ...(authors.some((a) => !a.includes('@')) ? ['a name matches as a substring; its case may be ignored for ASCII letters only, so pass a name with accents as the commits write it'] : []),
    `lines of generated files (lock files, minified, source maps, snapshots, vendored or built folders${generated.length ? ', the settings\' generated paths' : ''}) `
      + 'are left out of the code, tests, docs and other lines; tests are test folders and test files; other is config and data '
      + '(.json .yaml .yml .toml .ini .cfg .conf .csv .tsv .xml .properties .env.example, and any file with no known code or doc extension, such as dotfiles); binary files count as files only',
    'tests added: added lines in test files that open a test function (Python def test_, JavaScript it( / test(, Rust #[test], Go func Test, Java @Test)',
    `decision documents: .md files ever under ${dirs.join(', ') || '(no folder)'} on any branch, tag or remote-tracking branch, counted once by path, `
      + 'only if present at the newest commit that touched them (in an adr folder, files named NNNN-*.md); '
      + `${seenFacts.documents} document(s) read in all, those added or decided in the period are events`,
    `releasedIn: the oldest tag containing a commit that names a decision code, a task key or touches a decision folder; ${seenFacts.tags} tag(s) read; `
      + `CHANGELOG.md read at HEAD in ${repositories(seenFacts.changelogs)}; tags, CHANGELOG entries and decision documents are repository facts, not the person's actions`,
    ...(uncommitted ? [`uncommitted work: tracked changes against HEAD and untracked files not ignored, dated by file modification${
      seenFacts.unread ? `; ${seenFacts.unread} untracked file(s) beyond the first ${UNTRACKED_MAX} of a repository not read` : ''}; files over ${UNTRACKED_MAX_BYTES / 1024 / 1024} MB or binary have no lines`] : []),
    ...(total.skipped ? [`${total.skipped} commit(s) whose subject matches skip_commits (${skipCommits.map(skipText).join(', ')}) left out of everything: ${total.skippedLines} lines in them`] : []),
    ...(pipelines.size ? [`pipeline_repos — commits counted, their lines only in pipeline lines, their files not in files changed: ${
      [...pipelines].map(([label, [a, d]]) => `${label} ${lines(a, d)}`).join(', ')}`] : []),
    'a repository is named by its remote (owner/name), so two clones of one remote are one repository and a commit in both counts once; '
      + 'submodules of a repository found are read as repositories of their own',
  ];
}

/**
 * The git source over `repos`: the commits whose author matches one of `authors` (emails exactly,
 * names as a substring) and whose author date falls in the period in `tz`, each counted once
 * however many clones or refs carry it — by its hash, and by its author, author date and subject,
 * so the copy a rebase or a cherry-pick left on another branch is not counted again. A commit whose
 * subject matches `skipCommits` is left out of everything and counted apart; a commit of a
 * repository `pipelineRepos` names keeps its event, and its lines go to the pipeline lines alone.
 * A repository is named by its remote (`repoLabels`): two clones of one remote are one row. Each
 * event is `{ id: <hash>, at, kind: 'commit', what: '<repo>: <subject>', where: '<path> <remote url>',
 * lines?: { code, tests, docs, other }, detail: { repo, testsAdded, codes, keys, decisionDirs,
 * decisionPaths, releasedIn? } }` — the remote without credentials, no `lines` on a pipeline repository's commit; the
 * codes and keys are those of its subject and body, `decisionPaths` the decision documents it touched
 * (the `detail.path` of their events). The facts of the repositories follow the commits as
 * events with `action: false`: `decision document`, `tag`, `changelog entry`, and the snapshots
 * `first commit` and (with `uncommitted`) `uncommitted` (docs/design/footprint.md § Meaning of
 * changes). `remotes` are the identities (`remoteIdentity`) of the repositories whose history was read,
 * with or without commits of the person — no local path: the report matches a code host's commit
 * against them.
 *
 * @param {string[]} repos repository paths, from `findRepos`
 * @param {{ authors: string[], meEmails?: boolean, since: string, until: string, tz: string, dayStartsMin?: number,
 *   skipCommits?: { pattern: RegExp, repos: string[] }[], generated?: RegExp[], pipelineRepos?: string[],
 *   decisionDirs?: readonly string[], codes?: RegExp|string, uncommitted?: boolean }} query
 *   `dayStartsMin` the working day's start: a commit belongs to the period by its working day;
 *   `decisionDirs` and `codes` the user's `decision_dirs` and `decision_codes` (defaults of meaning.mjs);
 *   `uncommitted` adds the work not yet committed, as snapshot events;
 *   `meEmails` adds, in each repository, the address the user commits with there (`repoUserEmail`);
 *   `skipCommits`, `generated` and `pipelineRepos` are the user's settings (places.mjs
 *   `footprintSettings`), `pipelineRepos` lowercased substrings of a repository's `repoWhere`
 * @param {{ gitVersion?: () => string }} [options] what `git version` prints (tests give another)
 * @returns {object} a source result (report.mjs); with `partial: true` and `partialReasons` (the notes
 *   of the repositories whose log or meaning could not be read) when some repository failed
 * @throws {UsageError} when there is no repository or author, or git log failed in every repository
 */
export function collectGit(repos, {
  authors, meEmails = false, since, until, tz, dayStartsMin = 0, skipCommits = [], generated = [], pipelineRepos = [],
  decisionDirs = DEFAULT_DECISION_DIRS, codes = DEFAULT_DECISION_CODES, uncommitted = false,
}, { gitVersion = installedGitVersion } = {}) {
  if (!repos.length) throw new UsageError('no repository: pass --repos <a repository or a folder of repositories>');
  if (!authors.length && !meEmails) throw new UsageError('no author: pass --email or --name (or --me)');
  const limit = dateLimit(gitVersion(), since);
  const dirs = decisionDirs.map((d) => d.replace(/\/+$/, '')).filter(Boolean);
  const remotes = new Map(repos.map((r) => [r, remoteOf(r)]));
  const labels = repoLabels(repos, remotes);
  // Rows, files and pipeline lines are kept per label: two clones of one remote are one repository.
  const seen = new Set();
  const perRepo = new Map();
  const files = new Set();
  const total = { commits: 0, lines: zeroLines(), generated: 0, skipped: 0, skippedLines: 0, pipeline: [0, 0], testsAdded: 0 };
  const events = [];
  const notes = [];
  const failures = [];
  // What reading the meaning of the changes could not do in a repository (its commits still count).
  const meaningFailures = [];
  // The facts of the repositories by id (a repository cloned twice gives one), and what was read for them.
  const facts = new Map();
  const seenFacts = { documents: 0, tags: 0, changelogs: 0, unread: 0 };
  // The pipeline repositories with commits: repository → [added, deleted].
  const pipelines = new Map();
  const wheres = new Map();
  // The remote identities of the repositories whose history was read (`remoteIdentity`).
  const read = new Set();
  // The repositories' own addresses that --me adds beyond `authors`: address → the repositories.
  const ownEmails = new Map();
  if (meEmails) {
    for (const repo of repos) {
      const own = repoUserEmail(repo);
      if (!own || authors.some((a) => a.toLowerCase() === own.toLowerCase())) continue;
      const key = [...ownEmails.keys()].find((e) => e.toLowerCase() === own.toLowerCase()) || own;
      ownEmails.set(key, [...(ownEmails.get(key) || []), labels.get(repo)]);
    }
  }
  // The person is one across the clones: an address one clone's configuration gives is matched in
  // every clone, as they may commit under another address than the one a clone is set to.
  const repoAuthors = [...authors, ...ownEmails.keys()];
  for (const repo of repos) {
    // No author at all would make git log match everyone.
    if (!repoAuthors.length) {
      failures.push(`${labels.get(repo)}: no author to match (no --email or --name, no git user.email there)`);
      continue;
    }
    let commits;
    try {
      commits = commitsOf(repo, repoAuthors, limit);
    } catch (e) {
      failures.push(`${labels.get(repo)}: git log failed (${String(e.stderr || e.message).trim().split('\n')[0]})`);
      continue;
    }
    const identity = remoteIdentity(remotes.get(repo));
    if (identity) read.add(identity);
    const label = labels.get(repo);
    const where = remotes.get(repo) ? `${repo} ${remotes.get(repo)}` : repo;
    if (!wheres.has(label)) wheres.set(label, where);
    const lowered = where.toLowerCase();
    const pipeline = pipelineRepos.some((p) => lowered.includes(p));
    const skips = skipCommits.filter((rule) => !rule.repos.length || rule.repos.some((r) => lowered.includes(r)));
    const kept = [];
    for (const c of commits) {
      // The working day (day_starts), as the report lays the commit.
      const date = workingDate(c.at, { tz, dayStartsMin });
      const copy = `${c.email.toLowerCase()}\0${c.at}\0${c.subject}`;
      if (date < since || date > until || seen.has(c.hash) || seen.has(copy)) continue;
      seen.add(c.hash).add(copy);
      const counted = linesOf(c.files, generated);
      if (skips.some((rule) => rule.pattern.test(c.subject))) {
        total.skipped += 1;
        total.skippedLines += counted.all;
        continue;
      }
      const row = perRepo.get(label) || { commits: 0, lines: zeroLines(), first: date, last: date };
      row.commits += 1;
      if (date < row.first) row.first = date;
      if (date > row.last) row.last = date;
      perRepo.set(label, row);
      total.commits += 1;
      total.generated += counted.generated;
      const message = `${c.subject}\n${c.body}`;
      const event = {
        id: c.hash, at: c.at, kind: 'commit', what: `${label}: ${c.subject}`, where,
        detail: {
          repo: label, testsAdded: 0, codes: codesIn(message, codes), keys: keysIn(message),
          decisionDirs: dirs.filter((d) => c.files.some((f) => f.path.startsWith(`${d}/`))),
          decisionPaths: decisionPathsOf(c.files, dirs),
        },
      };
      kept.push({ commit: c, event, pipeline });
      if (pipeline) {
        const [a, d] = sumLines(counted.byKind);
        const [pa, pd] = pipelines.get(label) || [0, 0];
        pipelines.set(label, [pa + a, pd + d]);
        total.pipeline = [total.pipeline[0] + a, total.pipeline[1] + d];
      } else {
        for (const f of c.files) files.add(`${label}\0${f.path}`);
        addLines(row.lines, counted.byKind);
        addLines(total.lines, counted.byKind);
        event.lines = counted.byKind;
      }
      events.push(event);
    }
    try {
      const found = readMeaning(repo, kept, {
        label, where, authors: repoAuthors, period: { since, until, tz, dayStartsMin }, dirs, codes, generated, uncommitted: uncommitted && !pipeline,
      });
      total.testsAdded += found.testsAdded;
      for (const fact of found.events) keepFact(facts, fact);
      for (const k of Object.keys(seenFacts)) seenFacts[k] += found[k];
    } catch (e) {
      meaningFailures.push(`${label}: reading what the commits mean (tests, tags, decision documents, changelog) failed (${String(e.stderr || e.message).trim().split('\n')[0]})`);
    }
  }
  if (failures.length === repos.length) throw new UsageError(`git log failed in every repository searched; ${failures[0]}`);
  notes.push(...failures, ...meaningFailures);
  // A repository whose log or meaning could not be read leaves the crawl incomplete (the store keeps
  // what it held before for the span, D-FP3-PARTIAL-RECRAWL).
  const partialReasons = [...failures, ...meaningFailures];
  events.push(...facts.values());
  const ordered = [...perRepo.entries()].sort((a, b) => b[1].commits - a[1].commits);
  notes.push(...sourceNotes({
    repos, authors, ownEmails, perRepo, generated, dirs, seenFacts, uncommitted, total, skipCommits, pipelines,
  }));
  return {
    source: 'git',
    label: `git (${repos.length} local repositor${repos.length === 1 ? 'y' : 'ies'})`,
    totals: [
      ['commits', total.commits],
      ['repositories', perRepo.size],
      ['files changed', files.size],
      ...KINDS.map((k) => [`${k} lines`, lines(...total.lines[k])]),
      ['generated lines left out', total.generated],
      ['commits left out by skip_commits', total.skipped],
      ['pipeline lines', lines(...total.pipeline)],
      ['tests added', total.testsAdded],
    ],
    events,
    remotes: [...read].sort(),
    breakdown: {
      title: 'per repository',
      header: ['Repository', 'Commits', 'Code +', 'Code −', 'Tests +', 'Tests −', 'Docs +', 'Docs −', 'Other +', 'Other −', 'First', 'Last'],
      rows: ordered.map(([label, r]) => [label, r.commits, ...KINDS.flatMap((k) => r.lines[k]), r.first, r.last]),
      wheres: ordered.map(([label]) => wheres.get(label)),
    },
    notes,
    ...(partialReasons.length ? { partial: true, partialReasons } : {}),
  };
}

/**
 * The authors in `repos` whose name or email contains `name` (case-insensitive), from
 * `git shortlog -sne` over the branches, tags and remote-tracking branches, with their commits
 * summed over the repositories.
 *
 * @param {string[]} repos repository paths, from `findRepos`
 * @param {string} name a person's name or part of it
 * @returns {{ name: string, email: string, commits: number, repositories: number }[]} most commits first
 */
export function identifyGit(repos, name) {
  if (!repos.length) throw new UsageError('no repository: pass --repos <a repository or a folder of repositories>');
  const wanted = name.toLowerCase();
  return shortlogAuthors(repos, (author, email) => `${author} ${email}`.toLowerCase().includes(wanted));
}

/**
 * The user's own git addresses: `email` (the installation's `git config user.email`) and, in each
 * of `repos`, the address the user commits with there (`repoUserEmail`) — as the authors of
 * `identifyGit` that carry one of them exactly (case-insensitive), and an address no commit of
 * `repos` carries with `commits` null.
 *
 * @param {string[]} repos repository paths, from `findRepos` (may be empty)
 * @param {string|null} email the installation's git email
 * @returns {{ name: string, email: string, commits: number|null, repositories: number }[]} most commits first
 */
export function identifyGitMe(repos, email) {
  const emails = new Map();
  for (const e of [email, ...repos.map((r) => repoUserEmail(r))]) if (e && !emails.has(e.toLowerCase())) emails.set(e.toLowerCase(), e);
  const found = repos.length ? shortlogAuthors(repos, (_, e) => emails.has(e.toLowerCase())) : [];
  const unseen = [...emails].filter(([lower]) => !found.some((a) => a.email.toLowerCase() === lower));
  return [...found, ...unseen.map(([, e]) => ({ name: '', email: e, commits: null, repositories: 0 }))];
}

/** The authors of `git shortlog -sne` over `repos` that `keep(name, email)` accepts, commits summed. */
function shortlogAuthors(repos, keep) {
  const authors = new Map();
  for (const repo of repos) {
    let out;
    try {
      out = git(repo, ['shortlog', '-sne', ...REFS]);
    } catch {
      continue; // an empty repository has no history to read
    }
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\t(.*?) <([^>]*)>$/);
      if (!m || !keep(m[2], m[3])) continue;
      const key = `${m[2]} <${m[3]}>`;
      const a = authors.get(key) || { name: m[2], email: m[3], commits: 0, repositories: 0 };
      a.commits += Number(m[1]);
      a.repositories += 1;
      authors.set(key, a);
    }
  }
  return [...authors.values()].sort((a, b) => b.commits - a.commits);
}
