#!/usr/bin/env node
// Launcher for the chrome-devtools MCP server (.mcp.json), attached to the shared Chrome that
// `node oikos/tools/browser/cli.mjs start` opened. The server has to run on the same side as Chrome:
// with a Windows Chrome under WSL, a Windows process is
// the one that can reach its loopback DevTools port, so the server is started through cmd.exe;
// everywhere else it runs here.
// Needs Node.js (npx) on that side. stdio passes straight through.
import { spawn } from 'node:child_process';
import { chromePath, browserPort } from './cli.mjs';
import { windowsSide } from '../common/programs.mjs';

// The installation comes from OIKOS_HOME, which sync writes into .mcp.json next to this command.
const port = browserPort();
// A pinned version from npx's cache: `@latest` asks the registry on every start, which through
// cmd.exe and a proxy took over a minute, past the host's 30 s MCP start timeout. Raise it here.
const PACKAGE = 'chrome-devtools-mcp@1.10.1';
const server = ['--prefer-offline', '-y', PACKAGE, `--browser-url=http://127.0.0.1:${port}`, '--no-usage-statistics'];

let windowsChrome = false;
try {
  windowsChrome = windowsSide(chromePath());
} catch { /* no Chrome found: start the server here and let it report */ }

const [cmd, args] = windowsChrome ? ['cmd.exe', ['/c', 'npx', ...server]] : ['npx', server];
const child = spawn(cmd, args, { stdio: 'inherit', cwd: windowsChrome ? '/mnt/c' : undefined });
child.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
