// Google sign-in kept on the user's machine. The user's own OAuth client (type
// "Desktop app", created once in Google Cloud) is imported into the installation's
// .local/google/client.json; the
// sign-in runs in the user's browser against a loopback address with PKCE, and the refresh
// token lands in .local/google/token.json. Both files are mode 600, git-ignored with .local/,
// and the secret guard denies reading them in the chat. Nothing is enabled in the Claude cloud.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { UsageError } from '../common/cli.mjs';
import { orgEmail, orgEmailLabel, environment } from '../common/env.mjs';
import { localPath } from '../common/paths.mjs';
import { emailDomain } from '../common/config.mjs';
import { request, HttpError } from '../common/http.mjs';
import { onPath } from '../common/programs.mjs';

// The installation's sign-in folder; each throws outside an installation.
export const googleDir = () => localPath('google');
export const clientFile = () => join(googleDir(), 'client.json');
export const tokenFile = () => join(googleDir(), 'token.json');

// Read-only by default; a scope the token lacks is named by the command that needs it.
export const SCOPES = {
  mail: 'https://www.googleapis.com/auth/gmail.readonly',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
};
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SIGN_IN_WAIT_MS = 5 * 60_000;

export const CLIENT_HELP = `No Google OAuth client yet. Once per user, in https://console.cloud.google.com with the
corporate account: create a project (or use one the company gave you) → APIs & Services → enable
Gmail API, Google Drive API, Google Calendar API → OAuth consent screen: Internal → Credentials →
Create credentials → OAuth client ID → Desktop app → Download JSON. Then:
  node oikos/tools/google/cli.mjs client <downloaded.json>`;

