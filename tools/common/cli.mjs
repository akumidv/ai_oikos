// Tiny command dispatcher on top of util.parseArgs: `<tool> <command> [--flags]`.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError, ChannelError } from './http.mjs';

/**
 * commands: { name: { help, options, run(values, positionals) } }
 * options use util.parseArgs syntax; `--json` and `--help` are added to every command.
 */
export async function runCli(toolName, commands) {
  // Node's fetch honours HTTP(S)_PROXY only when NODE_USE_ENV_PROXY=1 is set at startup; without
  // it a proxied machine lands on the Cloudflare Access login page. Re-run once with it set.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy && process.env.NODE_USE_ENV_PROXY !== '1') {
    const r = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    });
    return process.exit(r.status ?? 1);
  }
  const [name, ...rest] = process.argv.slice(2);
  const usage = () => {
    console.log(`usage: node oikos/tools/${toolName}/cli.mjs <command> [options]   (from the installation's root)\n`);
    for (const [n, c] of Object.entries(commands)) console.log(`  ${n.padEnd(12)} ${c.help}`);
  };
  if (!name || name === '--help' || name === '-h') {
    usage();
    return process.exit(name ? 0 : 1);
  }
  const cmd = commands[name];
  if (!cmd) {
    console.error(`unknown command: ${name}\n`);
    usage();
    return process.exit(1);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { ...cmd.options, json: { type: 'boolean' }, help: { type: 'boolean' } },
    });
  } catch (e) {
    console.error(e.message);
    return process.exit(1);
  }
  if (parsed.values.help) {
    console.log(`${name}: ${cmd.help}\noptions:`);
    for (const [o, spec] of Object.entries(cmd.options || {})) console.log(`  --${o}${spec.type === 'string' ? ' <value>' : ''}`);
    return process.exit(0);
  }
  try {
    const code = await cmd.run(parsed.values, parsed.positionals);
    process.exit(code ?? 0);
  } catch (e) {
    // NoInstallation (common/paths.mjs): run outside any installation — a usage error too.
    const usage = e instanceof UsageError || e?.name === 'NoInstallation';
    if (usage || e instanceof HttpError || e instanceof ChannelError) {
      console.error(`${toolName}: ${e.message}`);
      process.exit(usage ? 1 : 2);
    }
    throw e;
  }
}

export class UsageError extends Error {}

/**
 * Whether the module at `url` is the program being run, not an import. Node resolves symlinks in
 * `import.meta.url` but not in `process.argv[1]`, so run as `oikos/tools/<tool>/cli.mjs` through an
 * installation's link the two differ — they are compared as real paths.
 */
export function isMain(url) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(url);
  } catch {
    return false;
  }
}

export function required(values, ...names) {
  for (const n of names) if (!values[n]) throw new UsageError(`--${n} is required`);
}

export const printJson = (data) => console.log(JSON.stringify(data, null, 2));

/** Non-Latin letters in text (Cyrillic etc.) — Jira and Confluence content is English. */
export function nonLatinLetters(text) {
  const found = new Set();
  for (const ch of text) if (/\p{L}/u.test(ch) && ch.codePointAt(0) > 0x024f) found.add(ch);
  return [...found].sort().join('');
}
