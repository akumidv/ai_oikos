#!/usr/bin/env node
// Enforces "writes need confirmation" (OIKOS.md) for every oikos tool that changes a remote
// service: the tools and commands listed in tools/hooks/writes.mjs, and nothing else.
//
// A changing command (tools/hooks/writes.mjs) runs for real only if the same command was first
// run with --dry-run in this session AND the user has sent a prompt since — i.e. the user has
// seen the dry run and had a turn to answer. Otherwise the call is denied with the reason, in
// every permission mode, so auto mode cannot skip the step. The hook cannot judge what the user
// answered; it guarantees the dry run was shown and the user had the word.
//
// Wired twice: UserPromptSubmit counts the user's prompts, PreToolUse(shell) checks the command.
// "The same command" is the whole shell command with `--dry-run` removed and whitespace
// collapsed, so any change to the text after the dry run needs a new dry run.
import { print, readState, writeState } from './common.mjs';
import { shellCommand } from './host.mjs';
import { WRITES } from './writes.mjs';

/**
 * The pattern of a call of one of `names` with its command word, in both forms:
 * `tools/<tool>/cli.mjs <command>` and `npm run <tool> [--] <command>`. The tool is group 1 or 2,
 * the command group 3. Longest name first, so `github-issues` is never read as `github`.
 * @param {string[]} names tool names (folders under tools/), hyphens allowed
 * @returns {RegExp} a global pattern for `matchAll`
 */
export function toolCallPattern(names) {
  const tools = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('|');
  return new RegExp(`(?:\\btools\\/(${tools})\\/cli\\.mjs|\\bnpm\\s+run\\s+(${tools})(?:\\s+--)?)\\s+([a-z][a-z-]*)`, 'g');
}

const TOOL_CALL = toolCallPattern(Object.keys(WRITES));
const DRY_RUN = /(^|\s)--dry-run(?=\s|$)/g;
const HAS_DRY_RUN = /(^|\s)--dry-run(?=\s|$)/;

const signature = (command) => command.replace(DRY_RUN, ' ').replace(/\s+/g, ' ').trim();

function writesIn(command) {
  const found = [];
  for (const m of command.matchAll(TOOL_CALL)) {
    const tool = m[1] || m[2];
    if (WRITES[tool]?.includes(m[3])) found.push(`${tool} ${m[3]}`);
  }
  return [...new Set(found)];
}

function deny(reason) {
  print({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

export function run(payload) {
  const sid = payload.session_id;
  const state = readState(sid, 'writes', { prompts: 0, dryRuns: {} });

  if (payload.hook_event_name === 'UserPromptSubmit') {
    if (payload.agent_id) return;
    state.prompts += 1;
    writeState(sid, 'writes', state);
    return;
  }

  const command = shellCommand(payload);
  if (!command) return;
  const writes = writesIn(command);
  if (!writes.length || /(^|\s)--help(?=\s|$)/.test(command)) return;

  const sig = signature(command);
  if (HAS_DRY_RUN.test(command)) {
    state.dryRuns[sig] = state.prompts;
    writeState(sid, 'writes', state);
    return;
  }

  const shownAt = state.dryRuns[sig];
  if (shownAt === undefined) {
    return deny(
      `oikos write guard: ${writes.join(', ')} changes a remote service. Run the same command with --dry-run first, ` +
        'show the result to the user and wait for their confirmation; then run it again unchanged without --dry-run.',
    );
  }
  if (shownAt >= state.prompts) {
    return deny(
      `oikos write guard: the dry run of ${writes.join(', ')} has not been answered yet. ` +
        'Show it to the user and wait for their confirmation in their next message.',
    );
  }
  delete state.dryRuns[sig];
  writeState(sid, 'writes', state);
}
