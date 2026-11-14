// The Claude Code transcript adapter (docs/design/footprint.md § Host formats): `<projects>/<slug>/
// <sessionId>.jsonl`, one record per line. It tells the owner's typed messages from the context the host
// injects as user-role text by the record's provenance fields, and turns the records into the shared
// form `{ role, at, session, recordId, cwd, text?, note?, finalCandidate?, tools }`.
import { basename, join } from 'node:path';
import { CHOICE_DIALOG, DELEGATION, entriesOf, jsonLines, lastText } from './lines.mjs';

/** The host's name in events and notes. */
export const host = 'claude';

const TOOLS = new Map([['Agent', DELEGATION], ['Task', DELEGATION], ['AskUserQuestion', CHOICE_DIALOG]]);

/**
 * The folder read when the settings name none: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`.
 *
 * @param {{ env: NodeJS.ProcessEnv, home: string }} where the environment and home to read
 * @returns {string[]}
 */
export const defaultFolders = ({ env, home }) => [env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'projects') : join(home, '.claude', 'projects')];

/**
 * The folders read for a folder the settings name.
 *
 * @param {string} folder the settings' path
 * @returns {string[]}
 */
export const givenFolders = (folder) => [folder];

/**
 * The transcripts under a projects folder: the `.jsonl` files directly in each project folder. The
 * sub-agent files (`<sessionId>/subagents/`) are deeper and never listed.
 *
 * @param {string} folder the projects folder
 * @param {(error: Error) => void} [onError] told of a folder that could not be read
 * @returns {string[]}
 */
export function listTranscripts(folder, onError = () => {}) {
  const files = [];
  for (const slug of entriesOf(folder, onError)) {
    if (!slug.isDirectory()) continue;
    for (const entry of entriesOf(join(folder, slug.name), onError)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.ledger.jsonl')) files.push(join(folder, slug.name, entry.name));
    }
  }
  return files.sort();
}

/** The content blocks of a message: a string is one text block. */
const blocksOf = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: content }]);
const textBlocks = (blocks) => blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);

/** A `"question"="answer"` pair in the text of an AskUserQuestion result. */
const ANSWER_PAIR = /"(?:[^"\\]|\\.)*"="((?:[^"\\]|\\.)*)"/g;

/**
 * The answers the owner chose in a choice dialog, as one text read in memory and never kept: the
 * `answers` of the record's `toolUseResult` (question → chosen labels or typed text), else the pairs in
 * the result's text. Null when the result is not the answer to an AskUserQuestion call of this
 * transcript, or the owner declined it (an error result) or it holds no answer.
 *
 * @param {object} record the user record
 * @param {object[]} blocks its content blocks
 * @param {Set<string>} dialogs the ids of the AskUserQuestion calls met so far
 * @returns {string|null}
 */
function dialogAnswer(record, blocks, dialogs) {
  const result = blocks.find((b) => b?.type === 'tool_result' && dialogs.has(b.tool_use_id));
  if (!result || result.is_error) return null;
  const given = record.toolUseResult?.answers;
  const text = Array.isArray(result.content) ? textBlocks(result.content).join('\n') : String(result.content ?? '');
  const answers = given && typeof given === 'object' && !Array.isArray(given)
    ? Object.values(given).flat().filter((a) => typeof a === 'string')
    : [...text.matchAll(ANSWER_PAIR)].map((m) => m[1]);
  return answers.length ? answers.join('\n') : null;
}

/** The line the host writes before a note of a side agent that the owner forwards (a human-origin user record). */
const SIDE_NOTE_PREAMBLE = 'Here is a note offered by a side agent:';

/**
 * A forwarded side-agent note told from the owner's own words: the host writes the preamble line, then
 * the note as a block of `>`-quoted lines (blank lines between them); the owner's comment is the text
 * before the preamble and the first line after the quote that is neither blank nor quoted.
 *
 * @param {string} text the typed text of a user record
 * @returns {{ owner: string, note: string }|null} null when the text holds no forwarded note
 */
function splitSideNote(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === SIDE_NOTE_PREAMBLE);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].trimStart().startsWith('>'))) end += 1;
  return { owner: [...lines.slice(0, start), ...lines.slice(end)].join('\n'), note: lines.slice(start + 1, end).join('\n') };
}

/**
 * A user record: the owner's typed text (with a forwarded side-agent note apart as `note`), the owner's
 * answer to a choice dialog (its chosen answers, the way Codex's reply is read), or `other` for injected,
 * meta, summary, peer and other tool-result records.
 */
function userRecord(record, base, dialogs) {
  const blocks = blocksOf(record.message?.content);
  const answer = dialogAnswer(record, blocks, dialogs);
  if (answer !== null) return { ...base, role: 'owner', text: answer };
  const injected = record.isMeta || record.isCompactSummary || (record.origin?.kind && record.origin.kind !== 'human')
    || blocks.some((b) => b?.type === 'tool_result');
  if (injected) return { ...base, role: 'other' };
  const text = textBlocks(blocks).join('\n');
  const side = splitSideNote(text);
  return side ? { ...base, role: 'owner', text: side.owner, note: side.note } : { ...base, role: 'owner', text };
}

/** Add the ids of the AskUserQuestion calls of an assistant record to `dialogs`. */
function noteDialogs(record, dialogs) {
  for (const b of blocksOf(record.message?.content)) {
    if (b?.type === 'tool_use' && TOOLS.get(b.name) === CHOICE_DIALOG && b.id) dialogs.add(b.id);
  }
}

/** An assistant record: its last text block, a final candidate when it calls no tool, and its tool calls. */
function assistantRecord(record, base) {
  const blocks = blocksOf(record.message?.content);
  const calls = blocks.filter((b) => b?.type === 'tool_use');
  const text = lastText(textBlocks(blocks));
  return {
    ...base, role: 'assistant', text, finalCandidate: text !== undefined && !calls.length,
    tools: calls.map((b) => TOOLS.get(b.name)).filter(Boolean),
  };
}

/**
 * The main-thread user and assistant records of a transcript in the shared form; other record types
 * and `isSidechain` records are left out.
 *
 * @param {string} file the transcript's path
 * @param {{ unreadable: number }} stats counters of the host being read
 * @returns {AsyncGenerator<object>}
 */
export async function* readTranscript(file, stats) {
  const fallback = basename(file, '.jsonl');
  const dialogs = new Set();
  for await (const { value: r, line } of jsonLines(file, stats)) {
    if (r.isSidechain === true || (r.type !== 'user' && r.type !== 'assistant')) continue;
    const base = { at: r.timestamp, session: r.sessionId ?? fallback, recordId: r.uuid ?? `L${line}`, cwd: r.cwd ?? null, tools: [] };
    if (r.type === 'assistant') noteDialogs(r, dialogs);
    yield r.type === 'user' ? userRecord(r, base, dialogs) : assistantRecord(r, base);
  }
}
