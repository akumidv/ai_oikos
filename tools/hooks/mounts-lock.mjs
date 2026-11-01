// The files the mount protection depends on are not changed by a file tool (D-A9-SELF-UNLOCK,
// D-A9-GUARD-FILES), and neither are the files through which an assistant could run a command outside
// every guard: a mount widens what a session reads and loads, so an agent that could edit its
// declaration could unlock itself, and the same holds for whatever else the protection leans on.
// - closed to every edit: `.local/mounts.yaml` (the personal mounts), `.local/outgoing.yaml` (the
//   words and the `allow:` entries of the content check), `.local/sync.json` (what sync wired,
//   which the guards read) and `.mcp.json` at the installation's root (a project MCP server is a
//   command the host runs outside the guards; sync writes it as a tool);
// - editable except for a change to a part, judged on the text the edit would leave: `oikos.yaml`'s
//   `mounts:`;
// - the host settings files, an allow-list (D-AUDIT5-EXEC-KEYS): `settings.json` and
//   `settings.local.json` of every host's folder (`.claude/`, `.qwen/`) in the installation, and the
//   user-level ones (D-AUDIT3-USER-SETTINGS) in `~/.claude/` (or in `CLAUDE_CONFIG_DIR`, when set) and
//   `~/.qwen/`, wherever the edited path is. A file tool may change only their `permissions` key: the
//   parsed object minus `permissions` must be the same before and after, so a key added, removed or
//   changed is refused. Settings keys run commands outside every guard (`hooks`, `statusLine`,
//   `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`, MCP servers), pass an
//   environment to the guards' processes (`env`: `OIKOS_HOME`, `NODE_OPTIONS`) or switch them off
//   (`disableAllHooks`, `claudeMdExcludes`), and the host adds such keys over time, so a list of the
//   closed ones would lag. A text that is not strict JSON (a BOM, a comment, a trailing comma) or not
//   an object cannot be compared and is refused; so is any edit of a file that does not parse now (the
//   user fixes it in their editor). An absent file is `{}`. Sync changes these files as a tool, not
//   through a file tool, and is not held up;
// - closed to every edit, at the user's level (D-AUDIT4-STARTUP-FILES, D-AUDIT5-EXEC-KEYS): the
//   shell startup files in the home folder and, when `ZDOTDIR` is set, its zsh files — an
//   `export NODE_OPTIONS=…` there reaches the hooks' processes from the next session and switches every
//   guard off (node has no flag to ignore `NODE_OPTIONS`) — and `~/.claude.json` (the one in
//   `CLAUDE_CONFIG_DIR` too), host state the host rewrites as a process and whose `mcpServers` run
//   commands. The home and the environment are read once, by the guard's entry point
//   ({@link userGuards}), and passed down. A shell's write to them is not covered (task L5).
// - closed to a `hooks` key in the front matter (D-AUDIT6-FRONTMATTER-HOOKS): the markdown files under
//   `skills/`, `agents/` and `commands/` of every host's folder, in the installation and at the user's
//   level — the host runs those hooks outside every guard. The front matter is parsed as YAML (merge
//   keys on, a duplicate key an error): a mapping with a `hooks` key, an unparsable block and a
//   non-mapping one are refused. The rest of such a file stays editable.
// - closed to every edit, at the user's level (D-AUDIT6B-PLUGINS): the plugins folder of the user's host
//   folders (`~/.claude/plugins`, the one in `CLAUDE_CONFIG_DIR`, `~/.qwen/extensions`) — plugin files
//   carry hooks and servers that run outside every guard.
// The way to change mounts is `setup mount add|remove` — a write the user confirms.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { INSTALL_FILE, idOf, isWithin, realForms, realOf, sameFile } from '../common/paths.mjs';
import { LOCAL_MOUNTS_FILE } from '../common/mounts.mjs';
import { HOSTS } from './wiring.mjs';

const ADVICE = 'Change mounts with `node oikos/tools/setup/cli.mjs mount add|remove … --dry-run`, which shows the change and writes it only after the user confirms.';

