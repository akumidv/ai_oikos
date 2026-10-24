#!/usr/bin/env node
// PreToolUse: keeps secrets out of the agent's context (OIKOS.md: never print a secret).
//
// - A file tool (read, search, write) on a `.env` file (`.env`, `.env.*` except
//   `.example|.sample|.template`) at any depth, or on a closed store of `.local/` — a first name
//   there that starts with `.` (`.env`, `.secrets/`, `.browser/`) or a legacy store (`browser/`,
//   `google/`), ADR 0002 — a search scoped to `.local/` as a whole, or a glob that reaches one of
//   them: deny. Any other name under `.local/` (`TASKS.md`, `cv/`) is working material and open.
//   The tools read `.local/.env` themselves; `setup status` shows what is set, and `google whoami`
//   the Google sign-in.
// - A shell command that names such a file, `.local/` as a whole or a closed store as an argument
//   (cat, grep, cp, source…) is denied, except metadata-only commands (ls, stat, chmod, test). A
//   relative argument is judged from the session's folder and from where a `cd`/`pushd` earlier
//   in the same command leads (`cd .local/cv && grep -r x ..` searches `.local` itself). An
//   `--include`/`--glob` pattern is judged as the glob it is, an `--exclude`/`--ignore` one is
//   not: leaving a file out of a search is not reading it. Printing the environment (`env`,
//   `printenv`, `set`, `export -p`, `declare -p`) or echoing a secret-looking variable
//   (`$…TOKEN`, `$…SECRET`, `$…PASSWORD`, `$…API_KEY`) is denied too.
// Best effort against accidents, not a sandbox: `bash -c "…"` or a script file is not looked into.
import { resolve } from 'node:path';
import { shellSegments, decide } from './common.mjs';
import { isFileTool, fileTargets, globPatterns, globNamesSecret, shellCommand, isRead, isEnvFile, isLocalFolder, isLocalStore } from './host.mjs';

const METADATA = new Set(['ls', 'stat', 'chmod', 'test', '[', 'touch', 'mkdir', 'git']);
const SECRET_VAR = /\$\{?[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\b/i;
// An option whose value is a file-name pattern rather than a path, in both the `--opt value` and
// the `--opt=value` spelling. --exclude/--ignore name what the command leaves alone (a skipped
// secret stays skipped); --include/--glob name what it reads, so that value is judged as a glob.
const PATTERN_OPTION = /^--(exclude|ignore|include|glob)(?:=([\s\S]*))?$/;
const READS_ONLY = /^(?:include|glob)$/;

const REASON = 'oikos secret guard: secrets stay out of the chat. The oikos tools read `.local/.env` themselves; ' +
  '`node oikos/tools/setup/cli.mjs status` shows which credentials are set (never their values), `node oikos/tools/setup/cli.mjs token` (run by the user) changes one.';

export function run(payload) {
  if (isFileTool(payload)) {
    // A closed store is closed to every file tool, reading, searching and editing alike (ADR 0002
    // D04). A search tool names a folder it scopes to; only it may name `.local/` as a whole —
    // opening the folder as a file is not what an edit means. Its globs are read too: a search
    // that does not name `.local/` as a scope may still reach it when the host's ignore rules are off.
    const scoped = isRead(payload);
    for (const path of fileTargets(payload)) {
      if (isEnvFile(path) || isLocalStore(path, payload.cwd) || (scoped && isLocalFolder(path, payload.cwd))) return decide(payload, 'deny', REASON);
    }
    if (globPatterns(payload).some(globNamesSecret)) return decide(payload, 'deny', REASON);
    return;
  }

  const command = shellCommand(payload);
  if (!command) return;
  // The folders a relative argument may be relative to: the session's, and each one a `cd`/`pushd`
  // earlier in the command may have led to — `cd .local/cv && grep -r x ..` searches `.local`
  // itself. Every one of them is asked, since a subshell or a failed `cd` leaves the folder as it
  // was; a target that cannot be read (`cd`, `cd -`, `cd ~`, `cd "$DIR"`) adds none.
  const dirs = [resolve(payload.cwd || process.cwd())];
  const reaches = (arg) => dirs.some((dir) => isLocalStore(arg, dir) || isLocalFolder(arg, dir));
  for (const { exe, args, viaEnv } of shellSegments(command)) {
    if (!exe && viaEnv) return decide(payload, 'deny', `${REASON} (\`env\` without a command prints the environment.)`);
    if (exe === 'printenv' || exe === 'set' || (['export', 'declare', 'typeset'].includes(exe) && args.includes('-p'))) {
      return decide(payload, 'deny', `${REASON} (\`${exe}\` prints the environment.)`);
    }
    if (['echo', 'printf', 'print'].includes(exe) && args.some((a) => SECRET_VAR.test(a))) {
      return decide(payload, 'deny', `${REASON} (It would print a secret variable.)`);
    }
    if (METADATA.has(exe)) continue;
    for (let i = 0; i < args.length; i++) {
      const option = args[i].match(PATTERN_OPTION);
      if (option) {
        const pattern = option[2] ?? args[++i];
        if (READS_ONLY.test(option[1]) && globNamesSecret(pattern)) return decide(payload, 'deny', REASON);
        continue;
      }
      const arg = args[i].replace(/^--[a-z-]+=/, '');
      if (isEnvFile(arg) || reaches(arg)) return decide(payload, 'deny', REASON);
    }
    if (exe === 'cd' || exe === 'pushd') {
      const target = args.filter((a) => !/^-[LPe@]*$/.test(a));
      if (target.length === 1 && !/[$~`*?[{]/.test(target[0]) && target[0] !== '-') {
        // From the last folder and from the session's (a subshell's `cd` is undone), not from every
        // folder seen, so a chain of `cd`s grows the list by two each, not twice over.
        for (const dir of [resolve(dirs.at(-1), target[0]), resolve(dirs[0], target[0])]) if (!dirs.includes(dir)) dirs.push(dir);
      }
    }
  }
}
