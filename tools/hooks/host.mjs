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
import { basename, isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { CORE_ROOT, installRoot } from '../common/paths.mjs';

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

/** The `.env` files, the Google sign-in's folder, and a search scoped to `.local/` itself. */
export const isEnvFile = (path) => {
  const name = basename(String(path).replace(/^[<>]+/, ''));
  return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name);
};
export const isGoogleSecret = (path) => /(^|\/)\.local\/google(\/|$)/.test(String(path).replace(/^[<>]+/, ''));
export const isLocalFolder = (path) => /(^|\/)\.local\/?(\*.*)?$/.test(String(path).replace(/^[<>]+/, ''));

/** The file globs a call carries: `glob` of a content search, `pattern` of a file-name search. */
export function globPatterns(payload) {
  const input = payload.tool_input || {};
  const found = [];
  if (typeof input.glob === 'string') found.push(input.glob);
  if (has(GLOB_TOOLS, payload) && typeof input.pattern === 'string') found.push(input.pattern);
  return found;
}

/**
 * A glob that names `.local/` or a `.env*` file, wherever it sits in the pattern and written with
 * either separator. A `.env` with the same suffixes {@link isEnvFile} lets through — a template
 * holds no secret — is not named.
 */
export const globNamesSecret = (glob) => /(^|[\/{,\\])\.local($|[\/*,}\\])|(^|[\/{,*\\])\.env(?![A-Za-z])(?!\.(?:example|sample|template)\b)/.test(String(glob));

const isFolder = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Folders below `.local/` that hold the installation's descriptions, not its secrets: the
 * organization's resource notes, which the skills send the agent to read.
 */
const OPEN_LOCAL_FOLDERS = new Set(['resources']);

/**
 * A search scope or shell argument that goes through a folder below `.local/` (the Chrome profile,
 * the Google sign-in). The first name under `.local/` decides: a file there (the catalog, the
 * backlog) is judged by its own name, a folder is a store and nothing under it is opened.
 *
 * A relative name belongs to the session's folder, and that is not always this project — a tool
 * call may carry another `directory`. The installation's root is asked too (the core's outside
 * one), so a relative `.local/<folder>` is closed whether or not the caller stands there.
 */
export function isInsideLocal(path, cwd) {
  const clean = String(path).replace(/^[<>]+/, '');
  const under = /(?:^|\/)\.local\/([^/]+)/.exec(clean);
  if (!under) return false; // `.local` itself is judged by isLocalFolder
  if (OPEN_LOCAL_FOLDERS.has(under[1])) return false;
  const head = clean.slice(0, under.index + under[0].length);
  if (isAbsolute(head)) return isFolder(head);
  return isFolder(resolve(cwd || process.cwd(), head)) || isFolder(resolve(installRoot() || CORE_ROOT, head));
}
