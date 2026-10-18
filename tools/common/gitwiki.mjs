// Git over a GitHub wiki repository (`<server>/<owner>/<repo>.wiki.git`), which has no REST API:
// a clone per command in a fresh folder under the OS temp folder, removed when the command is done,
// so nothing is left in `.local/` and nothing goes stale. Git runs through `execFile` (no shell).
// The credential reaches git only through the environment of the git child — an `http.extraHeader`
// scoped to the wiki's host and given as GIT_CONFIG_* — never in argv, the URL or `.git/config`. The machine's git configuration
// (system and global: identity, credential helpers, signing, hooks templates) never applies, and a
// commit carries the identity it is given, never the machine's: on a shared machine those may
// belong to another organization.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './cli.mjs';
import { ChannelError } from './http.mjs';

/**
 * A git command that failed for a reason on the remote's side or in git itself. runCli maps a
 * ChannelError to exit 2 (a remote error), which is what this is; the message carries git's own
 * words.
 */
export class GitError extends ChannelError {
  /**
   * @param {string} message What failed.
   * @param {string} [stderr] Git's stderr, kept for the caller.
   */
  constructor(message, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
  }
}

/** The push was refused because the wiki moved on since the clone: exit 2, no automatic rebase. */
export class WikiChanged extends GitError {
  constructor(stderr = '') {
    super('the wiki changed since; run the dry run again', stderr);
    this.name = 'WikiChanged';
  }
}

/**
 * @typedef {object} WikiContext What the error messages name.
 * @property {string} repo `owner/repo` of the main repository.
 * @property {string} serverUrl The web and git host, e.g. `https://github.com`.
 * @property {string} [route] Where the credential came from (`token (.local/.env)`, `gh auth token`).
 */

/**
 * @typedef {object} Identity A commit's author and committer.
 * @property {string} name
 * @property {string} email
 */

/**
 * @typedef {object} CommitInfo
 * @property {string} sha
 * @property {string} date ISO 8601, the author date.
 * @property {string} author The author's name.
 */

/** The git URL of the wiki of `owner/repo` on `serverUrl`. */
export const wikiCloneUrl = (serverUrl, repo) => `${serverUrl.replace(/\/+$/, '')}/${repo}.wiki.git`;

/** The web URL of the wiki of `owner/repo`; of one page when `stem` (a file name without extension) is given. */
export function wikiWebUrl(serverUrl, repo, stem) {
  const base = `${serverUrl.replace(/\/+$/, '')}/${repo}/wiki`;
  return stem && stem !== 'Home' ? `${base}/${encodeURIComponent(stem)}` : base;
}

/**
 * The GitHub noreply commit identity of a user from `GET /user`: name = login, email =
 * `<id>+<login>@users.noreply.github.com` — attributed to the account, revealing no address.
 *
 * @param {{ login: string, id: number }} user
 * @returns {Identity}
 */
