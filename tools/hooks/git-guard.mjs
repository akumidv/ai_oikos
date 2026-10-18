#!/usr/bin/env node
// PreToolUse(shell): git and privilege guard.
// It covers this repository and a user's vault alike (a vault push may publish to a knowledge base).
//
// - deny: staging everything (`git add -A|--all|.|*|:/`, `git commit -a|--all`) — stage by
//   name, so a stray file (a draft, a token) never rides along;
// - deny: privilege escalation (`sudo`, `su`, `doas`, `pkexec`) — setup never installs system
//   packages;
// - ask: landing — `git push`, `gh pr create|merge`, `gh release create`, `glab mr create`,
//   `npm publish`. Outside the default permission mode an ask cannot reach the user, so it
//   becomes a deny that tells the user to run the command themselves;
// - deny: a commit in the oikos core repository whose staged tree names a private term
//   (tools/hooks/leaks.mjs — the terms are kept outside the repository).
import { shellSegments, decide } from './common.mjs';
import { shellCommand } from './host.mjs';
import { inCore, findLeaks, describe } from './leaks.mjs';

const PRIVILEGED = new Set(['sudo', 'su', 'doas', 'pkexec']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path']);
const STAGE_ALL = new Set(['-A', '--all', '.', '*', ':/', ':']);
const LANDING = { gh: [['pr', 'create'], ['pr', 'merge'], ['release', 'create']], glab: [['mr', 'create']], npm: [['publish']] };

/** The git subcommand and its arguments, past git's own global options. */
function gitSub(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  return { sub: args[i], rest: args.slice(i + 1) };
}

const commitAll = (rest) => rest.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith('--'));

export function run(payload) {
  const command = shellCommand(payload);
  if (!command) return;
  const segments = shellSegments(command);

  for (const { exe, args } of segments) {
    if (PRIVILEGED.has(exe)) {
      return decide(payload, 'deny', `oikos git guard: ${exe} is not run by the agent. If something needs root, tell the user what and why; they run it themselves.`);
    }
    if (exe !== 'git') continue;
    const { sub, rest } = gitSub(args);
    if (sub === 'add' && rest.some((a) => STAGE_ALL.has(a))) {
      return decide(payload, 'deny', 'oikos git guard: stage files by name (`git add <path>…`), not everything at once — `git status` first.');
    }
    if (sub === 'commit' && commitAll(rest)) {
      return decide(payload, 'deny', 'oikos git guard: `git commit -a` stages everything; `git add <path>…` by name, then commit.');
    }
    if (sub === 'commit' && inCore(payload.cwd || process.cwd())) {
      const hits = findLeaks();
      if (hits?.length) {
        return decide(payload, 'deny', `oikos git guard: the oikos core is public, and ${hits.length} staged place(s) name what `
          + `belongs to an installation (an organization, a person, a host):\n${describe(hits)}\nMove it to the installation or write `
          + 'it neutrally (ACME Corp, example.com, PROJ-123), stage again, then commit.');
      }
    }
  }

  for (const { exe, args } of segments) {
    let route = null;
    if (exe === 'git' && gitSub(args).sub === 'push') route = 'git push';
    for (const pattern of LANDING[exe] || []) {
      if (pattern.every((word, k) => args[k] === word)) route = `${exe} ${pattern.join(' ')}`;
    }
    if (route) {
      return decide(payload, 'ask', `oikos git guard: ${route} publishes — only on the user's explicit request. Confirm it was asked for.`);
    }
  }
}
