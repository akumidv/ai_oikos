#!/usr/bin/env node
// UserPromptSubmit hook: warn when the context window fills up.
//
// The fill is the input side of the last main-chain assistant turn in the session transcript. It
// is measured against a recommended working ceiling, not the model's technical maximum: quality
// drops well before a vendor window is full. Each band warns once (85%, then 95%); a fill below
// the lowest band — after /compact — re-arms the warnings.
//
// The two hosts write their own shape into the transcript: Claude splits the input into
// `message.usage.input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` and
// names no window; Qwen Code gives one `usageMetadata.promptTokenCount` (the cached part already
// inside it) and names the model's own `contextWindowSize`. The window is therefore the working
// ceiling — env OIKOS_CONTEXT_WINDOW, else 200k — capped by the model's technical window when
// that is smaller, so a 128k model is never measured against 200k.
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { print, readState, writeState } from './common.mjs';

const DEFAULT_WINDOW = 200_000;
const BANDS = [0.85, 0.95];
const TAIL_BYTES = 4 * 1024 * 1024;
const ANTHROPIC_INPUT = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** The input side of one assistant record, in either host's shape; null when it carries none. */
function fillOf(entry) {
  const usage = entry.message?.usage;
  if (usage && typeof usage === 'object') {
    const parts = ANTHROPIC_INPUT.map((k) => usage[k]).filter(Number.isInteger);
    if (parts.length) return parts.reduce((a, b) => a + b, 0);
  }
  const meta = entry.usageMetadata;
  if (meta && Number.isInteger(meta.promptTokenCount)) return meta.promptTokenCount;
  return null;
}

/** The model's own window, when the host records it. */
const technicalOf = (entry) => (Number.isInteger(entry.contextWindowSize) && entry.contextWindowSize > 0 ? entry.contextWindowSize : null);

/** The last main-chain assistant turn; the tail of the transcript first, then all of it. */
function lastTurn(transcriptPath) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    for (const start of size > TAIL_BYTES ? [size - TAIL_BYTES, 0] : [0]) {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"') && !lines[i].includes('usageMetadata')) continue;
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (entry?.type !== 'assistant' || entry.isSidechain) continue;
        const fill = fillOf(entry);
        if (fill !== null) return { fill, technical: technicalOf(entry) };
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function windowFor(technical) {
  const override = Number.parseInt(process.env.OIKOS_CONTEXT_WINDOW || '', 10);
  const ceiling = override > 0 ? override : DEFAULT_WINDOW;
  return Math.min(technical ?? Infinity, ceiling);
}

export function run(payload) {
  if (payload.agent_id || !payload.transcript_path || !existsSync(payload.transcript_path)) return;
  const turn = lastTurn(payload.transcript_path);
  if (!turn) return;
  const fill = turn.fill;
  const window = windowFor(turn.technical);
  const ratio = fill / window;
  const band = BANDS.findLastIndex((t) => ratio >= t);

  const sid = payload.session_id;
  const { band: lastBand = -1 } = readState(sid, 'context', {});
  if (band < 0) {
    if (lastBand >= 0) writeState(sid, 'context', { band: -1 });
    return;
  }
  if (band <= lastBand) return;
  writeState(sid, 'context', { band });

  const critical = band === BANDS.length - 1;
  const advice = critical
    ? 'critical — save what must survive (vault note, draft, backlog), then /compact or start a fresh session'
    : 'save what must survive (vault note, draft, backlog), then choose /compact or a fresh session by how much of the current context the task still needs';
  const line = `⚠ context pressure: ~${Math.round(ratio * 100)}% of ${Math.round(window / 1000)}k (${fill} tokens) — ${advice}`;
  print({
    systemMessage: line,
    hookSpecificOutput: { hookEventName: payload.hook_event_name || 'UserPromptSubmit', additionalContext: line },
  });
}
