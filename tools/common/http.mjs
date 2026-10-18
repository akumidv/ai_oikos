// Every outward request goes through here. Two things a hand-built fetch gets wrong:
// - hosts behind Cloudflare may answer an anonymous User-Agent with a 1010 ban — a 403 that
//   reads exactly like a rejected token — so every request names the tool;
// - Node's fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1, so a proxied machine sees
//   "no channel" for a host that is reachable. We say so instead of guessing.
import { createWriteStream, renameSync, rmSync } from 'node:fs';

const CONTACT = '+oikos';
const TIMEOUT_MS = 30_000;

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} from ${url}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class ChannelError extends Error {}

export const userAgent = (tool) => `oikos-${tool}/0.1 (${CONTACT})`;

function proxyHint() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy && process.env.NODE_USE_ENV_PROXY !== '1') {
    return ' A proxy is set in the environment but Node ignores it: re-run with NODE_USE_ENV_PROXY=1.';
  }
  return '';
}

/**
 * fetch with the tool's User-Agent, a timeout and uniform errors.
 * Returns { status, headers, data } where data is parsed JSON, text or a Buffer (`as: 'buffer'`).
 */
export async function request(url, { tool, method = 'GET', headers = {}, body, as = 'json' } = {}) {
  const init = {
    method,
    headers: { 'User-Agent': userAgent(tool), Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const host = new URL(url).host;
    throw new ChannelError(
      `no channel to ${host} from this machine (${e.cause?.code || e.name}). ` +
        `An internal host needs the organization's channel: check the proxy/VPN/WARP, not the service.${proxyHint()}`,
    );
  }
  if (/cloudflareaccess\.com/.test(res.url)) {
    throw new ChannelError(
      `${new URL(url).host} answered with the Cloudflare Access login page: this request did not ` +
        `go through the corporate channel (proxy/VPN/WARP).${proxyHint()}`,
    );
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 403 && /error code:?\s*1010|cloudflare/i.test(text)) {
      throw new HttpError(403, url, 'Cloudflare edge ban (1010) on the User-Agent, not a rejected token');
    }
    throw new HttpError(res.status, url, text);
  }
  let data;
  if (as === 'buffer') data = Buffer.from(await res.arrayBuffer());
  else if (as === 'text') data = await res.text();
  else {
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(res.status, url, `expected JSON, got: ${text.slice(0, 120)}`);
    }
  }
  return { status: res.status, headers: res.headers, data };
}

/**
 * Stream a large file to disk: no overall timeout, but aborted when no data arrives for
 * `idleMs`. Written to `<file>.part` and renamed when complete. `onProgress(bytes, total)`.
 */
export async function download(url, file, { tool, idleMs = 30_000, onProgress } = {}) {
  const abort = new AbortController();
  let timer;
  const idle = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), idleMs); };
  idle();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': userAgent(tool) }, signal: abort.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new ChannelError(`no answer from ${new URL(url).host} (${e.cause?.code || e.name}).${proxyHint()}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw new HttpError(res.status, url, await res.text());
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const part = `${file}.part`;
  const out = createWriteStream(part);
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      idle();
      bytes += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.(bytes, total);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw new ChannelError(`download from ${new URL(url).host} stopped after ${bytes} bytes (${e.cause?.code || e.name})`);
  } finally {
    clearTimeout(timer);
  }
  if (total && bytes !== total) throw new ChannelError(`download from ${new URL(url).host} is incomplete: ${bytes} of ${total} bytes`);
  renameSync(part, file);
  return { bytes };
}
