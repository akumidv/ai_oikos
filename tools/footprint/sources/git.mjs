// The git source: commits in local clones — what a person authored over the period, with the lines
// added and removed by kind of file (code, tests, docs; generated files counted apart and left out).
// The user's settings (places.mjs) leave out the commits that are a tool's snapshots (skip_commits),
// add paths whose lines are a tool's output (generated) and set apart the repositories whose lines are
// a pipeline's output (pipeline_repos). No request: `git` runs on the clones as they are, so what was
// not fetched is not seen.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { UsageError } from '../../common/cli.mjs';
import { missingMessage } from '../../common/files.mjs';
import { addDays } from '../report.mjs';
import { workingDate } from './period.mjs';

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
/** Test code: a tests or spec folder, a `_test`/`.test`/`.spec` file, a `test_` file. */
const TESTS_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|(_test|\.test|\.spec)\.[^/]+$|(^|\/)test_[^/]+$/i;
/** The kinds of lines a commit carries, in the order of the totals and the breakdown. */
const KINDS = ['code', 'tests', 'docs'];

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
 * @returns {'generated'|'tests'|'docs'|'code'} generated: lock files, minified, maps, snapshots,
 *   vendored or built, and `generated`; tests: test folders and files, before docs
 */
export function fileKind(path, generated = []) {
  if (LOCK_FILES.has(basename(path).toLowerCase()) || GENERATED_FILE.test(path) || GENERATED_DIR.test(path)) return 'generated';
  if (generated.some((pattern) => pattern.test(path))) return 'generated';
  if (TESTS_FILE.test(path)) return 'tests';
  return DOCS_FILE.test(path) ? 'docs' : 'code';
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

/** What `git version` prints here, or '' when git does not run (every git log then fails and says why). */
function installedGitVersion() {
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

/** The commits of one repository: [{ hash, at, email, subject, files: [{ path, added, deleted, binary }] }]. */
function commitsOf(repo, authors, limit) {
  // No --until: a commit authored in the period and rebased or amended after it keeps its author
  // date, which decides below in --tz.
  const out = git(repo, [
    'log', ...REFS, '--no-merges', '--no-ext-diff', '--no-textconv', '--basic-regexp', '-i',
    ...limit,
    ...authorPatterns(authors).map((p) => `--author=${p}`),
    '--format=%x1e%H%x09%aI%x09%ae%x09%s', '--numstat',
  ]);
  const commits = [];
  for (const chunk of out.split('\x1e').slice(1)) {
    const [head, ...lines] = chunk.split('\n');
    // The subject is last: a tab in it stays in it.
    const [hash, at, email, ...subject] = head.split('\t');
    const files = [];
    for (const line of lines) {
      const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (!m) continue;
      files.push({ path: numstatPath(m[3]), added: Number(m[1]) || 0, deleted: Number(m[2]) || 0, binary: m[1] === '-' });
    }
    commits.push({ hash, at, email, subject: subject.join('\t'), files });
  }
  return commits;
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

/** The lines of `files` by kind — { code, tests, docs } as [added, deleted] — the generated ones and all of them summed. */
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

/** A skip_commits rule as the notes name it: its pattern, and the repositories it is limited to. */
const skipText = (rule) => (rule.repos.length ? `${rule.pattern.source} in ${rule.repos.join(', ')}` : rule.pattern.source);

/**
 * The git source over `repos`: the commits whose author matches one of `authors` (emails exactly,
 * names as a substring) and whose author date falls in the period in `tz`, each counted once
 * however many clones or refs carry it — by its hash, and by its author, author date and subject,
 * so the copy a rebase or a cherry-pick left on another branch is not counted again. A commit whose
 * subject matches `skipCommits` is left out of everything and counted apart; a commit of a
 * repository `pipelineRepos` names keeps its event, and its lines go to the pipeline lines alone.
 * A repository is named by its remote (`repoLabels`): two clones of one remote are one row. Each
 * event is `{ at, kind: 'commit', what: '<repo>: <subject>', where: '<path> <remote url>', lines?:
 * { code, tests, docs } }` — the remote without credentials, no `lines` on a pipeline repository's
 * commit. `remotes` are the identities (`remoteIdentity`) of the repositories whose history was read,
 * with or without commits of the person — no local path: the report matches a code host's commit
 * against them.
 *
 * @param {string[]} repos repository paths, from `findRepos`
 * @param {{ authors: string[], meEmails?: boolean, since: string, until: string, tz: string, dayStartsMin?: number,
 *   skipCommits?: { pattern: RegExp, repos: string[] }[], generated?: RegExp[], pipelineRepos?: string[] }} query
 *   `dayStartsMin` the working day's start: a commit belongs to the period by its working day;
 *   `meEmails` adds, in each repository, the address the user commits with there (`repoUserEmail`);
 *   `skipCommits`, `generated` and `pipelineRepos` are the user's settings (places.mjs
 *   `footprintSettings`), `pipelineRepos` lowercased substrings of a repository's `repoWhere`
 * @param {{ gitVersion?: () => string }} [options] what `git version` prints (tests give another)
 * @returns {object} a source result (report.mjs)
 * @throws {UsageError} when there is no repository or author, or git log failed in every repository
 */
export function collectGit(repos, {
  authors, meEmails = false, since, until, tz, dayStartsMin = 0, skipCommits = [], generated = [], pipelineRepos = [],
}, { gitVersion = installedGitVersion } = {}) {
  if (!repos.length) throw new UsageError('no repository: pass --repos <a repository or a folder of repositories>');
  if (!authors.length && !meEmails) throw new UsageError('no author: pass --email or --name (or --me)');
  const limit = dateLimit(gitVersion(), since);
  const remotes = new Map(repos.map((r) => [r, remoteOf(r)]));
  const labels = repoLabels(repos, remotes);
  // Rows, files and pipeline lines are kept per label: two clones of one remote are one repository.
  const seen = new Set();
  const perRepo = new Map();
  const files = new Set();
  const total = { commits: 0, lines: zeroLines(), generated: 0, skipped: 0, skippedLines: 0, pipeline: [0, 0] };
  const events = [];
  const notes = [];
  const failures = [];
  // The pipeline repositories with commits: repository → [added, deleted].
  const pipelines = new Map();
  const wheres = new Map();
  // The remote identities of the repositories whose history was read (`remoteIdentity`).
  const read = new Set();
  // The repositories' own addresses that --me adds beyond `authors`: address → the repositories.
  const ownEmails = new Map();
  for (const repo of repos) {
    const own = meEmails ? repoUserEmail(repo) : null;
    const added = own && !authors.some((a) => a.toLowerCase() === own.toLowerCase());
    const repoAuthors = added ? [...authors, own] : authors;
    if (added) ownEmails.set(own, [...(ownEmails.get(own) || []), labels.get(repo)]);
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
      const event = { at: c.at, kind: 'commit', what: `${label}: ${c.subject}`, where };
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
  }
  if (failures.length === repos.length) throw new UsageError(`git log failed in every repository searched; ${failures[0]}`);
  notes.push(...failures);
  const ordered = [...perRepo.entries()].sort((a, b) => b[1].commits - a[1].commits);
  notes.push(
    `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} searched, ${perRepo.size} with commits; authors matched: ${[...authors, ...ownEmails.keys()].join(', ')}`,
    ...(ownEmails.size ? [`with --me, the address the user commits with in a repository (its git user.email) is matched there: ${
      [...ownEmails].map(([email, where]) => `${email} in ${where.join(', ')}`).join('; ')}`] : []),
    'branches, tags and remote-tracking branches are read (not the stash or notes); they hold only what was fetched into the clones: fetch them first',
    ...(authors.some((a) => !a.includes('@')) ? ['a name matches as a substring; its case may be ignored for ASCII letters only, so pass a name with accents as the commits write it'] : []),
    `lines of generated files (lock files, minified, source maps, snapshots, vendored or built folders${generated.length ? ', the settings\' generated paths' : ''}) `
      + 'are left out of the code, tests and docs lines; tests are test folders and test files; binary files count as files only',
    ...(total.skipped ? [`${total.skipped} commit(s) whose subject matches skip_commits (${skipCommits.map(skipText).join(', ')}) left out of everything: ${total.skippedLines} lines in them`] : []),
    ...(pipelines.size ? [`pipeline_repos — commits counted, their lines only in pipeline lines, their files not in files changed: ${
      [...pipelines].map(([label, [a, d]]) => `${label} ${lines(a, d)}`).join(', ')}`] : []),
    'a repository is named by its remote (owner/name), so two clones of one remote are one repository and a commit in both counts once; '
      + 'submodules of a repository found are read as repositories of their own',
  );
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
    ],
    events,
    remotes: [...read].sort(),
    breakdown: {
      title: 'per repository',
      header: ['Repository', 'Commits', 'Code +', 'Code −', 'Tests +', 'Tests −', 'Docs +', 'Docs −', 'First', 'Last'],
      rows: ordered.map(([label, r]) => [label, r.commits, ...KINDS.flatMap((k) => r.lines[k]), r.first, r.last]),
      wheres: ordered.map(([label]) => wheres.get(label)),
    },
    notes,
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
