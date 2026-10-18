#!/usr/bin/env node
// A shared Chrome window for the user and the agent. The user signs in (SSO, MFA) by hand; the
// agent drives the same window through the Chrome DevTools protocol, via the `chrome-devtools`
// MCP server in .mcp.json. This tool only starts that Chrome and reports on it.
//
// Chrome refuses remote debugging on the default profile, so oikos uses its own profile, kept in
// the installation's git-ignored folder: .local/browser/chrome-profile — one browser per installation. Sign-ins, cookies and settings
// survive between launches. Chrome is the system's, or Chrome for Testing that `install` puts
// into the project after the user agreed (common/programs.mjs has the lookup order). Under WSL
// the Windows Chrome is found too; it gets the profile through its \\wsl.localhost path. OIKOS_CHROME_PROFILE
// and OIKOS_CHROME_PATH override. The DevTools port is the installation's (OIKOS_CHROME_PORT, else
// one derived from its folder), and a Chrome answering there is used only when its process runs
// with this installation's profile — never just because the port answers. The installation's code
// is its folder name; a Chrome oikos started carries it in its profile path
// (`<code>/.local/browser/chrome-profile`), so a Chrome on the port is told as this installation's,
// another installation's (named), or one oikos did not start. The MCP server (mcp.mjs) runs the
// same check (checkPort) before it attaches.
//
// Chrome ignores HTTP(S)_PROXY and uses only the system proxy, but the agent works in the
// environment it was started in (often a proxy that is the only route into the organization's internal hosts). So
// `start` hands Chrome the agent's proxy: --proxy-server from HTTPS_PROXY/HTTP_PROXY/ALL_PROXY
// and --proxy-bypass-list from NO_PROXY. OIKOS_CHROME_PROXY overrides it; `system` leaves Chrome
// on the system proxy, `direct` turns proxying off. What was used is kept in
// .local/browser/launch.json and shown by `status`.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { basename, join, relative } from 'node:path';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { envValue, CORE_ROOT, isWsl, environment } from '../common/env.mjs';
import { installPath, installRoot, localPath, realOf } from '../common/paths.mjs';
import { PROJECT_PROGRAMS, findProgram, installed, missingLibraries, progress, windowsSide,
  toolDependenciesInstalled, installToolDependencies } from '../common/programs.mjs';

/**
 * The port an installation's browser uses when `OIKOS_CHROME_PORT` is not set: one derived from
 * its folder, so two installations on a machine do not meet on Chrome's usual 9222.
 */
export function defaultPort(dir) {
  return 9300 + (createHash('sha1').update(realOf(dir)).digest().readUInt16BE(0) % 600);
}

/** This installation's DevTools port: OIKOS_CHROME_PORT (oikos.yaml settings), else defaultPort(). */
export const browserPort = () => Number(envValue('OIKOS_CHROME_PORT') || defaultPort(installPath()));
const port = (v) => Number(v.port || browserPort());

/** This installation's code — its folder name — which its browser is told by. */
export const installationCode = () => basename(installPath());

const CHROME_DIR = join(PROJECT_PROGRAMS, 'chrome'); // @puppeteer/browsers: <cacheDir>/chrome/<platform>-<build>/
const TESTING_APP = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

export function findChrome() {
  return findProgram({
    env: 'OIKOS_CHROME_PATH',
    names: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    system: {
      linux: ['/opt/google/chrome/chrome'],
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      win32: [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')],
    },
    windows: ['chrome.exe'],
    project: () => installed(CHROME_DIR).flatMap((d) => ['chrome-linux64/chrome', `chrome-mac-arm64/${TESTING_APP}`,
      `chrome-mac-x64/${TESTING_APP}`, 'chrome-win64/chrome.exe'].map((p) => join(d, p))),
  });
}

export function chromePath() {
  const found = findChrome();
  if (found) return found.path;
  throw new UsageError('Chrome not found. Install it with the system, or Chrome for Testing into this project: node oikos/tools/browser/cli.mjs install');
}

// Cookies are encrypted per Chrome build: the user's own Chrome and a project install keep
// separate profiles, so switching between them does not leave a profile neither can read.
export const profileBase = () => localPath('browser', 'chrome-profile');
const profileFor = () => (findChrome()?.source === 'project' ? `${profileBase()}-project` : profileBase());

/** The profile folder as the Chrome process sees it (a Windows path for a Windows Chrome under WSL). */
function profileDir() {
  const set = envValue('OIKOS_CHROME_PROFILE');
  const dir = set || profileFor();
  if (!set) mkdirSync(dir, { recursive: true });
  if (windowsSide(chromePath()) && dir.startsWith('/')) {
    return execFileSync('wslpath', ['-w', dir], { encoding: 'utf8' }).trim();
  }
  return dir;
}

/** profileDir() for telling whose a Chrome is: null when no Chrome is found here to say which profile. */
function ownProfile() {
  try {
    return profileDir();
  } catch {
    return null;
  }
}

/** Under WSL a Windows Chrome's loopback port is probed from the Windows side. */
function probeViaWindows(url) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Invoke-WebRequest '${url}' -UseBasicParsing -TimeoutSec 2).Content`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function devtools(p, path = '/json/version') {
  const url = `http://127.0.0.1:${p}${path}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return await r.json();
  } catch { /* not on this side */ }
  return isWsl() ? probeViaWindows(url) : null;
}

