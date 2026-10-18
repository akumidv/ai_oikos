// Credentials and settings: the installation's own files win — its `.local/.env`, then the
// `settings` of its `oikos.yaml` (config.mjs) — and the real environment is only a fallback. One
// machine holds several installations and the shell profile is shared by all of them, so a token
// exported there would otherwise reach every organization. `.local/` is the installation's
// git-ignored folder (see OIKOS.md), so a personal token never lands in a shared file; the code
// carries no organization's sites. Values are never printed — only whether each one is present.
// Outside an installation (the core repository) only the environment is read.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT, installRoot } from './paths.mjs';
import { config, emailDomain } from './config.mjs';

export { CORE_ROOT };

/** The installation's `.local/.env`, or null outside an installation. */
export const localEnvFile = () => (installRoot() ? join(installRoot(), '.local', '.env') : null);

/** Linux under WSL: Windows programs (Chrome, LibreOffice) are reached through /mnt/c and interop. */
export const isWsl = () => platform() === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));

/**
 * The environment a tool runs in, to configure itself by: { os: 'windows'|'linux'|'macos',
 * wsl, display } — `display` is false on Linux without a graphical session (server, SSH), where
 * a window the user would look at does not exist. WSLg counts as a display.
 */
export function environment() {
  const os = { win32: 'windows', darwin: 'macos' }[platform()] || 'linux';
  const display = os !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return { os, wsl: isWsl(), display };
}

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

let cached;
function fileEnv() {
  if (cached === undefined) {
    const file = localEnvFile();
    cached = file && existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {};
  }
  return cached;
}

/**
 * The value of `name`, and where it came from: '.local/.env' | 'config' | 'env' | null — the
 * installation's files first, the shared environment last.
 */
export function lookup(name) {
  const f = fileEnv();
  if (f[name]) return { value: f[name], source: '.local/.env' };
  const s = config().settings[name];
  if (s !== undefined && s !== null && s !== '') return { value: String(s), source: 'config' };
  if (process.env[name]) return { value: process.env[name], source: 'env' };
  return { value: null, source: null };
}

export const envValue = (name) => lookup(name).value;

/**
 * `value` when it is an address of the organization (`organization.email_domain` in
 * `oikos.yaml`), else null; any address when no domain is configured.
 */
export function orgEmail(value) {
  const v = value?.trim();
  if (!v || !v.includes('@')) return null;
  const domain = emailDomain();
  return !domain || v.toLowerCase().endsWith(`@${domain}`) ? v : null;
}

/** "an @<domain> address" for messages, or "your work address" without a configured domain. */
export const orgEmailLabel = () => (emailDomain() ? `an @${emailDomain()} address` : 'your work address');

export function gitUserEmail() {
  try {
    return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** One line per credential: present / defaulted / missing, never the value itself. */
export function credentialsHelp(names, { extra = [] } = {}) {
  const rows = names.map((name) => {
    const { source } = lookup(name);
    const mark = source === null ? 'missing' : `set (${source})`;
    return `  ${name.padEnd(22)} ${mark}`;
  });
  return [
    'Credentials:',
    ...rows,
    ...extra,
    `Tokens go in the installation's .local/.env (git-ignored; \`node oikos/tools/setup/cli.mjs token\` writes one without echo), site settings in its oikos.yaml; a value from the shell environment is a fallback shared by every installation. Never paste a token into the chat.`,
  ].join('\n');
}