export function noreplyIdentity(user) {
  if (!user?.login || user.id === undefined) throw new UsageError('cannot read the login and id of the token owner from GET /user');
  return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

/** The HTTP header that authenticates git over HTTPS with a GitHub token (basic auth, user `x-access-token`). */
export const authHeader = (token) => `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

/**
 * The environment of a git child: `base` without any GIT_* variable or askpass helper of the caller
 * (they could redirect the repository, the identity or the credential), the machine's system and
 * global configuration switched off, prompts off, messages in English (the failures are read from
 * them), and the credential as an `http.<serverUrl>/.extraHeader` when `token` is given and the
 * server is an http(s) URL — scoped to the wiki's host, so a redirect elsewhere never carries it; a
 * local path (tests) gets no header at all.
 *
 * @param {string|null} token The GitHub token, or null for a remote that needs none.
 * @param {NodeJS.ProcessEnv} base The environment to start from (normally process.env).
 * @param {{ serverUrl?: string, identity?: Identity }} [options] The wiki's host, and when given
 *   `identity` the author and committer of any commit.
 * @returns {Record<string, string>}
 */
export function gitEnvironment(token, base, { serverUrl, identity } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || /^GIT_/.test(k) || k === 'SSH_ASKPASS') continue;
    env[k] = v;
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  });
  if (token && /^https?:\/\//i.test(serverUrl || '')) {
    const key = `http.${serverUrl.replace(/\/+$/, '')}/.extraHeader`;
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: authHeader(token) });
  }
  if (identity) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    });
  }
  return env;
}

/**
 * The error for git's stderr of a failed clone or push of the wiki of `context.repo`: a wiki that
 * does not exist (or that the credential cannot see — GitHub answers alike) and a rejected
 * credential are usage errors with the route a person takes; a non-fast-forward push is
 * {@link WikiChanged}; anything else a {@link GitError} with git's message.
 *
 * @param {string} stderr
 * @param {WikiContext} context
 * @returns {Error}
 */
export function gitFailure(stderr, context) {
  const text = String(stderr || '').trim();
  const { repo, serverUrl, route } = context;
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(text)) return new WikiChanged(text);
  if (/Repository not found|repository '[^']*' (?:not found|does not exist)|does not appear to be a git repository/i.test(text)) {
    return new UsageError(`the wiki of ${repo} does not exist yet — GitHub creates the wiki repository when the first page is made in the web interface: ${wikiWebUrl(serverUrl, repo)}`
      + ` (or the credential${route ? `, ${route},` : ''} cannot reach it: GitHub answers both alike)`);
  }
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or password|Permission to .* denied|\b403\b|\b401\b/i.test(text)) {
    return new UsageError(`GitHub refused the credential for the wiki of ${repo}${route ? ` (route: ${route})` : ''}. A fine-grained token may not reach wiki git;`
      + ' a classic token with the `repo` scope or the `gh auth login` session is expected to (unverified until checked live).');
  }
  const last = text.split('\n').filter(Boolean).slice(-3).join(' | ');
  return new GitError(`git failed on the wiki of ${repo}: ${last || 'no message'}`, text);
}

/**
 * Run git with `args` in `cwd` under `env`: its stdout. A failure is raised — a missing git as a
 * usage error, anything else through `fail(stderr)`.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env: Record<string, string>, fail?: (stderr: string) => Error }} options
 * @returns {Promise<string>}
 */
function git(args, { cwd, env, fail }) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.code === 'ENOENT') return reject(new UsageError('git is not installed or not on PATH; the GitHub wiki is reached over git'));
      const failure = fail ? fail(stderr) : new GitError(`git ${args[0]} failed: ${String(stderr).trim().split('\n').slice(-2).join(' | ')}`, stderr);
      failure.cause = error;
      return reject(failure);
    });
  });
}

/**
 * A working copy of a wiki repository in a temporary folder — valid only inside
 * {@link withWikiClone}, which removes it.
 */
export class WikiClone {
  /**
   * @param {string} dir The working copy.
   * @param {string|null} token
   * @param {WikiContext} context
   */
  constructor(dir, token, context) {
    this.dir = dir;
    this.token = token;
    this.context = context;
  }

  /** Run git in the working copy, optionally committing as `identity`. */
  run(args, identity) {
    return git(args, { cwd: this.dir, env: gitEnvironment(this.token, process.env, { serverUrl: this.context.serverUrl, identity }), fail: (s) => gitFailure(s, this.context) });
  }

  /** The tracked files, repository-relative with `/`. */
  async files() {
    return (await this.run(['ls-files', '-z'])).split('\0').filter(Boolean);
  }

  /** The text of the tracked file `file`. */
  read(file) {
    return readFileSync(join(this.dir, file), 'utf8');
  }

  /** The commit checked out, or null in an empty repository. */
  async head() {
    try {
      return (await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim() || null;
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  }

  /** The branch checked out (the remote's default branch), also on an unborn branch. */
  async branch() {
    return (await this.run(['symbolic-ref', '--short', 'HEAD'])).trim();
  }

  /**
   * The last commit that touched `file`. In a shallow clone that is the boundary commit for every
   * file, so a caller that needs it clones with `history`.
   *
   * @returns {Promise<CommitInfo|null>}
   */
  async lastCommit(file) {
    const out = (await this.run(['log', '-1', '--format=%H%x00%aI%x00%an', '--', file])).trim();
    if (!out) return null;
    const [sha, date, author] = out.split('\0');
    return { sha, date, author };
  }

  /**
   * Write `text` to `file` and commit it as `identity` with `message`: the new commit's sha. Hooks
   * of the working copy are skipped — it is a fresh clone and holds none of the organization's.
   *
   * @param {string} text
   * @param {string} file
   * @param {{ identity: Identity, message: string }} options
   * @returns {Promise<string>}
   */
  async commit(text, file, { identity, message }) {
    writeFileSync(join(this.dir, file), text);
    await this.run(['add', '--', file]);
    await this.run(['commit', '--quiet', '--no-verify', '-m', message], identity);
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  /** Push the checked-out branch to its remote branch, never forced; a moved remote is {@link WikiChanged}. */
  async push() {
    const branch = await this.branch();
    await this.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  }
}

/**
 * Clone the wiki at `url` into a fresh folder under the OS temp folder, run `work` on the clone,
 * and remove the folder whatever happens — the folder exists only for the duration of `work`.
 * Shallow (depth 1) by default; `history` clones the commits without file contents a page's
 * history needs (`--filter=blob:none`; a local path ignores the filter and clones in full).
 *
 * @template T
 * @param {string} url The wiki's git URL ({@link wikiCloneUrl}).
 * @param {{ token: string|null, context: WikiContext, history?: boolean }} options
 * @param {(clone: WikiClone) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withWikiClone(url, { token, context, history = false }, work) {
  const root = mkdtempSync(join(tmpdir(), 'oikos-wiki-'));
  try {
    const dir = join(root, 'wiki');
    const depth = history ? ['--filter=blob:none'] : ['--depth', '1'];
    await git(['clone', '--quiet', '--no-tags', ...depth, '--', url, dir],
      { cwd: root, env: gitEnvironment(token, process.env, { serverUrl: context.serverUrl }), fail: (s) => gitFailure(s, context) });
    return await work(new WikiClone(dir, token, context));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