/**
 * A file (or a folder, when `folder`) that no file tool changes: `path` (absolute, or relative to the
 * installation), `shown` (how a message names it), what it is, the risk of letting an assistant edit it, and who changes it.
 * @typedef {{path: string, shown: string, what: string, risk: string, advice: string, folder?: boolean}} ClosedFile
 */

/** The files of the installation that no file tool changes. */
const CLOSED_FILES = [
  { path: join('.local', LOCAL_MOUNTS_FILE), shown: `.local/${LOCAL_MOUNTS_FILE}`, what: 'declares the personal mounts', risk: 'an assistant that could edit it would widen its own reach', advice: ADVICE },
  { path: '.local/outgoing.yaml', shown: '.local/outgoing.yaml', what: 'holds the words and the `allow:` entries of the content check on outgoing text', risk: 'an assistant that could edit it would let flagged text through', advice: 'The user edits it in their own editor.' },
  { path: '.local/sync.json', shown: '.local/sync.json', what: 'records what sync wired, which the guards read', risk: 'an assistant that could edit it would change what the guards take for wired', advice: 'sync writes it; the user edits it in their own editor.' },
  { path: '.mcp.json', shown: '.mcp.json', what: 'declares the project\'s MCP servers, each a command the host runs outside every guard', risk: 'an assistant that could edit it could add a server that runs anything', advice: 'sync writes it; the user edits it in their own editor.' },
];

/** The settings files whose keys are protected, relative to the installation: the shared and the local one of every host sync wires. */
const SETTINGS_FILES = Object.values(HOSTS).flatMap(({ dir }) => [`${dir}/settings.json`, `${dir}/settings.local.json`]);

/** The one key of a settings file a file tool may change. */
const EDITABLE_KEY = 'permissions';

/** The shell startup files in the user's home, as the shells read them. */
const STARTUP_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.config/fish/config.fish', '.pam_environment', '.xprofile', '.xsessionrc', '.bash_aliases'];

/** The folders of startup files in the user's home: every file in them is read at login or at the start of a shell. */
const STARTUP_FOLDERS = ['.config/fish/conf.d', '.config/environment.d', '.bashrc.d', '.config/fish/functions', '.config/systemd/user'];

/** The host folders of an installation (`.claude`, `.qwen`). */
const HOST_DIRS = Object.values(HOSTS).map(({ dir }) => dir);

/** The folders of a host's folder whose markdown files the host loads as skills, agents and commands, and may run `hooks` from their front matter. */
const FRONT_MATTER_FOLDERS = ['skills', 'agents', 'commands'];

/** The zsh files that `ZDOTDIR` moves out of the home folder. */
const ZSH_FILES = ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout'];

const STARTUP_RISK = 'an `export NODE_OPTIONS=…` there reaches the hooks\' processes from the next session and switches every guard off (node has no flag to ignore it)';
const STARTUP_ADVICE = 'The user edits it in their own editor.';

/**
 * The user-level settings files of every host, as `{ path, shown }` (`shown` names a file in a message):
 * `settings.json` and `settings.local.json` of the host's folder under `home`, and of the folder its
 * environment variable names (Claude Code's `CLAUDE_CONFIG_DIR`) when `env` sets one.
 * @param {string} home the user's home folder
 * @param {Record<string, string|undefined>} env the environment
 * @returns {{path: string, shown: string}[]}
 */
export function userSettingsFiles(home, env) {
  const files = [];
  for (const { userDir, userDirVar } of Object.values(HOSTS)) {
    const folders = [{ folder: join(home, userDir), shown: `~/${userDir}` }];
    if (userDirVar && env[userDirVar]) folders.push({ folder: resolve(env[userDirVar]), shown: resolve(env[userDirVar]) });
    for (const { folder, shown } of folders) {
      for (const name of ['settings.json', 'settings.local.json']) files.push({ path: join(folder, name), shown: `${shown}/${name}` });
    }
  }
  return files;
}

