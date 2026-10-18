// How the guards in this folder are wired into each agent host's settings: the one table behind
// `.claude/settings.json` and `.qwen/settings.json` — of an installation, where the entry is
// `oikos/tools/hooks/…`, and of the core repository itself, where it is `tools/hooks/…`.
// `sync` writes oikos's entries of the `hooks` key from it and leaves every other entry alone,
// `check` fails when they drift — the wiring is a fact about oikos, so it is kept once, not
// copied per host.
//
// What differs per host is only the `matcher` vocabulary and the name of the project-folder
// variable. Qwen Code matches a tool call by its canonical snake_case name (an unanchored
// alternation written in Claude's names half-matches here and reports neither), so its matchers
// are anchored and spelled in its own vocabulary. Both hosts expand `$CLAUDE_PROJECT_DIR` and
// `$QWEN_PROJECT_DIR` to the project folder of the session; each file uses its own name.
import { join } from 'node:path';

/** The dispatcher every guard runs through: one process per call, the guard named as argument. */
export const HOOK_ENTRY = 'tools/hooks/host-hook.mjs';

/**
 * Each wiring: a guard, the event it listens to, and the matcher group of that event.
 * Order here is the order in the generated files.
 */
export const WIRING = [
  { guard: 'session-start', event: 'SessionStart', group: 'session' },
  { guard: 'write-guard', event: 'UserPromptSubmit' },
  { guard: 'context-pressure', event: 'UserPromptSubmit' },
  { guard: 'write-guard', event: 'PreToolUse', group: 'shell' },
  { guard: 'git-guard', event: 'PreToolUse', group: 'shell' },
  { guard: 'secret-guard', event: 'PreToolUse', group: 'shell' },
  { guard: 'secret-guard', event: 'PreToolUse', group: 'file' },
  { guard: 'package-guard', event: 'PreToolUse', group: 'file' },
  { guard: 'context-pressure', event: 'PreToolUse', group: 'agent' },
];

// `seed`: the host's own keys a settings file starts with when `sync` creates it; afterwards they
// are the host's and the person's, never rewritten. Both hosts pre-allow the browser's read-only
// DevTools tools, each per tool (`mcp__<server>__<tool>`), never the whole server, which also writes.
const CHROME_READS = ['list_pages', 'take_snapshot', 'take_screenshot', 'list_console_messages', 'list_network_requests'];
const CHROME_READ_RULES = CHROME_READS.map((t) => `mcp__chrome-devtools__${t}`);

export const HOSTS = {
  claude: {
    dir: '.claude',
    var: 'CLAUDE_PROJECT_DIR',
    seed: { enableAllProjectMcpServers: true, permissions: { allow: CHROME_READ_RULES } },
    matchers: {
      session: null,
      shell: 'Bash',
      file: 'Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob',
      agent: 'Task|Agent',
    },
  },
  qwen: {
    dir: '.qwen',
    var: 'QWEN_PROJECT_DIR',
    seed: { permissions: { allow: CHROME_READ_RULES } },
    matchers: {
      session: 'startup|resume|clear|compact',
      shell: '^run_shell_command$',
      file: '^(read_file|grep_search|glob|list_directory|edit|write_file|notebook_edit)$',
      agent: '^agent$',
    },
  },
};

export const hostNames = Object.keys(HOSTS);

/** Where a host keeps its shared project settings, relative to the project root. */
export const settingsFile = (host) => join(HOSTS[host].dir, 'settings.json');

/** The command of a guard; `base` is where oikos is from the project folder ('' or 'oikos/'). */
export function hookCommand(host, guard, base = '') {
  return `node "$${HOSTS[host].var}/${base}${HOOK_ENTRY}" ${guard}`;
}

/** A command oikos wrote: its dispatcher, or one of the older per-guard hook files. */
export const isOikosCommand = (command) => /(^|[\/"\s])tools\/hooks\/[a-z-]+\.mjs\b/.test(String(command || ''));

/** The oikos part of a `hooks` value: oikos's commands only, empty groups and events dropped. */
export function oikosPart(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    const kept = (Array.isArray(groups) ? groups : []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => isOikosCommand(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

/**
 * `current` with oikos's entries replaced by `wanted`: every other command — a person's own, another
 * tool's (akmon) — stays where it is; a group left with none of them goes, and oikos's groups lead
 * each event, in table order.
 */
export function mergeHooks(current, wanted) {
  const out = {};
  const events = [...Object.keys(wanted), ...Object.keys(current || {}).filter((e) => !(e in wanted))];
  for (const event of events) {
    const foreign = (Array.isArray(current?.[event]) ? current[event] : [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOikosCommand(h.command)) }))
      .filter((g) => g.hooks.length);
    const groups = [...(wanted[event] || []), ...foreign];
    if (groups.length) out[event] = groups;
  }
  return out;
}

/** The body of oikos's part of the host's `hooks` key: event → matcher groups → commands, in table order. */
export function hooksFor(host, base = '') {
  const host_ = HOSTS[host];
  if (!host_) throw new Error(`unknown agent host "${host}" in tools/hooks/wiring.mjs`);
  const events = [];
  for (const w of WIRING) if (!events.includes(w.event)) events.push(w.event);
  const out = {};
  for (const event of events) {
    const groups = [];
    for (const w of WIRING.filter((x) => x.event === event)) {
      const key = w.group || null;
      if (key && !groups.includes(key)) groups.push(key);
    }
    if (!groups.length) {
      out[event] = [{ hooks: WIRING.filter((w) => w.event === event).map((w) => command(host, w.guard, base)) }];
      continue;
    }
    out[event] = groups.map((key) => {
      const matcher = host_.matchers[key];
      return {
        ...(matcher ? { matcher } : {}),
        hooks: WIRING.filter((w) => w.event === event && (w.group || null) === key).map((w) => command(host, w.guard, base)),
      };
    });
  }
  return out;
}

const command = (host, guard, base) => ({ type: 'command', command: hookCommand(host, guard, base) });

/** The guard a wired command names: the dispatcher's argument, or an older hook file's name. */
function guardOf(command) {
  const parts = String(command || '').trim().split(/\s+/);
  const entry = parts.findIndex((p) => p.endsWith('host-hook.mjs') || p.endsWith('host-hook.mjs"'));
  if (entry >= 0) return parts[entry + 1] || '';
  return (parts[parts.length - 1] || '').replace(/["']/g, '').split('/').pop().replace(/\.mjs$/, '');
}

/** The guards a settings file wires, as `{ event+matcher: [guard…] }` — what `check` compares. */
export function guardsIn(hooks) {
  const found = {};
  for (const [event, groups] of Object.entries(oikosPart(hooks))) {
    for (const group of groups) {
      const key = `${event}:${group.matcher ?? ''}`;
      found[key] = (found[key] || []).concat(group.hooks.map((h) => guardOf(h.command)).filter(Boolean));
    }
  }
  return found;
}
