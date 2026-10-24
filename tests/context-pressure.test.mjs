// The context-pressure hook (npm test): driven as a host drives it — `host-hook.mjs
// context-pressure` with the event payload on stdin — against a one-turn transcript in a temporary
// folder, its per-session state in a temporary TMPDIR. At 85% and 95% of the working ceiling the
// advice starts with parking the work package and names the `handoff park` command (ADR 0005 D04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CORE, tempDir } from './helpers/installation.mjs';

const HOOK = join(CORE, 'tools', 'hooks', 'host-hook.mjs');

/** The hook's answer to a prompt after one assistant turn of `tokens` input tokens. */
function pressure(tokens) {
  const dir = tempDir('pressure-');
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: tokens } } })}\n`);
  const r = spawnSync(process.execPath, [HOOK, 'context-pressure'], {
    cwd: dir,
    input: JSON.stringify({ session_id: `pressure-${process.pid}-${tokens}`, hook_event_name: 'UserPromptSubmit', transcript_path: transcript }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: dir, OIKOS_CONTEXT_WINDOW: '200000' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test('below 85% the hook says nothing', () => {
  assert.equal(pressure(100_000), null);
});

test('at 85% and at 95% the advice names the handoff park command first', () => {
  const warn = pressure(172_000);
  assert.match(warn.systemMessage, /^⚠ context pressure: ~86% of 200k \(172000 tokens\) — park the work package \(node oikos\/tools\/handoff\/cli\.mjs park --task KEY --from <working files>/);
  assert.match(warn.systemMessage, /then choose \/compact or a fresh session/);
  assert.equal(warn.hookSpecificOutput.additionalContext, warn.systemMessage);
  const critical = pressure(192_000);
  assert.match(critical.systemMessage, / — critical — park the work package \(node oikos\/tools\/handoff\/cli\.mjs park /);
  assert.match(critical.systemMessage, /then \/compact or start a fresh session$/);
});
