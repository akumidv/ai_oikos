#!/usr/bin/env node
// PreToolUse: keeps secrets out of the agent's context (OIKOS.md: never print a secret).
//
// - A file tool (read, search, write) on a `.env` file (`.env`, `.env.*` except
//   `.example|.sample|.template`), on a file of `.local/google/` (the Google OAuth client and
//   token), a search scoped to `.local/` or a folder below it, or a search glob that names
//   `.local/` or such a `.env*` file: deny.
//   The tools read `.local/.env` themselves; `setup status` shows what is set, and `google whoami`
//   the Google sign-in.
// - A shell command that names such a file, `.local/` or a folder below it as an argument (cat,
//   grep, cp, source…) is denied, except metadata-only commands (ls, stat, chmod, test). An
//   `--include`/`--glob` pattern is judged as the glob it is, an `--exclude`/`--ignore` one is
//   not: leaving a file out of a search is not reading it. Printing the environment (`env`,
//   `printenv`, `set`, `export -p`, `declare -p`) or echoing a secret-looking variable
//   (`$…TOKEN`, `$…SECRET`, `$…PASSWORD`, `$…API_KEY`) is denied too.
// Best effort against accidents, not a sandbox: `bash -c "…"` or a script file is not looked into.
import { shellSegments, decide } from './common.mjs';
import { isFileTool, fileTargets, globPatterns, globNamesSecret, shellCommand, isRead, isEnvFile, isGoogleSecret, isLocalFolder, isInsideLocal } from './host.mjs';

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
    // A search tool names a folder it scopes to; a file tool names the file it opens. Only the
    // first may be `.local/` or a folder below it — opening the folder as a file is not what it
    // means. Its globs are read too: a search that does not name `.local/` as a scope may still
    // reach it when the host's ignore rules are off.
    const scoped = isRead(payload);
    for (const path of fileTargets(payload)) {
      if (isEnvFile(path) || isGoogleSecret(path) || (scoped && (isLocalFolder(path) || isInsideLocal(path, payload.cwd)))) return decide(payload, 'deny', REASON);
    }
    if (scoped && globPatterns(payload).some(globNamesSecret)) return decide(payload, 'deny', REASON);
    return;
  }

  const command = shellCommand(payload);
  if (!command) return;
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
      if (isEnvFile(arg) || isGoogleSecret(arg) || isLocalFolder(arg) || isInsideLocal(arg, payload.cwd)) return decide(payload, 'deny', REASON);
    }
  }
}
