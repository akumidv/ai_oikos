// The Qwen Code transcript adapter (docs/design/footprint.md § Host formats): `<projects>/<slug>/chats/
// <sessionId>.jsonl`, one record per line, content as `message.parts[]`. The owner is the record whose
// `provenance` is `real_user`, and the answer to an `ask_user_question` call; the rest of the user-role text is injected context.
import { basename, join } from 'node:path';
import { CHOICE_DIALOG, DELEGATION, entriesOf, jsonLines, lastText } from './lines.mjs';

/** The host's name in events and notes. */
export const host = 'qwen';

const TOOLS = new Map([['agent', DELEGATION], ['create_sub_session', DELEGATION], ['ask_user_question', CHOICE_DIALOG]]);

/**
 * The folder read when the settings name none: `~/.qwen/projects`.
 *
 * @param {{ env: NodeJS.ProcessEnv, home: string }} where the environment and home to read
 * @returns {string[]}
 */
export const defaultFolders = ({ home }) => [join(home, '.qwen', 'projects')];

/**
 * The folders read for a folder the settings name.
 *
 * @param {string} folder the settings' path
 * @returns {string[]}
 */
export const givenFolders = (folder) => [folder];

/**
 * The transcripts under a projects folder: `<slug>/chats/*.jsonl`, not the `.ledger.jsonl` files. The
 * sub-agent files (`<slug>/subagents/`) are elsewhere and never listed.
 *
 * @param {string} folder the projects folder
 * @param {(error: Error) => void} [onError] told of a folder that could not be read
 * @returns {string[]}
 */
export function listTranscripts(folder, onError = () => {}) {
  const files = [];
  for (const slug of entriesOf(folder, onError)) {
    if (!slug.isDirectory()) continue;
    const chats = join(folder, slug.name, 'chats');
    // a project with no chats yet is not an error
    for (const entry of entriesOf(chats, onError, true)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.ledger.jsonl')) files.push(join(chats, entry.name));
    }
  }
  return files.sort();
}

/** The text parts of a record that are not the model's thoughts. */
const spokenParts = (parts) => parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text);

/** An assistant record: its last spoken part, a final candidate when it calls no function, and its calls. */
function assistantRecord(parts, base) {
  const calls = parts.filter((p) => p?.functionCall);
  const text = lastText(spokenParts(parts));
  return {
    ...base, role: 'assistant', text, finalCandidate: text !== undefined && !calls.length,
    tools: calls.map((p) => TOOLS.get(p.functionCall.name)).filter(Boolean),
  };
}

/**
 * The answers the owner gave in a choice dialog, as one text read in memory and never kept: the
 * `answers` of the result of an `ask_user_question` call that succeeded. Null for any other record.
 */
function dialogAnswer(r, parts) {
  const answered = parts.some((p) => p?.functionResponse?.name === 'ask_user_question');
  const display = r.toolCallResult?.resultDisplay;
  if (!answered || r.toolCallResult?.status !== 'success' || !Array.isArray(display?.answers)) return null;
  const answers = display.answers.flatMap((a) => (Array.isArray(a?.answer) ? a.answer : [a?.answer])).filter((a) => typeof a === 'string');
  return answers.length ? answers.join('\n') : null;
}

/**
 * A user-role or tool-result record: the owner's typed text when the host says a real user typed it,
 * the owner's answer to a choice dialog (its chosen answers), else `other`.
 */
function userRecord(r, parts, base) {
  if (r.type === 'user' && r.provenance === 'real_user') return { ...base, role: 'owner', text: spokenParts(parts).join('\n') };
  const answer = r.type === 'tool_result' ? dialogAnswer(r, parts) : null;
  return answer === null ? { ...base, role: 'other' } : { ...base, role: 'owner', text: answer };
}

/**
 * The main-thread user and assistant records of a transcript in the shared form; `system` records
 * and `isSidechain` records are left out, tool results are `other`.
 *
 * @param {string} file the transcript's path
 * @param {{ unreadable: number }} stats counters of the host being read
 * @returns {AsyncGenerator<object>}
 */
export async function* readTranscript(file, stats) {
  const fallback = basename(file, '.jsonl');
  for await (const { value: r, line } of jsonLines(file, stats)) {
    if (r.isSidechain === true || !['user', 'assistant', 'tool_result'].includes(r.type)) continue;
    const base = { at: r.timestamp, session: r.sessionId ?? fallback, recordId: r.uuid ?? `L${line}`, cwd: r.cwd ?? null, tools: [] };
    const parts = Array.isArray(r.message?.parts) ? r.message.parts : [];
    yield r.type === 'assistant' ? assistantRecord(parts, base) : userRecord(r, parts, base);
  }
}
