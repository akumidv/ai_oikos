// The tool vocabularies of the agent hosts oikos runs under, in one place.
//
// A guard never compares `payload.tool_name` with a name of one host: it asks what *kind* of
// action the call is (a shell command, a file write, a file read), and only this
// module knows the spellings. The hook envelope itself is identical between the hosts — the
// stdin fields (`hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`,
// `permission_mode`, `transcript_path`) and the stdout contract
// (`hookSpecificOutput.permissionDecision` / `additionalContext`, top-level `systemMessage`) —
// so nothing else in tools/hooks/ is host-specific.
//
// The names below are read from the shipped bundles, not guessed. They matter twice: here, and
// in the `matcher` of each host's settings (tools/hooks/wiring.mjs), where a matcher written in
// the other host's names matches nothing and the guard is silently inert.
import { basename, normalize, resolve } from 'node:path';
import { LOCAL_STORES } from '../common/paths.mjs';

/** Anything that runs a shell command. */
export const SHELL_TOOLS = new Set(['Bash', 'run_shell_command']);
/** Anything that mutates a file. (`save_memory` is not here: it names no path, only a fact.) */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write_file', 'notebook_edit']);
/** Tools whose `pattern` is a file glob; for the others (`grep_search`, `Grep`) it is a regex over contents. */
export const GLOB_TOOLS = new Set(['Glob', 'glob']);
/** Anything that reads a path or searches within one. */
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'read_file', 'grep_search', 'glob', 'list_directory']);
export function toolName(payload) {
  return typeof payload.tool_name === 'string' ? payload.tool_name : '';
}

const has = (set, payload) => set.has(toolName(payload));

export const isShell = (payload) => has(SHELL_TOOLS, payload);
export const isEdit = (payload) => has(EDIT_TOOLS, payload);
export const isRead = (payload) => has(READ_TOOLS, payload);
/** A call that names a file: reads, writes, and the search tools that take a scope directory. */
export const isFileTool = (payload) => isEdit(payload) || isRead(payload);

/** The shell command of a shell call, or null when this is not one. */
export function shellCommand(payload) {
  if (!isShell(payload)) return null;
  const command = payload.tool_input?.command;
  return typeof command === 'string' ? command : null;
}

/**
 * The paths a call touches, de-duplicated and in the order the host named them.
 *
 * Three keys, because the spelling of the target differs per tool family: `file_path` for the
 * single-file tools, `notebook_path` for the notebook editor, `path` as the *scope* of a search
 * or listing. Claude's `MultiEdit` names them per edit instead of once for the call.
 */
export function fileTargets(payload) {
  const input = payload.tool_input || {};
  const found = [];
  const add = (value) => {
    if (typeof value === 'string' && value && !found.includes(value)) found.push(value);
  };
  add(input.file_path);
  add(input.notebook_path);
  add(input.path);
  if (Array.isArray(input.edits)) for (const edit of input.edits) add(edit?.file_path);
  return found;
}

/**
 * Names under `.local/` that stay closed though they do not start with a dot: the browser profile
 * and the Google sign-in at their places before ADR 0002, until sync moves them (D03) — the first
 * name of each store's `legacy` place in LOCAL_STORES, lowercased.
 */
const LEGACY_STORES = new Set(Object.values(LOCAL_STORES).map((store) => store.legacy[0].toLowerCase()));

/**
 * Whether `name`, the first name under `.local/`, is a closed store: a dot name or a legacy one,
 * the legacy names in any case (a file system may not tell `Browser` from `browser`). `.` and `..`
 * are not names: the path is judged once they are resolved ({@link spellings}).
 */
export const isStoreName = (name) => (name.startsWith('.') && name !== '.' && name !== '..') || LEGACY_STORES.has(name.toLowerCase());

/** A path as a tool names it, without the shell's redirection marks (`>file`, `<file`). */
const bare = (path) => String(path).replace(/^[<>]+/, '');

/**
 * `path` as written, with `.` and `..` resolved in place (`.local/./x` is `.local/x`), and resolved
 * from the session's folder (relative to it, `..` gone): what one spelling hides another shows.
 */
const spellings = (path, cwd) => {
  const clean = bare(path);
  return [clean, normalize(clean), resolve(cwd || process.cwd(), clean)];
};

/** The `.env` files: `.env`, `.env.*` at any depth, except a template (`.example|.sample|.template`). */
export const isEnvFile = (path) => {
  const name = basename(bare(path));
  return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name);
};

/**
 * A scope that covers `.local/` as a whole — `.local`, `.local/`, `.local/*`, `.local/**` — and so
 * reaches its closed stores. A relative path is judged from the session's folder too, so `..` from
 * `.local/cv` is `.local` itself.
 */
export const isLocalFolder = (path, cwd) => spellings(path, cwd).some((p) => /(^|[/\\])\.local[/\\]?(\*.*)?$/.test(p));

/**
 * A path through a closed store of `.local/` (ADR 0002 D01): the first name under it starts with
 * `.` (`.env`, `.secrets/`, `.browser/`) or is a legacy store (`browser/`, `google/`). Any other name
 * — a file or a folder of working material (`TASKS.md`, `cv/`) — is open. By name only, whether or
 * not the entry exists. A relative name belongs to the session's folder, which is not always this
 * project, so it is judged both as written and resolved from `cwd`.
 */
export function isLocalStore(path, cwd) {
  return spellings(path, cwd).some((p) => [...p.matchAll(/(?:^|[/\\])\.local[/\\]+([^/\\]+)/g)].some((m) => isStoreName(m[1])));
}

/** The file globs a call carries: `glob` of a content search, `pattern` of a file-name search. */
export function globPatterns(payload) {
  const input = payload.tool_input || {};
  const found = [];
  if (typeof input.glob === 'string') found.push(input.glob);
  if (has(GLOB_TOOLS, payload) && typeof input.pattern === 'string') found.push(input.pattern);
  return found;
}

/** A glob that names a `.env*` file other than a template, wherever it sits and with either separator. */
const ENV_GLOB = /(^|[/{,*\\])\.env(?![A-Za-z])(?!\.(?:example|sample|template)\b)/;

/**
 * A glob that reaches a secret, wherever it sits in the pattern and written with either separator:
 * a `.env*` file (a template, which {@link isEnvFile} lets through, is not named); `.local` as a whole
 * (`.local`, `.local/`, `.local*`, `{.local,src}`); or a first name under `.local/` that is a closed
 * store (`.local/.secrets/**`, `.local/browser/*`) or a wildcard that could match one
 * (`.local/*`, `.local/.b*`, `.local/{cv,x}`). `.local/cv/**` names working material and passes.
 */
export function globNamesSecret(glob) {
  const text = String(glob);
  if (ENV_GLOB.test(text)) return true;
  for (const m of text.matchAll(/(?:^|[/{,\\])\.local(?![^/\\*,}])/g)) {
    const first = /^[/\\]+([^/\\,}]*)/.exec(text.slice(m.index + m[0].length));
    // `.local/./**` or `.local/../x` in a glob is not resolved here: closed, as `.local` itself.
    if (!first || !first[1] || /^\.\.?$|[*?[\]{]/.test(first[1]) || isStoreName(first[1])) return true;
  }
  return false;
}
