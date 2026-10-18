// External programs the tools drive (LibreOffice, Chrome). Looked for in this order:
// 1. an explicit path (OIKOS_SOFFICE_PATH, OIKOS_CHROME_PATH — environment or the local env file);
// 2. what the user already has installed: PATH and the platform's usual places; under WSL also
//    the Windows side (registry App Paths), since that is where such programs usually are;
// 3. only then a copy that the tool's `install` put into the project, after the user agreed
//    (node_modules/.cache/oikos of the core checkout, git-ignored, removed with node_modules —
//    a program belongs to the machine, so every installation on it shares the copy).
// `windowsSide()` tells the tools when a path has to be translated for a Windows program.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { platform } from 'node:os';
import { CORE_ROOT, envValue, isWsl, environment } from './env.mjs';
import { UsageError } from './cli.mjs';

export const PROJECT_PROGRAMS = join(CORE_ROOT, 'node_modules', '.cache', 'oikos');

/** Candidate paths of `names` on PATH (under WSL without the Windows folders WSL appends). */
export function onPath(names) {
  const dirs = (process.env.PATH || '').split(delimiter).filter((d) => d && !(isWsl() && d.startsWith('/mnt/')));
  const exts = platform() === 'win32' ? ['.exe'] : [''];
  return dirs.flatMap((d) => names.flatMap((n) => exts.map((e) => join(d, n + e))));
}

/** Sub-folders of a project-install folder, sorted by name. */
export const installed = (dir) => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)).sort()
  : []);

/**
 * { path, source: '<ENV NAME>' | 'system' | 'project' } or null.
 * `system` maps a platform to its usual install paths; `project()` lists project-install
 * candidates, the preferred (newest) last.
 */
export function findProgram({ env, names = [], system = {}, windows = [], project = () => [] }) {
  const explicit = envValue(env);
  if (explicit) {
    if (!existsSync(explicit)) throw new UsageError(`${env}=${explicit} does not exist`);
    return { path: explicit, source: env };
  }
  const sys = [...onPath(names), ...(system[platform()] || [])].find((p) => existsSync(p));
  if (sys) return { path: sys, source: 'system' };
  // Windows keeps an install's location in the registry (App Paths): natively, and under WSL
  // for the Windows side, where such programs usually are.
  const where = environment();
  const win = where.os === 'windows' || where.wsl ? windows.map(windowsAppPath).find(Boolean) : null;
  if (win) return { path: win, source: where.wsl ? 'windows' : 'system' };
  const own = project().reverse().find((p) => existsSync(p));
  return own ? { path: own, source: 'project' } : null;
}

/** Where Windows says a program is installed (App Paths, machine then user); a WSL path under WSL. */
function windowsAppPath(exe) {
  const wsl = isWsl();
  for (const hive of ['HKLM', 'HKCU']) {
    const r = spawnSync(wsl ? 'reg.exe' : 'reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
      { encoding: 'utf8', cwd: wsl ? '/mnt/c' : undefined });
    const win = (r.stdout || '').match(/REG_(?:EXPAND_)?SZ\s+"?([^"\r\n]+?)"?\s*$/m)?.[1];
    if (!win) continue;
    const path = wsl ? spawnSync('wslpath', ['-u', win], { encoding: 'utf8' }).stdout?.trim() : win;
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** A Windows program started from WSL: its paths must be Windows paths. */
export const windowsSide = (path) => isWsl() && /\.exe$/i.test(path || '');

/** Shared libraries a Linux binary cannot load (from ldd): a clear message instead of a crash. */
export function missingLibraries(binary) {
  if (platform() !== 'linux') return [];
  const r = spawnSync('ldd', [binary], { encoding: 'utf8' });
  return [...(r.stdout || '').matchAll(/^\s*(\S+) => not found/gm)].map((m) => m[1]);
}

/** Whether a tool's own npm dependencies (tools/<tool>/package.json, DEVELOPMENT.md) are installed. */
export const toolDependenciesInstalled = (tool) => existsSync(join(CORE_ROOT, 'tools', tool, 'node_modules'));

/** Installs a tool's own npm dependencies into tools/<tool>/node_modules; npm's output goes to stderr. */
export function installToolDependencies(tool) {
  const r = spawnSync('npm', ['install', '--prefix', join(CORE_ROOT, 'tools', tool), '--no-audit', '--no-fund'],
    { stdio: ['ignore', 2, 2], shell: platform() === 'win32' });
  if (r.status !== 0) throw new UsageError(`npm install for tools/${tool} failed (exit ${r.status ?? r.error?.message})`);
}

/** A download-progress printer: a line every 10%, to stderr (stdout stays for results). */
export function progress(label) {
  let shown = -1;
  return (bytes, total) => {
    if (!total) return;
    const step = Math.floor((bytes / total) * 10);
    if (step > shown) {
      shown = step;
      process.stderr.write(`${label}: ${step * 10}% of ${Math.round(total / 1e6)} MB\n`);
    }
  };
}
