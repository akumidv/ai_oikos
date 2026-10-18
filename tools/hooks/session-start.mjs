#!/usr/bin/env node
// SessionStart hook: tells the agent what it cannot see for itself at the start — where it is
// (an installation, or the oikos core repository where oikos is developed), whether the
// installation is set up (pointing at BOOTSTRAP.md when not; the tokens sit in `.local/.env`,
// which the agent does not read), and the summary of the local catalog (skills/catalog).
// Local checks only, no network; silent when there is nothing to say.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { lookup, localEnvFile } from '../common/env.mjs';
import { CORE_ROOT, INSTALL_FILE, installRoot, installProblem } from '../common/paths.mjs';
import { catalogFile, loadCatalog, summaryLines } from '../catalog/cli.mjs';
import { neededKeys } from '../setup/tokens.mjs';
import { print } from './common.mjs';

export function run() {
  const root = installRoot();
  if (!root) {
    print({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `This session is in the oikos core repository (${realpathSync(CORE_ROOT)}), not in an installation: `
          + 'it is where oikos is developed — DEVELOPMENT.md applies, and oikos\'s own files may be changed here. '
          + `The tools work for an installation: run them from one, or with OIKOS_HOME set to it (${installProblem()}).`,
      },
    });
    return;
  }

  const missing = [];
  for (const file of ['AGENTS.md', INSTALL_FILE, join('.local', 'AGENTS.md')]) if (!existsSync(join(root, file))) missing.push(file);
  // Only the listed connectors' keys: nothing listed means no connector, so nothing to set.
  const keys = neededKeys();
  if (keys.length && !existsSync(localEnvFile()) && !keys.some((k) => lookup(k).source)) missing.push('.local/.env');
  for (const key of keys) if (!lookup(key).source) missing.push(key);

  const context = [`oikos installation: ${root}. \`oikos/\` is oikos itself and is read-only here; the tools run as `
    + '`node oikos/tools/<tool>/cli.mjs …` from this folder. A change to oikos is made in the core repository (DEVELOPMENT.md).'];
  let message;
  if (missing.length) {
    message = `oikos is not fully set up in this installation (missing: ${missing.join(', ')}). `
      + 'Follow oikos/BOOTSTRAP.md § Set up; `node oikos/tools/setup/cli.mjs status` shows what is left.';
    context.push(message);
  }
  const catalog = catalogFile();
  if (existsSync(catalog)) {
    try {
      context.push(summaryLines(loadCatalog(), 40).join('\n'));
    } catch (e) {
      context.push(`catalog: .local/catalog.yaml does not parse (${e.message}); \`node oikos/tools/catalog/cli.mjs check\``);
    }
  }
  print({
    ...(message ? { systemMessage: message } : {}),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n\n') },
  });
}
