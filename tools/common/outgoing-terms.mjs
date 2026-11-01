// The words an installation keeps out of outgoing text beyond the ones it lists itself (ADR 0007 D04,
// D05): the terms it derives from where it lives, the terms of the installations linked to it, and
// the organization's markers. Each function returns plain data for `OutgoingRules` (outgoing.mjs):
// fixed strings (`terms`, matched ignoring case) and, for what is a shape rather than a word,
// regular expressions (`patterns`, category `term`). Nothing here reads an environment variable or
// writes; a folder or a file that cannot be read adds nothing.
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isCore, isInstallation } from './paths.mjs';

/** The shortest name or path that is a derived term: a shorter one is a common word and would flag ordinary text. */
export const MIN_DERIVED_TERM = 8;

/** Generic file names that every folder has; they are no term even when long enough. */
const COMMON_NAMES = new Set(['readme.md', 'agents.md', 'claude.md', 'tasks.md', 'notes.md', 'index.md', 'changelog.md', 'package.json', 'node_modules', 'license']);

/** Hosts every user of a code host shares: they say nothing of one organization. */
const PUBLIC_HOSTS = new Set(['github.com', 'api.github.com', 'gitlab.com', 'www.github.com', 'www.gitlab.com']);

const unique = (list) => [...new Set(list)];
const isLong = (text) => text.length >= MIN_DERIVED_TERM;

/** The path as typed and its real path when that differs: a text may quote either. */
function rootForms(root) {
  const forms = [resolve(root)];
  try {
    forms.push(realpathSync(root));
  } catch { /* a root that is gone has no real form */ }
  return unique(forms);
}

/**
 * The terms an installation derives from where it lives: its absolute root (as typed and real), this
 * machine's home folder and the names of the entries of its `.local/` — each only when it is at least
 * MIN_DERIVED_TERM characters and not a generic name, to keep the noise down.
 * @param {string} root the installation's root
 * @param {{home?: string}} [where] the home folder (a test passes its own)
 * @returns {string[]}
 */
export function derivedTerms(root, { home = homedir() } = {}) {
  const names = [];
  try {
    names.push(...readdirSync(join(root, '.local')));
  } catch { /* no .local/ */ }
  const generic = (name) => COMMON_NAMES.has(name.toLowerCase());
  return unique([...rootForms(root), home, ...names.filter((name) => !generic(name))].filter((term) => typeof term === 'string' && isLong(term)));
}

/**
 * The installations linked to this one — the mounts whose root is an installation of oikos — each with
 * the terms it keeps out: `termsOf(root)` (its own `.local/outgoing.yaml`) and its derived terms.
 * A mount that is the core is not one (D05: the core is never an installation).
 * @param {{root: string}[]} mounts the resolved mounts
 * @param {(root: string) => {terms: string[], problems: string[]}} termsOf the reader of a root's listed terms
 * @returns {{terms: string[], problems: string[]}}
 */
export function linkedTerms(mounts, termsOf) {
  const terms = [];
  const problems = [];
  for (const mount of mounts) {
    if (isCore(mount.root) || !isInstallation(mount.root)) continue;
    const own = termsOf(mount.root);
    terms.push(...own.terms, ...derivedTerms(mount.root));
    problems.push(...own.problems.map((problem) => `linked installation ${mount.path}: ${problem}`));
  }
  return { terms: unique(terms), problems };
}

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The host of a URL-looking value, lower case, or null. */
function hostOf(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The pattern for a task number written as the template `template` says (`FIX[{n}]`): `{n}` stands for digits. */
const numberPattern = (template) => new RegExp(template.split('{n}').map(escaped).join('\\d+'), 'i');

const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]*$/;
const listOf = (value) => (Array.isArray(value) ? value : []);

/** A project's key and its aliases, each as the pattern of a task key (`KEY-123`). */
const keyPatterns = (key, project) => [key, ...listOf(project?.key_aliases)]
  .filter((name) => typeof name === 'string' && KEY_SHAPE.test(name))
  .map((name) => new RegExp(`\\b${escaped(name)}-\\d+\\b`));

/** The number templates (`FIX[{n}]`) a tracker's part names: its defaults' and each project's. */
function templatesOf(part) {
  const projects = Object.values(isMap(part?.projects) ? part.projects : {});
  return [...listOf(part?.defaults?.number_patterns), ...projects.flatMap((project) => listOf(project?.number_patterns))]
    .filter((template) => typeof template === 'string' && template.includes('{n}'));
}

/** The tracker keys the installation's `task-tracking` part names — each project key and its aliases in the shape `KEY-123` — and its number templates, as patterns. */
function trackerPatterns(taskTracking) {
  return Object.values(isMap(taskTracking) ? taskTracking : {}).flatMap((part) => [
    ...Object.entries(isMap(part?.projects) ? part.projects : {}).flatMap(([key, project]) => keyPatterns(key, project)),
    ...templatesOf(part).map(numberPattern),
  ]);
}

/**
 * The organization's markers (D05): its email domain, the hosts of its connectors' sites and servers
 * (settings and MCP servers that hold an address; the hosts every user of a code host shares are left
 * out), and its tracker key patterns. What a personal vault must not name.
 * @param {{organization?: object, settings?: object, mcp_servers?: object, 'task-tracking'?: object}} cfg the installation's configuration
 * @returns {{terms: string[], patterns: RegExp[]}}
 */
export function organizationMarkers(cfg) {
  const domain = cfg.organization?.email_domain ? String(cfg.organization.email_domain).trim().replace(/^@/, '').toLowerCase() : null;
  const addresses = [
    ...Object.values(isMap(cfg.settings) ? cfg.settings : {}),
    ...Object.values(isMap(cfg.mcp_servers) ? cfg.mcp_servers : {}).map((server) => server?.url),
  ];
  const hosts = addresses.map(hostOf).filter((host) => host && !PUBLIC_HOSTS.has(host));
  return { terms: unique([domain, ...hosts].filter(Boolean)), patterns: trackerPatterns(cfg['task-tracking']) };
}
