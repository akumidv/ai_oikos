// Tiny command dispatcher on top of util.parseArgs: `<tool> <command> [--flags]`.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError, ChannelError } from './http.mjs';
import { INSTALL_FILE, installPath, installRoot } from './paths.mjs';
import { config, listedConnectors } from './config.mjs';

/**
 * commands: { name: { help, options, run(values, positionals) } }
 * options use util.parseArgs syntax; `--json` and `--help` are added to every command.
 * `connector` names the connector a tool is (jira, gitlab, …): its commands run only in an
 * installation that lists it (requireConnector); usage and `--help` print without the check.
 */
export async function runCli(toolName, commands, { connector } = {}) {
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
    if (connector) requireConnector(connector);
    const code = await cmd.run(parsed.values, parsed.positionals);
    // A dry run that would be refused (a flagged content check, common/outgoing.mjs) prints its
    // whole preview and sets process.exitCode; a command's own non-zero code wins.
    process.exit(code || process.exitCode || 0);
  } catch (e) {
    if (e instanceof GuardRefusal) {
      console.error(e.message);
      process.exit(3);
    }
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
 * A guard's refusal: runCli prints the message on stderr as it is — it carries its own prefix
 * (`refused: content check: …`) — and exits 3, the one "refused by a guard" code.
 */
export class GuardRefusal extends Error {}

/**
 * Stop a connector tool before any credential lookup or request unless the installation uses it:
 * `name` listed under some skill in `connectors:` of its `oikos.yaml`. A token exported in the
 * shell reaches every installation on the machine; this keeps it out of those that do not use the
 * connector. Outside any installation it is the no-installation error of paths.mjs.
 */
export function requireConnector(name) {
  if (!installRoot()) installPath();
  if (listedConnectors().has(name)) return;
  const { problems } = config();
  throw new UsageError(`${name} is not a connector of this installation — add it under connectors: in ${INSTALL_FILE} `
    + `(node oikos/tools/landscape/cli.mjs skills lists them)${problems.length ? `; ${problems.join('; ')}` : ''}`);
}

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