const launchFile = () => localPath('browser', 'launch.json');

/** The proxy arguments for Chrome from the agent's environment, and a line describing them. */
export function proxyArgs() {
  const pick = (...names) => names.map((n) => process.env[n]).find(Boolean);
  const override = envValue('OIKOS_CHROME_PROXY');
  if (override === 'system') return { args: [], describe: 'system proxy (OIKOS_CHROME_PROXY=system)' };
  if (override === 'direct') return { args: ['--no-proxy-server'], describe: 'no proxy (OIKOS_CHROME_PROXY=direct)' };
  const server = override || pick('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!server) return { args: [], describe: 'system proxy (none in the environment)' };
  // NO_PROXY → Chrome bypass rules: `.domain` becomes `*.domain`; hosts, IPs and CIDRs pass as is.
  const bypass = (pick('NO_PROXY', 'no_proxy') || '').split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => (x.startsWith('.') ? `*${x}` : x));
  const args = [`--proxy-server=${server}`];
  if (bypass.length) args.push(`--proxy-bypass-list=${bypass.join(';')}`);
  return { args, describe: `${server}${bypass.length ? ` (bypass: ${bypass.length} rule(s) from NO_PROXY)` : ''}` };
}

function readLaunch() {
  try { return JSON.parse(readFileSync(launchFile(), 'utf8')); } catch { return null; }
}

/**
 * The command lines of the Chrome processes listening for DevTools on port `p`, wherever they run:
 * /proc on Linux, `ps` on macOS, the process table through PowerShell on Windows and, under WSL,
 * on its Windows side too.
 */
