// The files the mount protection depends on are not changed by a file tool (D-A9-SELF-UNLOCK,
// D-A9-GUARD-FILES): a mount widens what a session reads and loads, so an agent that could edit its
// declaration could unlock itself, and the same holds for whatever else the protection leans on.
// - closed to every edit: `.local/mounts.yaml` (the personal mounts), `.local/outgoing.yaml` (the
//   words and the `allow:` entries of the content check) and `.local/sync.json` (what sync wired,
//   which the guards read);
// - editable except for a change to a part, judged on the text the edit would leave: `oikos.yaml`'s
//   `mounts:`, and the `hooks`, `disableAllHooks` and `claudeMdExcludes` keys of
//   `settings.json` and `settings.local.json` of every host's folder (`.claude/`, `.qwen/`) — the
//   wiring of the guards and of the rule exclusions. Sync changes those files as a tool, not through a file tool, and is not held up.
// The way to change mounts is `setup mount add|remove` — a write the user confirms.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { INSTALL_FILE, realForms, realOf, sameFile } from '../common/paths.mjs';
import { LOCAL_MOUNTS_FILE } from '../common/mounts.mjs';
import { HOSTS } from './wiring.mjs';

const ADVICE = 'Change mounts with `node oikos/tools/setup/cli.mjs mount add|remove … --dry-run`, which shows the change and writes it only after the user confirms.';

/** The files of `.local/` that no file tool changes: what each is, the risk of letting an assistant edit it, and who changes it. */
const CLOSED_LOCAL = [
  { file: LOCAL_MOUNTS_FILE, what: 'declares the personal mounts', risk: 'an assistant that could edit it would widen its own reach', advice: ADVICE },
  { file: 'outgoing.yaml', what: 'holds the words and the `allow:` entries of the content check on outgoing text', risk: 'an assistant that could edit it would let flagged text through', advice: 'The user edits it in their own editor.' },
  { file: 'sync.json', what: 'records what sync wired, which the guards read', risk: 'an assistant that could edit it would change what the guards take for wired', advice: 'sync writes it; the user edits it in their own editor.' },
];

/** The settings files whose wiring is protected, relative to the installation: the shared and the local one of every host sync wires. */
const SETTINGS_FILES = Object.values(HOSTS).flatMap(({ dir }) => [`${dir}/settings.json`, `${dir}/settings.local.json`]);

/** The keys of a settings file that wire the guards and the rule exclusions. */
const PROTECTED_KEYS = Object.freeze(['hooks', 'disableAllHooks', 'claudeMdExcludes']);

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

/** The protected keys of the JSON `text` that are present, `{}` when it does not parse (then it wires nothing). */
function protectedPart(text) {
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(PROTECTED_KEYS.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]));
  } catch {
    return {};
  }
}

/** The text of the file `real` now, '' when it is not there. */
const textOf = (real) => (existsSync(real) ? readFileSync(real, 'utf8') : '');

/** Why a file tool may not change the closed file of `.local/` described by `closed`. */
const closedReason = ({ file, what, risk, advice }) => `oikos package guard: .local/${file} ${what} and is not changed by a file tool — ${risk}. ${advice}`;

/** Why the edit `input` to the settings file `real` (shown as `shown`) is refused, or null when it leaves the protected keys as they are. */
function settingsProblem(input, real, shown) {
  const before = textOf(real);
  const after = textAfter(input, before);
  if (after !== null && isDeepStrictEqual(protectedPart(before), protectedPart(after))) return null;
  return `oikos package guard: the ${PROTECTED_KEYS.map((key) => `\`${key}\``).join(', ')} keys of ${shown} wire the guards and the rule exclusions and are not changed by a file tool `
    + `${after === null ? '(this edit cannot be checked for them) ' : ''}— an assistant that could edit them could switch the guards off or load a mount's rules; the other keys stay editable. `
    + 'The user edits them in their own editor; `node oikos/tools/sync/cli.mjs` writes the generated entries.';
}

/**
 * Why a file tool may not make the edit `input` to `path`, or null when it may: the file is one of
 * the closed files of `.local/` (`mounts.yaml`, `outgoing.yaml`, `sync.json`); or it is `oikos.yaml`
 * and the edit alters its `mounts:` part; or it is a settings file of the installation and the edit
 * alters its `hooks`, `disableAllHooks` or `claudeMdExcludes` (or, in these two cases, its effect
 * cannot be told).
 * The path is judged as every real path it may reach ({@link realForms}: a `..` after a link read as
 * the kernel reads it, and as the host collapses it first), and refused when any of them is protected.
 * @param {object} input the tool call's `tool_input`
 * @param {string} path the path the call names
 * @param {string} cwd the session's folder
 * @param {string} install the installation's root
 * @returns {string|null}
 */
export function mountsEditProblem(input, path, cwd, install) {
  for (const real of realForms(path, cwd)) {
    const problem = realEditProblem(input, real, install);
    if (problem) return problem;
  }
  return null;
}

/** {@link mountsEditProblem} for the real path `real`. */
function realEditProblem(input, real, install) {
  const closed = CLOSED_LOCAL.find(({ file }) => sameFile(real, realOf(join('.local', file), install)));
  if (closed) return closedReason(closed);
  const settings = SETTINGS_FILES.find((file) => sameFile(real, realOf(file, install)));
  if (settings) return settingsProblem(input, real, settings);
  if (!sameFile(real, realOf(INSTALL_FILE, install))) return null;
  const before = textOf(real);
  const after = textAfter(input, before);
  if (after !== null && isDeepStrictEqual(mountsPart(before), mountsPart(after))) return null;
  return `oikos package guard: ${INSTALL_FILE}'s \`mounts:\` part declares the shared mounts and is not changed by a file tool `
    + `${after === null ? '(this edit cannot be checked for it) ' : ''}— an assistant that could edit it would widen its own reach; the rest of the file stays editable. ${ADVICE}`;
}
