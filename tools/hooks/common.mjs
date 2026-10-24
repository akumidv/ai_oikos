// Shared plumbing for the oikos hooks in tools/hooks/: payload in, JSON out, per-session state in
// the temp directory. A hook never crashes a tool call or a prompt: on its own failure it says so
// in the UI and lets the action through (fail open). The event payload and
// this output shape are the same in every agent host oikos runs under; where the hosts differ is
// the names of their tools, and that is tools/hooks/host.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function readPayload() {
  try {
    const data = JSON.parse(readFileSync(0, 'utf8') || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function print(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const STATE_DIR = join(tmpdir(), 'oikos-hooks');
const statePath = (sessionId, kind) => join(STATE_DIR, `${kind}-${String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export function readState(sessionId, kind, fallback) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId, kind), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeState(sessionId, kind, value) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(sessionId, kind), JSON.stringify(value));
}

/**
 * A Bash command split into segments at `;` `&&` `||` `|` `&` newlines and parentheses, each a
 * list of quote-aware tokens with the leading control words (`if`, `then`, `do`, `!`, `{`, …),
 * `VAR=…`, `env …`, `command`, `nohup`, `time`, `exec` stripped, so `exe` is the program actually
 * run (`for b in x; do git push; done` runs `git`). Best effort: text inside `bash -c "…"` or a
 * heredoc is one token and is not looked into here (the write guard reads `bash -c` itself).
 */
export function shellSegments(command) {
  const segments = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const endToken = () => { if (token !== null) tokens.push(token); token = null; };
  const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      // In double quotes bash drops a backslash only before $ ` " \ and a newline (the pair
      // `\`+newline vanishes); before any other character it stays.
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && command[i + 1] === '\n') i++;
      else if (ch === '\\' && quote === '"' && '$`"\\'.includes(command[i + 1] ?? 'x')) token += command[++i];
      else token += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      token ??= '';
    } else if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') i++;
      else token = (token ?? '') + command[++i];
    } else if (';&|\n()'.includes(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token = (token ?? '') + ch;
    }
  }
  endSegment();
  return segments.map(stripPrefix);
}

const PREFIXES = new Set(['command', 'nohup', 'time', 'exec', 'builtin']);
/**
 * The shell's control words that may stand before a command in one segment: the command after
 * them is the one that runs. A reserved word counts only as the first word of a command or after
 * another one, so they are stripped before any `VAR=…` or prefix, never after.
 */
const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time']);

/**
 * One segment's tokens read as shellSegments reads them: the leading control words, `VAR=…`,
 * `env …` and prefixes stripped to find `exe`, the program actually run. `tokens` stays the
 * segment as written.
 * @param {string[]} tokens
 * @returns {{exe: string|null, args: string[], viaEnv: boolean, tokens: string[]}}
 */
export function stripPrefix(tokens) {
  let i = 0;
  let viaEnv = false;
  while (i < tokens.length && CONTROL_WORDS.has(tokens[i])) i++;
  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (tokens[i] === 'env') {
      viaEnv = true;
      i++;
      while (i < tokens.length && (tokens[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
        if (['-u', '--unset', '-C', '--chdir', '-S'].includes(tokens[i])) i++;
        i++;
      }
      continue;
    }
    if (PREFIXES.has(tokens[i])) { i++; continue; }
    break;
  }
  const exe = tokens[i] ? tokens[i].split('/').pop() : null;
  return { exe, args: tokens.slice(i + 1), viaEnv, tokens };
}

/** PreToolUse decisions. `ask` reaches a person only in an interactive default mode — Claude Code
 * names it `default`, Qwen Code too (`plan|default|auto-edit|auto|yolo`); an unattended ask was
 * measured to be a silent no-op. Everywhere else it is turned into a deny that says how to run
 * the command oneself. */
export function decide(payload, decision, reason) {
  const unattended = decision === 'ask' && payload.permission_mode && payload.permission_mode !== 'default';
  print({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: unattended ? 'deny' : decision,
      permissionDecisionReason: unattended
        ? `${reason} (Permission mode "${payload.permission_mode}" cannot ask, so this is denied: the user runs it themselves with \`! <command>\`, or in the default mode.)`
        : reason,
    },
  });
}
