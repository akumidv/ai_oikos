#!/usr/bin/env node
// PreToolUse(web fetch): a page the browser skill reaches is read through the akmon-browser MCP
// server, never with a web fetch. An authenticated site answers a fetch with its login page, and
// "the page was empty" is a wrong answer — the agent reports a login page as the content.
//
// The hosts come from the installation's resource notes (`resources/<id>.md`): a note whose `via:`
// names the `browser` skill is a page oikos opens in the shared Chrome, with the user's own
// sign-in. A fetch of such a host is denied, with the reason naming the skill and the repair.
//
// What is not denied: a fetch of any other host, and a fetch at all when the notes cannot be read
// (a broken note is a question about one resource, not a reason to close the web). This guard
// closes a route, it changes nothing: the write guard and its dry-run confirmation flow are
// untouched by it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './common.mjs';
import { hookInstallation } from '../common/paths.mjs';
import { frontmatter } from '../common/landscape.mjs';

/** The tools of the hosts that fetch a page over the network. */
export const FETCH_TOOLS = new Set(['WebFetch', 'web_fetch']);

/** The skill whose pages are read in the shared Chrome. */
const SKILL = 'browser';

/** The repair when the MCP route is not there: sync writes the server into `.mcp.json`. */
export const REPAIR = 'run `node oikos/tools/sync/cli.mjs`, then /mcp reconnect or restart the session';

/** The host of a URL, lower case, without the port; null when the text is no URL. */
export function urlHost(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text.includes('://') ? text : `https://${text}`);
    return parsed.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Whether the host `host` is the host `base` or one of its subdomains: `acme.example.com` is
 * `example.com`, `notexample.com` is not.
 */
export function hostMatches(host, base) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  const b = String(base || '').toLowerCase().replace(/^\.|\.$/g, '');
  if (!h || !b) return false;
  return h === b || h.endsWith(`.${b}`);
}

/**
 * The installation's resource notes that the browser skill reaches — the hosts of their `url:`.
 * A note that does not parse, or names no URL, is left out: an unreadable note is not a reason to
 * deny a fetch. `root` is the installation's root (tests pass their own).
 * @param {string|null} root
 * @returns {{host: string, resource: string, file: string}[]}
 */
export function browserRoutes(root) {
  if (!root) return [];
  const dir = join(root, 'resources');
  if (!existsSync(dir)) return [];
  const found = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    let parsed;
    try {
      parsed = frontmatter(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue; // a note that does not parse names no route
    }
    if (!parsed) continue;
    const via = Array.isArray(parsed.fm.via) ? parsed.fm.via : String(parsed.fm.via ?? '').split(',').map((v) => v.trim());
    if (!via.includes(SKILL)) continue;
    const host = urlHost(parsed.fm.url);
    if (!host) continue;
    found.push({ host, resource: String(parsed.fm.resource ?? file.replace(/\.md$/, '')), file: `resources/${file}` });
  }
  return found;
}

/**
 * The route the fetch of `url` breaks, or null: the note of a resource the browser skill reaches
 * whose host the URL names.
 * @param {string} url the URL the call fetches
 * @param {{host: string, resource: string, file: string}[]} routes browserRoutes(root)
 */
export function routeFor(url, routes) {
  const host = urlHost(url);
  if (!host) return null;
  return routes.find((r) => hostMatches(host, r.host)) ?? null;
}

/** The reason a fetch of `url` is denied, or null. */
export function fetchReason(url, routes) {
  const route = routeFor(url, routes);
  if (!route) return null;
  return `oikos browser guard: \`${route.host}\` is a resource the \`${SKILL}\` skill reaches (${route.file}), so its page is read in the shared Chrome, `
    + 'where the user has signed in. A web fetch of an authenticated site answers with its login page, so "the page was empty" would be a wrong answer. '
    + `Read it through the akmon-browser MCP server instead (the \`mcp__akmon-browser__*\` tools; \`node oikos/tools/browser/cli.mjs status\` says whether the shared Chrome runs); if the server is missing, ${REPAIR}.`;
}

/** The guard: a fetch of a page the browser skill reaches is denied, with the route and the repair. */
export function run(payload) {
  if (!FETCH_TOOLS.has(payload.tool_name)) return;
  const url = payload.tool_input?.url;
  if (typeof url !== 'string' || !url) return;
  const { root } = hookInstallation();
  if (!root) return; // no installation: no notes, no routes
  const reason = fetchReason(url, browserRoutes(root));
  if (reason) decide(payload, 'deny', reason);
}
