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
//   (tools/hooks/leaks.mjs — the terms are kept outside the repository). The repository is the one
//   the call works in: `-C`, `--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE` and a `cd` before
//   it are taken, as the mount rules take them (the shared parser, shell.mjs);
// - deny, in an installation: what ADR 0007 D02 and D05 say of a shell command (mount-shell.mjs) —
//   no write into a mount (a redirection, a git write), no search above the installation, no path of
//   another installation that is not registered as a mount. These rules run after the privilege,
//   staging and commit rules and before the landing ask. A check of any rule that throws is a deny
//   naming the check and the error, never a throw to the dispatcher, which fails open and skips every
//   rule behind the failure; the privilege rule reads the segments only, so it decides first and whatever
//   else throws.
import { basename, dirname } from 'node:path';
import { shellSegments, decide } from './common.mjs';
import { shellCommand } from './host.mjs';
import { inCore, findLeaks, describe } from './leaks.mjs';
import { assignedVars, dirsAlong, gitCalls, gitPlaces } from './shell.mjs';
import { boundaryOf, failedCheckReason } from './boundary.mjs';
import { shellMountProblem } from './mount-shell.mjs';
import { installRoot } from '../common/paths.mjs';

const PRIVILEGED = new Set(['sudo', 'su', 'doas', 'pkexec']);
const STAGE_ALL = new Set(['-A', '--all', '.', '*', ':/', ':']);
const LANDING = { gh: [['pr', 'create'], ['pr', 'merge'], ['release', 'create']], glab: [['mr', 'create']], npm: [['publish']] };

const commitAll = (rest) => rest.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith('--'));

/**
 * Whether a git call works in the oikos core repository: in the work tree or git directory it is
 * pointed at (`-C`, `--work-tree`, `--git-dir`, the variables), from the session's folder or any
 * folder a `cd` of the command leads to; `vars` are the variables the command sets.
 */
function targetsCore(call, dirs, vars) {
  return dirs.some((dir) => {
    const places = gitPlaces(call, dir, vars);
    if (!places) return false;
    const { workTree, gitDir } = places;
    return inCore(workTree) || (gitDir !== null && inCore(basename(gitDir) === '.git' ? dirname(gitDir) : gitDir));
  });
}

/** The reason a staged tree of the core names a private term, or null. */
function leakReason() {
  const hits = findLeaks();
  if (!hits?.length) return null;
  return `oikos git guard: the oikos core is public, and ${hits.length} staged place(s) name what `
    + `belongs to an installation (an organization, a person, a host):\n${describe(hits)}\nMove it to the installation or write `
    + 'it neutrally (ACME Corp, example.com, PROJ-123), stage again, then commit.';
}

/** Why one git call is denied, or null; `dirs()` gives the folders the command may run in, read only for a commit. */
function gitDenial(call, dirs, vars) {
  const { sub, rest } = call;
  if (sub === 'add' && rest.some((a) => STAGE_ALL.has(a))) return 'oikos git guard: stage files by name (`git add <path>…`), not everything at once — `git status` first.';
  if (sub !== 'commit') return null;
  if (commitAll(rest)) return 'oikos git guard: `git commit -a` stages everything; `git add <path>…` by name, then commit.';
  return targetsCore(call, dirs(), vars) ? leakReason() : null;
}

/** The landing route of a segment (`git push`, `gh pr create`, …), or null; `call` is its git call, if it is one. */
function landingRoute({ exe, args }, call) {
  let route = call?.sub === 'push' ? 'git push' : null;
  for (const pattern of LANDING[exe] || []) {
    if (pattern.every((word, k) => args[k] === word)) route = `${exe} ${pattern.join(' ')}`;
  }
  return route;
}

/** The reason for a check of this guard that threw: it names the check (`name`), the command it was judging and the error. */
const failure = (name, command, error) => failedCheckReason('git guard', name, `\`${command.length > 80 ? `${command.slice(0, 80)}…` : command}\``, error);

/** The denial of `check()`, or null; a check that throws is a denial that names it and the error. */
function checked(name, command, check) {
  try {
    return check();
  } catch (error) {
    return failure(name, command, error);
  }
}

/** Why a command is denied by the boundary of an installation (ADR 0007 D02, D05), or null; outside an installation there is none. */
function boundaryDenial(command, payload) {
  const install = installRoot();
  return install ? shellMountProblem(command, payload.cwd || install, boundaryOf(install)) : null;
}

/** Why a segment is denied for privilege escalation, or null. */
const privilegeDenial = ({ exe }) => (PRIVILEGED.has(exe)
  ? `oikos git guard: ${exe} is not run by the agent. If something needs root, tell the user what and why; they run it themselves.`
  : null);

/** The first denial of the staging and commit rules, or null; they read the command only, never the boundary code. */
function gitRuleDenial(segments, payload) {
  const calls = gitCalls(segments);
  const vars = assignedVars(segments);
  let dirs;
  const dirsOfCommand = () => (dirs ??= dirsAlong(segments, payload.cwd || process.cwd()).dirs);
  for (const segment of segments) {
    const denial = calls.has(segment) ? gitDenial(calls.get(segment), dirsOfCommand, vars) : null;
    if (denial) return denial;
  }
  return null;
}

/** The landing ask — the route of the first segment that publishes — or null. */
function landingAsk(segments) {
  const calls = gitCalls(segments);
  for (const segment of segments) {
    const route = landingRoute(segment, calls.get(segment));
    if (route) return `oikos git guard: ${route} publishes — only on the user's explicit request. Confirm it was asked for.`;
  }
  return null;
}

export function run(payload) {
  let command;
  try {
    command = shellCommand(payload);
  } catch (error) {
    return decide(payload, 'deny', failure('read of the shell command', 'the payload', error));
  }
  if (!command) return;
  let segments = [];
  const unparsed = checked('parse of the shell command', command, () => { segments = shellSegments(command); return null; });
  const denial = unparsed
    ?? segments.map(privilegeDenial).find(Boolean)
    ?? checked('staging and commit rules', command, () => gitRuleDenial(segments, payload))
    ?? checked('boundary check of the shell command', command, () => boundaryDenial(command, payload));
  if (denial) return decide(payload, 'deny', denial);
  let ask;
  try {
    ask = landingAsk(segments);
  } catch (error) {
    return decide(payload, 'deny', failure('landing rule', command, error));
  }
  if (ask) decide(payload, 'ask', ask);
}
