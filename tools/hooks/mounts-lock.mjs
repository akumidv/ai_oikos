// The files that declare the installation's mounts are not changed by a file tool (D-A9-SELF-UNLOCK):
// a mount widens what a session reads and loads, so an agent that could edit the declaration could
// unlock itself. `.local/mounts.yaml` is closed to every edit; `oikos.yaml` stays editable except for
// a change that alters its `mounts:` part, judged on the text the edit would leave. The way to
// change mounts is `setup mount add|remove` — a write the user confirms.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { INSTALL_FILE, realOf } from '../common/paths.mjs';
import { LOCAL_MOUNTS_FILE } from '../common/mounts.mjs';

const ADVICE = 'Change mounts with `node oikos/tools/setup/cli.mjs mount add|remove … --dry-run`, which shows the change and writes it only after the user confirms.';

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

/**
 * Why a file tool may not make the edit `input` to `path`, or null when it may: the file is
 * `.local/mounts.yaml`, or it is `oikos.yaml` and the edit alters its `mounts:` part (or its effect on
 * it cannot be told).
 * @param {object} input the tool call's `tool_input`
 * @param {string} path the path the call names
 * @param {string} cwd the session's folder
 * @param {string} install the installation's root
 * @returns {string|null}
 */
export function mountsEditProblem(input, path, cwd, install) {
  const real = realOf(resolve(cwd, path));
  if (real === realOf(resolve(install, '.local', LOCAL_MOUNTS_FILE))) {
    return `oikos package guard: .local/${LOCAL_MOUNTS_FILE} declares the personal mounts and is not changed by a file tool — an assistant that could edit it would widen its own reach. ${ADVICE}`;
  }
  if (real !== realOf(resolve(install, INSTALL_FILE))) return null;
  const before = existsSync(real) ? readFileSync(real, 'utf8') : '';
  const after = textAfter(input, before);
  if (after !== null && isDeepStrictEqual(mountsPart(before), mountsPart(after))) return null;
  return `oikos package guard: ${INSTALL_FILE}'s \`mounts:\` part declares the shared mounts and is not changed by a file tool `
    + `${after === null ? '(this edit cannot be checked for it) ' : ''}— an assistant that could edit it would widen its own reach; the rest of the file stays editable. ${ADVICE}`;
}
