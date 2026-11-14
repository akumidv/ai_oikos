// The Codex transcript adapter (docs/design/footprint.md § Host formats): rollout files
// `<sessions>/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`, each line
// `{ type, timestamp, payload }`. The owner's typed message is the `event_msg` `item_completed` of a
// `UserMessage` (its `response_item` twin is not read), the final summary the assistant message of
// phase `final_answer`; a rollout of a sub-agent or a review thread is skipped whole.
import { basename, dirname, join } from 'node:path';
import { CHOICE_DIALOG, DELEGATION, entriesOf, jsonLines, lastText } from './lines.mjs';

/** The host's name in events and notes. */
export const host = 'codex';

const TOOLS = new Map([['spawn_agent', DELEGATION], ['request_user_input_async', CHOICE_DIALOG]]);

/**
 * The folders read when the settings name none: `$CODEX_HOME/sessions` and `archived_sessions`, else
 * the same under `~/.codex`.
 *
 * @param {{ env: NodeJS.ProcessEnv, home: string }} where the environment and home to read
 * @returns {string[]}
 */
export function defaultFolders({ env, home }) {
  const root = env.CODEX_HOME || join(home, '.codex');
  return [join(root, 'sessions'), join(root, 'archived_sessions')];
}

/**
 * The folders read for the sessions folder the settings name: it and `archived_sessions` beside it.
 *
 * @param {string} folder the settings' path
 * @returns {string[]}
 */
export const givenFolders = (folder) => [folder, join(dirname(folder), 'archived_sessions')];

/**
 * The rollouts under a sessions folder, at any depth: `rollout-*.jsonl`.
 *
 * @param {string} folder a sessions or archived_sessions folder
 * @param {(error: Error) => void} [onError] told of a folder that could not be read
 * @returns {string[]}
 */
export function listTranscripts(folder, onError = () => {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of entriesOf(dir, onError)) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(join(dir, entry.name));
    }
  };
  walk(folder);
  return files.sort();
}

/** The texts of a message's content items. */
const textsOf = (content) => (Array.isArray(content) ? content : []).filter((c) => typeof c?.text === 'string').map((c) => c.text);

/** The record of one line, or undefined when the line carries none; `state` holds the session and working folders met so far. */
function convert(r, line, state) {
  const p = r.payload ?? {};
  const record = (extra) => ({ at: r.timestamp, session: state.session, recordId: `L${line}`, cwd: state.turnCwd ?? state.cwd, tools: [], ...extra });
  if (r.type === 'turn_context') {
    state.turnCwd = p.cwd ?? state.turnCwd;
    return undefined;
  }
  if (r.type === 'event_msg') {
    return p.type === 'item_completed' && p.item?.type === 'UserMessage' ? record({ role: 'owner', text: textsOf(p.item.content).join('\n') }) : undefined;
  }
  return r.type === 'response_item' ? responseRecord(p, record) : undefined;
}

/** The assistant's message or tool call of a `response_item`; the twin of the owner's message is not read. */
function responseRecord(p, record) {
  if (p.type === 'function_call') return record({ role: 'assistant', finalCandidate: false, tools: [TOOLS.get(p.name)].filter(Boolean) });
  if (p.type !== 'message' || p.role !== 'assistant') return undefined;
  const text = lastText(textsOf(p.content));
  return record({ role: 'assistant', text, finalCandidate: p.phase === 'final_answer' && text !== undefined });
}

/**
 * The records of a rollout in the shared form: owner messages, assistant messages and tool calls.
 * A rollout whose `session_meta` names a `thread_source` other than `user` yields nothing and is
 * counted in `stats.skipped`; one that names none is read.
 *
 * @param {string} file the rollout's path
 * @param {{ unreadable: number, skipped: number }} stats counters of the host being read
 * @returns {AsyncGenerator<object>}
 */
export async function* readTranscript(file, stats) {
  const state = { session: basename(file, '.jsonl'), cwd: null, turnCwd: null };
  for await (const { value: r, line } of jsonLines(file, stats)) {
    if (r.type === 'session_meta') {
      const meta = r.payload ?? {};
      if (meta.thread_source !== undefined && meta.thread_source !== 'user') {
        stats.skipped += 1;
        return;
      }
      state.session = meta.id ?? state.session;
      state.cwd = meta.cwd ?? state.cwd;
    } else {
      const record = convert(r, line, state);
      if (record) yield record;
    }
  }
}