function writeSecret(file, data) {
  mkdirSync(googleDir(), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Import a downloaded client JSON; returns what may be shown (never the secret). */
export function importClient(src, { replace = false } = {}) {
  if (existsSync(clientFile()) && !replace) throw new UsageError('a client is already imported; --yes replaces it');
  let data;
  try {
    data = readJson(src);
  } catch (e) {
    throw new UsageError(`not a client JSON: ${e.message}`);
  }
  const c = data.installed;
  if (!c) {
    throw new UsageError(data.web ? 'this is a "Web application" client; create one of type "Desktop app"' : 'not a Google OAuth client JSON (no "installed" section)');
  }
  if (!c.client_id || !c.client_secret) throw new UsageError('the client JSON has no client_id or client_secret');
  writeSecret(clientFile(), { installed: c });
  return { project: c.project_id || null, file: clientFile() };
}

export function loadClient() {
  if (!existsSync(clientFile())) throw new UsageError(CLIENT_HELP);
  return readJson(clientFile()).installed;
}

export const loadToken = () => (existsSync(tokenFile()) ? readJson(tokenFile()) : null);

/** What `whoami` shows: never a token value. */
export function status() {
  const token = loadToken();
  return {
    client: existsSync(clientFile()) ? { project: loadClient().project_id || null } : null,
    account: token?.account || null,
    scopes: token ? Object.entries(SCOPES).filter(([, s]) => token.scopes.includes(s)).map(([k]) => k) : [],
    signedIn: token?.created || null,
    files: googleDir(),
    mode: token ? (statSync(tokenFile()).mode & 0o777).toString(8) : null,
  };
}

const b64url = (buf) => buf.toString('base64url');

function openInBrowser(url) {
  const where = environment();
  const [cmd, args] = where.os === 'macos' ? ['open', [url]]
    : where.os === 'windows' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : where.wsl ? (onPath(['wslview']).some(existsSync) ? ['wslview', [url]] : ['explorer.exe', [url]])
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', cwd: where.wsl ? '/mnt/c' : undefined }).on('error', () => {}).unref();
  } catch {
    // the URL is printed anyway
  }
}

async function exchange(form) {
  try {
    const { data } = await request(TOKEN_URL, {
      tool: 'google',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    return data;
  } catch (e) {
    if (e instanceof HttpError && /invalid_client/.test(e.message)) {
      throw new UsageError('Google does not know this OAuth client (deleted, or the JSON is from another project): download it again and run `client <file> --yes`');
    }
    if (e instanceof HttpError && /invalid_grant/.test(e.message)) {
      throw new UsageError('the Google sign-in expired or was revoked: sign in again with `node oikos/tools/google/cli.mjs auth`');
    }
    throw e;
  }
}

/**
 * Sign in: prints the URL (and opens it unless `print`), waits for the loopback redirect — or
 * for the redirected address pasted into this terminal when the browser is on another machine.
 */
export async function signIn({ scopes, print = false, log = console.log }) {
  const client = loadClient();
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: ['openid', 'email', ...scopes].join(' '),
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
    ...(emailDomain() ? { hd: emailDomain() } : {}),
  })}`;
  log(`Sign in with ${orgEmailLabel()} in the browser:\n  ${url}`);
  if (!print) openInBrowser(url);
  const tty = process.stdin.isTTY;
  if (tty) log('If the browser is on another machine: paste the address it ended on (http://127.0.0.1:…) here.');

  let rl;
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UsageError('no sign-in within 5 minutes; run auth again')), SIGN_IN_WAIT_MS);
    const take = (query) => {
      const p = new URLSearchParams(query);
      if (p.get('error')) return reject(new UsageError(`Google refused the sign-in: ${p.get('error')}`));
      if (!p.get('code')) return false;
      if (p.get('state') !== state) return reject(new UsageError('the sign-in answer does not belong to this request (state mismatch)'));
      clearTimeout(timer);
      resolve(p.get('code'));
      return true;
    };
    server.on('request', (req, res) => {
      const query = new URL(req.url, redirect).search;
      const done = take(query);
      res.writeHead(done === false ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(done === false ? '' : '<p>oikos got the answer from Google. Close this tab and look at the terminal.</p>');
    });
    if (tty) {
      rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const q = line.trim().match(/\?.*$/)?.[0];
        if (q) take(q);
      });
    }
  }).finally(() => {
    server.close();
    rl?.close();
  });

  const t = await exchange({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  // The id token came straight from Google over TLS: its payload is read, not verified again.
  const claims = JSON.parse(Buffer.from(String(t.id_token).split('.')[1] || '', 'base64url').toString() || '{}');
  if (!orgEmail(claims.email || '')) {
    throw new UsageError(`signed in as ${claims.email || 'an unknown account'}, not ${orgEmailLabel()}; nothing was saved`);
  }
  if (!t.refresh_token) throw new UsageError('Google returned no refresh token; run auth again');
  const token = {
    account: claims.email,
    scopes: String(t.scope || '').split(' '),
    refresh_token: t.refresh_token,
    access_token: t.access_token,
    expires_at: Date.now() + (t.expires_in || 0) * 1000,
    created: new Date().toISOString(),
  };
  writeSecret(tokenFile(), token);
  return status();
}

/** A valid access token for `scope`, refreshed when it is about to expire. */
export async function accessToken(scope, { force = false } = {}) {
  loadClient();
  const token = loadToken();
  if (!token) throw new UsageError('not signed in to Google yet: the user runs `node oikos/tools/google/cli.mjs auth` (their browser opens)');
  if (scope && !token.scopes.includes(scope)) {
    const name = Object.keys(SCOPES).find((k) => SCOPES[k] === scope);
    throw new UsageError(`the Google sign-in has no ${name} access: run auth again with --scopes including ${name}`);
  }
  if (!force && token.access_token && token.expires_at > Date.now() + 60_000) return token.access_token;
  const client = loadClient();
  const t = await exchange({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  writeSecret(tokenFile(), { ...token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 0) * 1000 });
  return t.access_token;
}

/** Revoke the sign-in at Google and delete the local token. */
export async function signOut() {
  const token = loadToken();
  if (!token) return false;
  try {
    // in the body, not the URL: an error message carries the URL
    await request('https://oauth2.googleapis.com/revoke', {
      tool: 'google', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.refresh_token }).toString(),
    });
  } catch (e) {
    // already revoked or expired: deleting the file is what is left
    if (!(e instanceof HttpError)) throw e;
  }
  rmSync(tokenFile(), { force: true });
  return true;
}
