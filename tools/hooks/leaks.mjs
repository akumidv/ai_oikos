#!/usr/bin/env node
// The core's leak check: nothing that names an organization or a person may reach the public
// repository. The words that would — an organization's name and hosts, people, task keys — are
// themselves private, so they are kept outside the repository, one per line, in
// `~/.config/oikos/private-terms` (`$XDG_CONFIG_HOME/oikos/private-terms`; OIKOS_PRIVATE_TERMS names
// another file; `#` starts a comment). The whole index of the core is searched — what a commit
// would record — case-insensitively, as fixed strings.
//
// git-guard runs it before the agent's `git commit` in the core repository. For the user's own
// commits it is a git pre-commit hook: `node tools/hooks/leaks.mjs install` (once per clone).
//
//   node tools/hooks/leaks.mjs [check]   the staged tree against the terms; exit 1 on a hit
//   node tools/hooks/leaks.mjs install   write .git/hooks/pre-commit (never over another hook)
import { existsSync, readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../common/paths.mjs';
import { isMain } from '../common/cli.mjs';

export const termsFile = (env = process.env) => env.OIKOS_PRIVATE_TERMS
  || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'oikos', 'private-terms');

/** The private terms, or null when there is no terms file. */
export function loadTerms(file = termsFile()) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

/** The top of the git repository `cwd` is in, or null. */
export function repoTop(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Whether `cwd` is in the core repository itself (not an installation's repository). */
export function inCore(cwd) {
  const top = repoTop(cwd);
  try {
    return Boolean(top) && realpathSync(top) === realpathSync(CORE_ROOT);
  } catch {
    return false;
  }
}

/**
 * [{ file, line, term }] for every staged line of the repository at `repo` holding a private term;
 * null when there are no terms to check against.
 */
export function findLeaks(repo = CORE_ROOT, terms = loadTerms()) {
  if (!terms || !terms.length) return null;
  const args = ['grep', '--cached', '-I', '-n', '-i', '-F', ...terms.flatMap((t) => ['-e', t])];
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status > 1) throw new Error(`git grep failed: ${(r.stderr || '').trim()}`);
  const hits = [];
  for (const row of (r.stdout || '').split('\n').filter(Boolean)) {
    const m = row.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const text = m[3].toLowerCase();
    for (const term of terms) if (text.includes(term.toLowerCase())) hits.push({ file: m[1], line: Number(m[2]), term });
  }
  // a file name can leak too
  const names = spawnSync('git', ['ls-files', '--cached'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
  for (const file of names.split('\n').filter(Boolean)) {
    for (const term of terms) if (file.toLowerCase().includes(term.toLowerCase())) hits.push({ file, line: 0, term });
  }
  return hits;
}

export const describe = (hits, max = 20) => hits.slice(0, max).map((h) => `  ${h.file}${h.line ? `:${h.line}` : ' (name)'} — "${h.term}"`)
  .concat(hits.length > max ? [`  … ${hits.length - max} more`] : []).join('\n');

const HOOK = `#!/bin/sh
# oikos: no organization's or person's names in the core (tools/hooks/leaks.mjs)
exec node "$(git rev-parse --show-toplevel)/tools/hooks/leaks.mjs" check
`;

if (isMain(import.meta.url)) {
  const command = process.argv[2] || 'check';
  if (command === 'install') {
    const top = repoTop(CORE_ROOT);
    const hook = join(top, '.git', 'hooks', 'pre-commit');
    if (existsSync(hook) && !readFileSync(hook, 'utf8').includes('tools/hooks/leaks.mjs')) {
      console.error(`${hook} exists and is not oikos's — add \`node tools/hooks/leaks.mjs check\` to it by hand`);
      process.exit(1);
    }
    writeFileSync(hook, HOOK);
    chmodSync(hook, 0o755);
    console.log(`wrote ${hook}${loadTerms() ? '' : `; no terms yet — put them in ${termsFile()}, one per line`}`);
    process.exit(0);
  }
  if (command !== 'check') {
    console.error('usage: node tools/hooks/leaks.mjs [check | install]');
    process.exit(1);
  }
  const hits = findLeaks();
  if (hits === null) {
    console.error(`oikos leak check: no private terms (${termsFile()}) — nothing checked`);
    process.exit(0);
  }
  if (hits.length) {
    console.error(`oikos leak check: ${hits.length} staged place(s) name what must stay out of the core:\n${describe(hits)}`);
    process.exit(1);
  }
  console.log('oikos leak check: clean');
}