function chromeCommandLines(p) {
  const flag = `--remote-debugging-port=${p}`;
  const lines = [];
  if (platform() === 'linux') {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (args.includes(flag)) lines.push(args.join(' '));
      } catch { /* gone, or not ours to read */ }
    }
  } else if (platform() === 'darwin') {
    try {
      lines.push(...execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(flag)));
    } catch { /* no ps */ }
  }
  if (platform() === 'win32' || isWsl()) {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${flag}*' } | ForEach-Object { $_.CommandLine }`;
    try {
      lines.push(...execFileSync(isWsl() ? 'powershell.exe' : 'powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, cwd: isWsl() ? '/mnt/c' : undefined }).split(/\r?\n/).filter(Boolean));
    } catch { /* no PowerShell */ }
  }
  return lines;
}

/** The `--user-data-dir` of a Chrome command line, quotes and case of a Windows path aside. */
const userDataDir = (line) => line.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean) || null;
const samePath = (a, b) => {
  const norm = (x) => String(x).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return /^[a-z]:|^\/\/|^\\\\/i.test(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * The installation an oikos profile belongs to — `<code>/.local/browser/chrome-profile[-project]`,
 * as a Linux, macOS or Windows (`\\wsl.localhost\…`) path — or null for any other profile.
 */
export const profileInstallation = (dir) => String(dir || '')
  .match(/([^\\/]+)[\\/]\.local[\\/]browser[\\/]chrome-profile(?:-project)?[\\/]*$/)?.[1] || null;

/**
 * Whose Chrome the processes in `commandLines` (those listening on the DevTools port) are, for the
 * installation at `root`. `profile` is the profile this installation gives its Chrome now, `launch`
 * the content of its `.local/browser/launch.json` (the profile of its last `start`). Returns
 * { owner: 'ours', installation } when a process runs with one of this installation's profiles;
 * { owner: 'foreign', installation, profile } otherwise — `installation` the code of the oikos
 * installation whose profile it is, null for a Chrome oikos did not start; { owner: 'unknown' }
 * when there is no process to tell by. A DevTools answer alone says nothing about whose browser it
 * is, and driving another installation's signed-in window is the one thing this tool must not do.
 */
export function chromeOwnership(commandLines, { root = null, launch = null, profile = null } = {}) {
  const dirs = commandLines.map(userDataDir);
  if (!dirs.length) return { owner: 'unknown' };
  const own = [profile, launch?.profile].filter(Boolean);
  if (root) own.push(join(root, '.local', 'browser', 'chrome-profile'), join(root, '.local', 'browser', 'chrome-profile-project'));
  if (dirs.some((d) => d && own.some((o) => samePath(d, o)))) return { owner: 'ours', installation: root ? basename(root) : null };
  const used = dirs.find(Boolean) || null;
  return { owner: 'foreign', installation: profileInstallation(used), profile: used };
}

/** Whose Chrome answers on port `p` (chromeOwnership), read from the running processes. */
export function ownerOf(p, profile = ownProfile()) {
  return chromeOwnership(chromeCommandLines(p), { root: installRoot(), launch: readLaunch(), profile });
}

/** Who a Chrome that is not this installation's is, in words. */
function whose(owner) {
  if (owner.owner === 'unknown') return 'a Chrome whose process was not found, so whose it is cannot be told';
  const profile = owner.profile ? `profile ${owner.profile}` : 'its default profile';
  return owner.installation ? `the Chrome of installation ${owner.installation} (${profile})` : `a Chrome not started by oikos (${profile})`;
}

/** Why a Chrome on `port` that is not installation `code`'s is not driven, and how to fix it. */
export const notOursMessage = (owner, { port, code }) => `the Chrome on 127.0.0.1:${port} is ${whose(owner)}, `
  + `not installation ${code}'s. oikos does not drive it: close that Chrome, or set OIKOS_CHROME_PORT in the settings of oikos.yaml `
  + `to a free port; then start this installation's: node oikos/tools/browser/cli.mjs start`;

/**
 * The Chrome answering on port `p`, checked — the one check `start`, `status`, `stop` and the MCP
 * server make: null when nothing answers; else { version, owner, refusal }, `refusal` null for this
 * installation's Chrome and the reason not to drive it otherwise. `probe` and `owner` are for tests.
 */
export async function checkPort(p, { probe = devtools, owner = ownerOf, code = installationCode() } = {}) {
  const version = await probe(p);
  if (!version) return null;
  const o = owner(p);
  return { version, owner: o, refusal: o.owner === 'ours' ? null : notOursMessage(o, { port: p, code }) };
}

/** Stop the oikos Chrome (the one using our profile), wherever it runs. */
async function stopChrome(p, profile) {
  if (platform() === 'win32' || windowsSide(readLaunch()?.exe)) {
    const needle = profile.replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFileSync(isWsl() ? 'powershell.exe' : 'powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 30000 });
    return;
  }
  const version = await devtools(p);
  if (!version?.webSocketDebuggerUrl) return;
  await new Promise((resolve) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    ws.onclose = resolve;
    ws.onerror = resolve;
    setTimeout(resolve, 5000);
  });
}

const commands = {
  status: {
    help: 'is the shared Chrome running and reachable; its open tabs (--port)',
    options: { port: { type: 'string' } },
    async run(v) {
      const p = port(v);
      const code = installationCode();
      const found = await checkPort(p);
      if (!found) {
        console.log(`no Chrome DevTools on 127.0.0.1:${p} (installation ${code}). Start it: node oikos/tools/browser/cli.mjs start`);
        return 1;
      }
      if (found.refusal) {
        console.log(`not this installation's browser: ${found.refusal}`);
        return 1;
      }
      const { version } = found;
      const tabs = ((await devtools(p, '/json/list')) || []).filter((t) => t.type === 'page');
      if (v.json) return printJson({ installation: code, version, tabs });
      console.log(`Chrome ${version.Browser} of installation ${code} on 127.0.0.1:${p} — ${tabs.length} tab(s)`);
      const launch = readLaunch();
      const now = proxyArgs().describe;
      if (launch) {
        console.log(`  proxy: ${launch.proxy} (started ${launch.started.slice(0, 16).replace('T', ' ')})`);
        if (launch.proxy !== now) console.log(`  NOTE: the environment now says "${now}" — run \`restart\` to apply it.`);
      } else console.log('  proxy: unknown — this Chrome was not started by oikos; run `restart` to use the agent\'s proxy.');
      for (const t of tabs) console.log(`  ${t.title.slice(0, 60).padEnd(60)} ${t.url}`);
      console.log('The agent drives it through the chrome-devtools MCP server (/mcp shows it).');
    },
  },

  stop: {
    help: 'close the oikos Chrome (sign-ins stay in the profile)',
    options: { port: { type: 'string' } },
    async run(v) {
      const p = port(v);
      const code = installationCode();
      const found = await checkPort(p);
      if (!found) { console.log(`no Chrome of installation ${code} is running on 127.0.0.1:${p}`); return 0; }
      if (found.refusal) { console.log(`left running: ${found.refusal}`); return 1; }
      await stopChrome(p, profileDir());
      for (let i = 0; i < 10 && (await devtools(p)); i++) await new Promise((r) => setTimeout(r, 500));
      console.log((await devtools(p)) ? `the Chrome of installation ${code} still answers — close it by hand` : `stopped the Chrome of installation ${code}`);
    },
  },

  restart: {
    help: 'stop and start again — to apply a changed proxy or port (--url to open)',
    options: { port: { type: 'string' }, url: { type: 'string' } },
    async run(v) {
      await commands.stop.run(v);
      return commands.start.run(v);
    },
  },

  start: {
    help: 'start Chrome with the oikos profile and a DevTools port (--port, --url to open)',
    options: { port: { type: 'string' }, url: { type: 'string' } },
    async run(v) {
      const p = port(v);
      const code = installationCode();
      const found = await checkPort(p);
      if (found?.refusal) throw new UsageError(found.refusal);
      if (found) {
        const launch = readLaunch();
        console.log(`The Chrome of installation ${code} is already listening on 127.0.0.1:${p} (proxy: ${launch?.proxy || 'unknown'}). Use \`restart\` to relaunch it with the current environment.`);
        return 0;
      }
      const exe = chromePath();
      const profile = profileDir();
      const proxy = proxyArgs();
      const args = [`--remote-debugging-port=${p}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...proxy.args];
      // Linux without a graphical session: nobody could see the window, so Chrome runs headless.
      const headless = !environment().display && !windowsSide(exe);
      if (headless) args.push('--headless=new');
      if (v.url) args.push(v.url);
      spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
      writeFileSync(launchFile(), `${JSON.stringify({ started: new Date().toISOString(), exe, profile, port: p, proxy: proxy.describe, args }, null, 2)}\n`);
      console.log(`Started the Chrome of installation ${code}: ${exe}\n  profile: ${profile}\n  DevTools port: ${p}\n  proxy: ${proxy.describe}`);
      if (headless) console.log('  headless: no graphical session — the user does not see this Chrome; describe the page to them, and a sign-in only the user can do (SSO, MFA) is not possible here');
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await devtools(p)) {
          console.log('Reachable. Sign in to what you need in that window; then ask the agent to work in it.');
          return 0;
        }
      }
      console.log(`Chrome started but 127.0.0.1:${p} does not answer.`);
      return 1;
    },
  },
};

commands.install = {
  help: 'Chrome for Testing for the shared browser only when no Chrome is installed: a plan by default, --yes downloads it into the project',
  options: { yes: { type: 'boolean' } },
  async run(v) {
    const found = findChrome();
    if (found) {
      console.log(`Chrome is available (${found.source}): ${found.path}`);
      return 0;
    }
    // @puppeteer/browsers is this tool's own dependency (tools/browser/package.json): only a
    // machine without Chrome needs it, so the root `npm install` does not bring it.
    if (!toolDependenciesInstalled('browser')) {
      console.log('Chrome for Testing (~200 MB) into the project; first the downloader @puppeteer/browsers (~1 MB) into tools/browser/node_modules');
      if (!v.yes) {
        console.log('plan only; run again with --yes to install both');
        return 0;
      }
      installToolDependencies('browser');
    }
    const b = await import('@puppeteer/browsers');
    const plat = b.detectBrowserPlatform();
    if (!plat) throw new UsageError(`no Chrome for Testing build for ${platform()} ${arch()}; install Chrome with the system`);
    const buildId = await b.resolveBuildId(b.Browser.CHROME, plat, 'stable');
    console.log(`Chrome for Testing ${buildId} (${plat}, ~200 MB) into ${relative(CORE_ROOT, CHROME_DIR)} — nothing is installed system-wide`);
    if (!v.yes) {
      console.log('plan only; run again with --yes to download it');
      return 0;
    }
    const r = await b.install({ browser: b.Browser.CHROME, buildId, cacheDir: PROJECT_PROGRAMS, downloadProgressCallback: progress('Chrome') });
    const missing = missingLibraries(r.executablePath);
    if (missing.length) {
      const deps = join(r.path, 'chrome-linux64', 'deb.deps');
      console.log(`installed ${r.executablePath}, but these system libraries are missing: ${missing.join(', ')}\n`
        + `the user installs them (oikos does not use sudo): sudo apt-get satisfy -y --no-install-recommends "$(paste -sd, '${deps}')"`);
      return 1;
    }
    console.log(`installed: ${r.executablePath}\nstart it: node oikos/tools/browser/cli.mjs start`);
  },
};

if (isMain(import.meta.url)) runCli('browser', commands);
