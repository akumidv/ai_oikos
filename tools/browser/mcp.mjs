#!/usr/bin/env node
// Launcher for the chrome-devtools MCP server (.mcp.json), attached to the shared Chrome that
// `node oikos/tools/browser/cli.mjs start` opened. The server has to run on the same side as Chrome:
// with a Windows Chrome under WSL, a Windows process is
// the one that can reach its loopback DevTools port, so the server is started through cmd.exe;
// everywhere else it runs here.
// Needs Node.js (npx) on that side. stdio passes straight through.
//
// Before the server starts, the Chrome answering on the port is checked the way `start` checks it
// (checkPort in cli.mjs): another installation's Chrome — another organization's signed-in
// sessions — or a Chrome oikos did not start is refused, and the server never starts. The refusal
// goes to stderr and, as a JSON-RPC error, answers the host's `initialize`, so the host shows why
// the server is missing; then the process exits 1. With no Chrome on the port the server starts as
// before and reports it when a tool is used; the check runs again at the next start (/mcp
// reconnects).
import { spawn } from 'node:child_process';
import { chromePath, browserPort, checkPort } from './cli.mjs';
import { isMain } from '../common/cli.mjs';
import { windowsSide } from '../common/programs.mjs';

// A pinned version from npx's cache: `@latest` asks the registry on every start, which through
// cmd.exe and a proxy took over a minute, past the host's 30 s MCP start timeout. Raise it here.
const PACKAGE = 'chrome-devtools-mcp@1.10.1';

/** How long a refusal waits for the host's first request before it exits without answering it. */
const REFUSAL_WAIT_MS = 10000;

/** Start chrome-devtools-mcp attached to `port`, on the side where Chrome runs; stdio passes through. */
function startServer(port) {
  const server = ['--prefer-offline', '-y', PACKAGE, `--browser-url=http://127.0.0.1:${port}`, '--no-usage-statistics'];
  let windowsChrome = false;
  try {
    windowsChrome = windowsSide(chromePath());
  } catch { /* no Chrome found: start the server here and let it report */ }
  const [cmd, args] = windowsChrome ? ['cmd.exe', ['/c', 'npx', ...server]] : ['npx', server];
  const child = spawn(cmd, args, { stdio: 'inherit', cwd: windowsChrome ? '/mnt/c' : undefined });
  child.on('exit', (code) => process.exit(code ?? 1));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

/**
 * Refuse over stdio, before any tool is announced: `message` to stderr, then as the JSON-RPC error
 * answering the host's first request (`initialize`), then exit 1.
 */
function refuseOverStdio(message) {
  console.error(message);
  const done = () => process.exit(1);
  if (process.stdin.isTTY) return done();
  let received = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    received += chunk;
    const end = received.indexOf('\n');
    if (end < 0) return;
    let id = null;
    try {
      id = JSON.parse(received.slice(0, end)).id ?? null;
    } catch { /* not JSON-RPC: nothing to answer */ }
    if (id === null) return done();
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`, done);
  });
  process.stdin.on('end', done);
  setTimeout(done, REFUSAL_WAIT_MS);
}

/**
 * Serve the chrome-devtools MCP server for this installation's Chrome on `port`: start it unless
 * the Chrome answering there is not this installation's, then refuse. `check`, `start` and
 * `refuse` are for tests.
 */
export async function serve(port, { check = checkPort, start = startServer, refuse = refuseOverStdio } = {}) {
  const found = await check(port);
  if (found?.refusal) return refuse(`chrome-devtools MCP server not started: ${found.refusal}, and reconnect the server (/mcp) or restart the session`);
  return start(port);
}

if (isMain(import.meta.url)) {
  // The installation comes from OIKOS_HOME, which sync writes into .mcp.json next to this command.
  Promise.resolve().then(() => serve(browserPort())).catch((e) => {
    console.error(`chrome-devtools MCP server not started: ${e.message}`);
    process.exit(1);
  });
}
