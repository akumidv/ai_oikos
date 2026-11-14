// Whether this installation's Chrome runs — what `oikos sync` asks before it moves the browser's
// store in `.local/` (common/local-stores.mjs), since a running Chrome writes into its profile. The
// browser itself is akmon's (ADR 0009, akmon.mjs); this is the one check oikos keeps, read from the
// DevTools port and the process table, so it works whichever version of oikos or akmon started the
// Chrome. Whose a Chrome is — this installation's, another one's, or none oikos or akmon started — is
// told by the `--user-data-dir` of its process, never by a port that merely answers.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, join } from 'node:path';
import { envValue, isWsl } from '../common/env.mjs';
import { installPath, installRoot, LOCAL_STORES } from '../common/paths.mjs';
import { windowsSide } from '../common/programs.mjs';
import { browserPort } from './akmon.mjs';

/** The profile folders of the browser store: the system Chrome's, the Chrome for Testing's, and the name before akmon. */
export const PROFILE_NAMES = Object.freeze(['chrome-profile', 'chrome-profile-cft', 'chrome-profile-project']);

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

/** What a Chrome on DevTools port `p` answers to `/json/version`, or null when nothing answers. */
async function devtools(p) {
  const url = `http://127.0.0.1:${p}/json/version`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return await r.json();
  } catch { /* not on this side */ }
  return isWsl() ? probeViaWindows(url) : null;
}

/** The content of the launch.json at each place of the browser store that has one. */
function storeLaunches() {
  const { parts, legacy } = LOCAL_STORES.browser;
  return [parts, legacy].flatMap((at) => {
    try { return [JSON.parse(readFileSync(installPath('.local', ...at, 'launch.json'), 'utf8'))]; } catch { return []; }
  });
}

/**
 * The command lines of the processes `keep(line, args)` accepts — `args` the exact arguments where
 * the platform gives them (/proc), else null — on this side (/proc, `ps`) and, with `like` (a
 * PowerShell `-like` fragment) on Windows or under WSL, of `chrome.exe` on the Windows side.
 * `complete` is false when a process table could not be read.
 */