/** The closed files of the user's level: the shell startup files of the home and of `ZDOTDIR`, and the host state `.claude.json`. */
function userClosedFiles(home, env) {
  const startup = (path, shown, folder = false) => ({
    path, shown: folder ? `${shown}/` : shown, folder, risk: STARTUP_RISK, advice: STARTUP_ADVICE,
    what: folder ? 'is a folder of shell startup files of the user' : 'is a shell startup file of the user',
  });
  const closed = [
    ...STARTUP_FILES.map((name) => startup(join(home, name), `~/${name}`)),
    ...STARTUP_FOLDERS.map((name) => startup(join(home, name), `~/${name}`, true)),
  ];
  if (env.ZDOTDIR) {
    const zdotdir = resolve(env.ZDOTDIR.startsWith('~/') ? join(home, env.ZDOTDIR.slice(2)) : env.ZDOTDIR);
    closed.push(...ZSH_FILES.map((name) => startup(join(zdotdir, name), join(zdotdir, name))));
  }
  const hostState = (path, shown) => ({
    path, shown, what: 'is the host\'s own state, which the host rewrites as a process, and its `mcpServers` run commands outside every guard',
    risk: 'an assistant that could edit it could add an MCP server that runs anything', advice: 'The user edits it in their own editor.',
  });
  closed.push(hostState(join(home, '.claude.json'), '~/.claude.json'));
  const plugins = (path, shown) => ({
    path, shown: `${shown}/`, folder: true, what: 'holds the host\'s plugins, whose files carry hooks and servers that run outside every guard',
    risk: 'an assistant that could write there could plant a hook or a server that runs anything', advice: 'The user installs plugins through the host.',
  });
  closed.push(plugins(join(home, '.claude', 'plugins'), '~/.claude/plugins'), plugins(join(home, '.qwen', 'extensions'), '~/.qwen/extensions'));
  if (env.CLAUDE_CONFIG_DIR) closed.push(plugins(join(resolve(env.CLAUDE_CONFIG_DIR), 'plugins'), join(resolve(env.CLAUDE_CONFIG_DIR), 'plugins')));
  if (env.CLAUDE_CONFIG_DIR) closed.push(hostState(join(resolve(env.CLAUDE_CONFIG_DIR), '.claude.json'), join(resolve(env.CLAUDE_CONFIG_DIR), '.claude.json')));
  return closed;
}

/**
 * What the guard takes from the user's home and environment: the user-level settings files of the hosts
 * ({@link userSettingsFiles}) and the user-level files closed to every edit (shell startup files,
 * `.claude.json`). Read once by the package guard's entry point and passed down.
 * @param {string} home the user's home folder
 * @param {Record<string, string|undefined>} env the environment
 * @returns {{settings: {path: string, shown: string}[], closed: ClosedFile[], hostFolders: string[]}}
 */
export function userGuards(home, env) {
  const settings = userSettingsFiles(home, env);
  const hostFolders = [...new Set(settings.map(({ path }) => dirname(path)))];
  return { settings, closed: userClosedFiles(home, env), hostFolders };
}

const NO_USER = Object.freeze({ settings: [], closed: [], hostFolders: [] });

const isText = (value) => typeof value === 'string';

/** One replacement of an Edit or of an entry of a MultiEdit applied to `text`; `text` itself when the edit cannot apply (the tool fails then). */
function replaced(text, edit) {
  if (!isText(edit?.old_string) || !isText(edit.new_string) || edit.old_string === '') return text;
  const count = text.split(edit.old_string).length - 1;
  if (count === 0 || (count > 1 && !edit.replace_all)) return text;
  return edit.replace_all ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, () => edit.new_string);
}

/**
 * The text of a file after the edit `input` (a tool call's `tool_input`) asks for: a Write's `content`,
 * an Edit's replacement, a MultiEdit's replacements in order. Null when the call has none of these
 * shapes, so the result cannot be told.
 * @param {object} input
 * @param {string} before the file's text now
 * @returns {string|null}
 */
export function textAfter(input, before) {
  if (isText(input.content)) return input.content;
  if (Array.isArray(input.edits)) return input.edits.reduce(replaced, before);
  if (isText(input.old_string)) return replaced(before, input);
  return null;
}

/** The `mounts:` part of the YAML `text`, `{}` when it is absent, empty or the text does not parse (then the configuration has no shared mounts). */
function mountsPart(text) {
  try {
    const part = YAML.parse(text)?.mounts;
    return part ?? {};
  } catch {
    return {};
  }
}