function processCommandLines(keep, { like = null, windows = platform() === 'win32' || isWsl() } = {}) {
  const lines = [];
  let complete = true;
  if (platform() === 'linux') {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (keep(args.join(' '), args)) lines.push(args.join(' '));
      } catch { /* gone, or not ours to read */ }
    }
  } else if (platform() === 'darwin') {
    try {
      lines.push(...execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' }).split('\n').filter((l) => keep(l, null)));
    } catch { complete = false; }
  }
  if (like && windows) {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${like.replace(/'/g, "''")}*' } | ForEach-Object { $_.CommandLine }`;
    try {
      lines.push(...execFileSync(isWsl() ? 'powershell.exe' : 'powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, cwd: isWsl() ? '/mnt/c' : undefined }).split(/\r?\n/).filter((l) => l && keep(l, null)));
    } catch { complete = false; }
  }
  return { lines, complete };
}

/** The command lines of the Chrome processes listening for DevTools on port `p`, wherever they run. */
function chromeCommandLines(p) {
  const flag = `--remote-debugging-port=${p}`;
  return processCommandLines((line, args) => (args ? args.includes(flag) : line.includes(flag)), { like: flag }).lines;
}

/** The `--user-data-dir` of a Chrome command line, quotes and case of a Windows path aside. */
const userDataDir = (line) => line.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/)?.slice(1).find(Boolean) || null;
const samePath = (a, b) => {
  const norm = (x) => String(x).replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return /^[a-z]:|^\/\/|^\\\\/i.test(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * The installation a browser profile belongs to — `<code>/.local/.browser/chrome-profile[-cft]`, the
 * `-project` name before akmon, or the legacy `<code>/.local/browser/…`, as a Linux, macOS or Windows
 * (`\\wsl.localhost\…`) path — or null for any other profile.
 */
export const profileInstallation = (dir) => String(dir || '')
  .match(/([^\\/]+)[\\/]\.local[\\/]\.?browser[\\/]chrome-profile(?:-project|-cft)?[\\/]*$/)?.[1] || null;

/**
 * Whose Chrome the processes in `commandLines` (those listening on the DevTools port) are, for the
 * installation at `root`. `profile` is the profile set for this installation (OIKOS_CHROME_PROFILE),
 * `launch` the content of its `.local/.browser/launch.json` (the profile of its last `start`). Returns
 * { owner: 'ours', installation } when a process runs with one of this installation's profiles;
 * { owner: 'foreign', installation, profile } otherwise — `installation` the code of the installation
 * whose profile it is, null for a Chrome that was not started for one; { owner: 'unknown' } when there
 * is no process to tell by.
 */
export function chromeOwnership(commandLines, { root = null, launch = null, profile = null } = {}) {
  const dirs = commandLines.map(userDataDir);
  if (!dirs.length) return { owner: 'unknown' };
  const own = [profile, launch?.profile].filter(Boolean);
  // Both places of the store: a Chrome started before sync moved the profile runs from the old one.
  const { parts, legacy } = LOCAL_STORES.browser;
  if (root) for (const at of [parts, legacy]) own.push(...PROFILE_NAMES.map((name) => join(root, '.local', ...at, name)));
  if (dirs.some((d) => d && own.some((o) => samePath(d, o)))) return { owner: 'ours', installation: root ? basename(root) : null };
  const used = dirs.find(Boolean) || null;
  return { owner: 'foreign', installation: profileInstallation(used), profile: used };
}

/** Whose Chrome answers on port `p` (chromeOwnership), read from the running processes. */
export function ownerOf(p, profile = envValue('OIKOS_CHROME_PROFILE') || null) {
  return chromeOwnership(chromeCommandLines(p), { root: installRoot(), launch: storeLaunches()[0] ?? null, profile });
}

/**
 * The Chrome answering on port `p`, checked: null when nothing answers; else { version, owner } with
 * the ownership of the process. `probe` and `owner` are for tests.
 */
export async function checkPort(p, { probe = devtools, owner = ownerOf } = {}) {
  const version = await probe(p);
  return version ? { version, owner: owner(p) } : null;
}

/**
 * Whether a process runs with one of `profiles` as its `--user-data-dir` — on the Windows side
 * too with `windows` — or the process table could not be read, which counts as running.
 */
function profileProcesses(profiles, { windows = false } = {}) {
  const ours = (line) => {
    const dir = userDataDir(line);
    return Boolean(dir) && profiles.some((profile) => samePath(dir, profile));
  };
  const { lines, complete } = processCommandLines(ours, { like: 'chrome-profile', windows });
  return lines.length > 0 || !complete;
}

/**
 * Whether this installation's Chrome may be running: true when a Chrome answers on its port, or on the
 * port a launch.json of either place of the store recorded, and is not told as another's (a Chrome
 * whose process was not found included); or when a process runs with one of the installation's profiles,
 * at either place or as launch.json recorded it, as its `--user-data-dir`; or when a process table that
 * had to be read could not be. `root` defaults to the installation, `port` to browserPort(), `launches`
 * to the launch.json files there are; `check` and `profileInUse` are for tests.
 */
export async function chromeRunning({ root = installPath(), port: p, launches = storeLaunches(), check = checkPort, profileInUse = profileProcesses } = {}) {
  const ports = new Set([p ?? browserPort(), ...launches.map((l) => Number(l.port)).filter(Boolean)]);
  for (const q of ports) {
    const found = await check(q);
    if (found && found.owner.owner !== 'foreign') return true;
  }
  const { parts, legacy } = LOCAL_STORES.browser;
  const profiles = [...[parts, legacy].flatMap((at) => PROFILE_NAMES.map((name) => join(root, '.local', ...at, name))),
    ...launches.map((l) => l.profile).filter(Boolean)];
  return profileInUse(profiles, { windows: platform() === 'win32' || launches.some((l) => windowsSide(l.exe)) });
}