/** The object the strict JSON `text` holds, or null when it is not strict JSON (a BOM, a comment, a trailing comma) or not an object. */
function strictObject(text) {
  try {
    const data = JSON.parse(text);
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** The object `data` without its editable key: what a file tool may not change in a settings file. */
function closedPart(data) {
  const { [EDITABLE_KEY]: _editable, ...rest } = data;
  return rest;
}

/**
 * Whether the `text` of a skill, agent or command file carries a `hooks` key in its front matter, or has
 * a front matter that cannot be told not to: the block is parsed as YAML (merge keys on, a duplicate key
 * an error), so an escaped, quoted, flow, explicit-key, tagged, merged or indented spelling is read as
 * the key it is. Denied: a mapping with an own `hooks` key, a block that does not parse cleanly, one that
 * is not a mapping; an empty block is fine. An unterminated block counts to its end.
 */
function frontMatterHasHooks(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return false;
  const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  const block = lines.slice(1, end === -1 ? lines.length : end).join('\n');
  try {
    const doc = YAML.parseDocument(block, { merge: true, uniqueKeys: true });
    if (doc.errors.length > 0 || doc.warnings.length > 0) return true;
    const data = doc.toJS();
    if (data === null || data === undefined) return false;
    if (typeof data !== 'object' || Array.isArray(data)) return true;
    return Object.hasOwn(data, 'hooks');
  } catch {
    return true;
  }
}

/** The text of the file `real` now, '' when it is not there. */
const textOf = (real) => (existsSync(real) ? readFileSync(real, 'utf8') : '');

/** Why a file tool may not change the closed file `closed`. */
const closedReason = ({ shown, what, risk, advice }) => `oikos package guard: ${shown} ${what} and is not changed by a file tool — ${risk}. ${advice}`;

/** The message for an edit of the settings file shown as `shown` that is refused, `cause` saying why (a user-level file when `user`). */
function settingsReason(shown, cause, user) {
  return `oikos package guard: a file tool changes only the \`${EDITABLE_KEY}\` key of ${shown} — ${cause}. Every other key may run a command outside every guard `
    + '(`hooks`, `statusLine`, `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`, MCP servers), hand an environment to the guards\' processes (`env`) or switch them off '
    + '(`disableAllHooks`, `claudeMdExcludes`), and the host adds such keys over time, so none is open. '
    + (user ? 'The user edits it in their own editor — this file is read by every installation on the machine.'
      : 'The user edits it in their own editor; `node oikos/tools/sync/cli.mjs` writes the generated entries.');
}

/** Why the edit `input` to the settings file `real` (shown as `shown`; a user-level one when `user`) is refused, or null when it leaves everything but `permissions` as it is. */
function settingsProblem(input, real, shown, user = false) {
  const before = existsSync(real) ? readFileSync(real, 'utf8') : '{}';
  const current = strictObject(before);
  if (current === null) return settingsReason(shown, 'the file as it is now is not a strict JSON object, so no edit of it can be checked', user);
  const after = textAfter(input, before);
  const next = after === null ? null : strictObject(after);
  if (next === null) return settingsReason(shown, 'the text this edit would leave cannot be checked: it is not a strict JSON object (a BOM, a comment, a trailing comma and the like are refused) or the call names no text', user);
  if (isDeepStrictEqual(closedPart(current), closedPart(next))) return null;
  return settingsReason(shown, 'this edit changes a key other than that one', user);
}

/** Whether the real path `path` is the folder `folder` (real) or inside it: by the string, or by the identity of `path` or any ancestor of it. */
function inFolder(path, folder) {
  if (isWithin(path, folder)) return true;
  const id = idOf(folder);
  if (id === null) return false;
  for (let dir = path; ; dir = dirname(dir)) {
    if (idOf(dir) === id) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Why a file tool may not make the edit `input` to `path`, or null when it may: the file is one of
 * the closed files (`.local/mounts.yaml`, `.local/outgoing.yaml`, `.local/sync.json`, `.mcp.json` of the
 * installation; and, from `user`, the shell startup files and `.claude.json`); or it is `oikos.yaml`
 * and the edit alters its `mounts:` part; or it is a settings file of the installation or a user-level
 * one (`user.settings`, wherever it is) and the edit alters any key but `permissions` (or its effect
 * cannot be told, or the file does not parse).
 * The path is judged as every real path it may reach ({@link realForms}: a `..` after a link read as
 * the kernel reads it, and as the host collapses it first), and refused when any of them is protected;
 * a file in a closed folder is judged by the real path of its folder too, so a link as the file itself leads nowhere.
 * @param {object} input the tool call's `tool_input`
 * @param {string} path the path the call names
 * @param {string} cwd the session's folder
 * @param {string} install the installation's root
 * @param {{settings: {path: string, shown: string}[], closed: ClosedFile[], hostFolders: string[]}} [user] what {@link userGuards} read from the home and the environment, passed by the caller's entry point
 * @returns {string|null}
 */
export function mountsEditProblem(input, path, cwd, install, user = NO_USER) {
  // the paths a folder test looks at besides the real file: the real forms of its folder, and the path as named (links not followed)
  const parents = [...realForms(dirname(resolve(cwd, path)), cwd), resolve(cwd, path)];
  for (const real of realForms(path, cwd)) {
    const problem = realEditProblem(input, real, parents, install, user);
    if (problem) return problem;
  }
  return null;
}

/** The closed entry of `CLOSED_FILES` or of `user` that holds the real path `real`, whose folder is one of `parents` (the real forms of its folder), or undefined. */
function closedEntry(real, parents, install, user) {
  return [...CLOSED_FILES, ...user.closed].find(({ path, folder }) => {
    const entry = realOf(path, install);
    return folder ? [real, ...parents].some((reached) => inFolder(reached, entry) || isWithin(reached, resolve(install, path))) : sameFile(real, entry);
  });
}

/** Why the edit `input` to the markdown file `real` (its folder has the real forms `parents`) is refused: it is a skill, agent or command file of a host and would leave a `hooks` key in its front matter; else null. */
function frontMatterProblem(input, real, parents, install, user) {
  if (!/\.md$/i.test(real)) return null;
  const hosts = [...HOST_DIRS.map((dir) => join(install, dir)), ...user.hostFolders];
  const logical = hosts.flatMap((host) => FRONT_MATTER_FOLDERS.map((name) => join(host, name)));
  const inside = (reached) => logical.some((folder) => inFolder(reached, realOf(folder, install)) || isWithin(reached, folder));
  if (![real, ...parents].some(inside)) return null;
  const after = textAfter(input, textOf(real));
  if (after === null || !frontMatterHasHooks(after)) return null;
  return `oikos package guard: a file tool does not write a \`hooks\` key into the front matter of a skill, agent or command file (${real}) — the host runs it outside every guard when it loads the file. `
    + 'The user edits it in their own editor.';
}

/** {@link mountsEditProblem} for the real path `real`, whose folder has the real forms `parents` (and the path as named). */
function realEditProblem(input, real, parents, install, user) {
  const closed = closedEntry(real, parents, install, user);
  if (closed) return closedReason(closed);
  const settings = SETTINGS_FILES.find((file) => sameFile(real, realOf(file, install)));
  if (settings) return settingsProblem(input, real, settings);
  const userSettings = user.settings.find(({ path }) => sameFile(real, realOf(path)));
  if (userSettings) return settingsProblem(input, real, userSettings.shown, true);
  const hooks = frontMatterProblem(input, real, parents, install, user);
  if (hooks) return hooks;
  if (!sameFile(real, realOf(INSTALL_FILE, install))) return null;
  const before = textOf(real);
  const after = textAfter(input, before);
  if (after !== null && isDeepStrictEqual(mountsPart(before), mountsPart(after))) return null;
  return `oikos package guard: ${INSTALL_FILE}'s \`mounts:\` part declares the shared mounts and is not changed by a file tool `
    + `${after === null ? '(this edit cannot be checked for it) ' : ''}— an assistant that could edit it would widen its own reach; the rest of the file stays editable. ${ADVICE}`;
}
