// The installation's configuration: `oikos.yaml` at its root, one organization. It is the
// installation's (its own repository, if any), never the core's.
// It holds what the code must not: the organization's name and email domain, which connectors
// each skill uses here, the non-secret settings of the tools (site URLs, an organization on a
// code host), the MCP servers of this installation and the look of its documents (brand).
// Secrets stay in `.local/.env` or, as a fallback, the environment (env.mjs); a missing file — or no installation
// at all, as in the core repository — is an empty configuration, never an error.
//
//   organization: { name: ACME Corp, email_domain: acme.example }
//   connectors: { code-hosting: [gitlab, github], task-tracking: [jira] }   # first = default
//   settings: { JIRA_BASE_URL: https://acme.atlassian.net, GITLAB_URL: https://gitlab.acme.example }
//   mcp_servers: { knowledge: { type: http, url: https://kb.acme.example/mcp } }
//   brand: { palette: { accent: 1F4E79 }, fonts: { body: { name: Inter, file: fonts/Inter.ttf } } }   # tools/documents
//   task-tracking: { jira: { defaults: { default: person, transitions: [ … ] }, projects: { PROJ: { … } } } }   # transitions.mjs
//   agents: [desk]                                       # the standing agents switched on (agents/<name>/README.md in the core)
//   desk: { warm_days: 30, cold_days: 90 }               # the desk agent's compaction thresholds (desk.mjs)
//   mounts: { vaults/team: { use: [wiki] } }             # other repositories as sources; merged with `.local/mounts.yaml` (mounts.mjs)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { installRoot, localPath, INSTALL_FILE } from './paths.mjs';
import { taskTrackingProblems } from './transitions.mjs';
import { deskProblems } from './desk.mjs';
import { LOCAL_MOUNTS_FILE, resolveMounts, scanMountKeys } from './mounts.mjs';

/** The installation's `oikos.yaml`, or null outside an installation. */
export const configFile = () => (installRoot() ? join(installRoot(), INSTALL_FILE) : null);

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

let cached;
/**
 * { organization, connectors, settings, mcp_servers, brand, 'task-tracking', agents, desk, mounts, guarded, problems }
 * — every part present, maybe empty (`agents` is a list of names, `mounts` the resolved mounts of
 * both layers, `guarded` the roots the guards keep closed: those of every key of `mounts:`, problem entries
 * and the keys of a file that does not parse included, see mounts.mjs). A malformed `task-tracking` or `desk` part is kept as written; its
 * problems, each with its path, are in `problems`.
 */
export function config() {
  if (cached) return cached;
  const problems = [];
  const unread = { shared: [], local: [] }; // the keys of a mounts file that does not parse, found by scanning it: guarded, not mounts
  const raw = installFile(problems, unread);
  const part = (key) => {
    if (raw[key] === undefined || raw[key] === null) return {}; // a key with only comments under it
    if (isMap(raw[key])) return raw[key];
    problems.push(`${INSTALL_FILE}: '${key}' must be a mapping`);
    return {};
  };
  const connectors = {};
  for (const [skill, list] of Object.entries(part('connectors'))) {
    connectors[skill] = (Array.isArray(list) ? list : String(list ?? '').split(',')).map((c) => String(c).trim()).filter(Boolean);
  }
  const taskTracking = part('task-tracking');
  problems.push(...taskTrackingProblems(taskTracking).map((p) => `${INSTALL_FILE}: ${p}`));
  const desk = part('desk');
  problems.push(...deskProblems(desk).map((p) => `${INSTALL_FILE}: ${p}`));
  let agents = [];
  if (isMap(raw.agents)) problems.push(`${INSTALL_FILE}: 'agents' must be a list of agent names`);
  else if (raw.agents !== undefined && raw.agents !== null) agents = (Array.isArray(raw.agents) ? raw.agents : String(raw.agents).split(',')).map((a) => String(a).trim()).filter(Boolean);
  const { mounts, guarded } = mountsOf(part('mounts'), unread, problems);
  cached = {
    organization: part('organization'), connectors, settings: part('settings'), mcp_servers: part('mcp_servers'), brand: part('brand'),
    'task-tracking': taskTracking, agents: [...new Set(agents)], desk, mounts, guarded, problems,
  };
  return cached;
}

/** The parsed `oikos.yaml`, `{}` when it is absent or does not parse (a problem said, and its `mounts:` keys scanned into `unread.shared`). */
function installFile(problems, unread) {
  const file = configFile();
  if (!file || !existsSync(file)) return {};
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
    return YAML.parse(text) || {};
  } catch (e) {
    problems.push(`${INSTALL_FILE} does not parse (${e.message.split('\n')[0]})`);
    unread.shared = scanMountKeys(text);
    return {};
  }
}

/** The resolved mounts and guarded roots of the shared layer `shared` and `.local/mounts.yaml`; their problems are pushed to `problems`. `unread` holds the keys of a file that did not parse. */
function mountsOf(shared, unread, problems) {
  if (!installRoot()) return { mounts: [], guarded: [] };
  const resolved = resolveMounts(installRoot(), shared, localMounts(problems, unread), unread);
  problems.push(...resolved.problems);
  return { mounts: resolved.mounts, guarded: resolved.guarded };
}

/** The `mounts:` mapping of the installation's `.local/mounts.yaml` (the personal layer), empty when absent; a bad file is a problem, and its keys are scanned into `unread.local` so they stay guarded. */
function localMounts(problems, unread) {
  const file = localPath(LOCAL_MOUNTS_FILE);
  const label = `.local/${LOCAL_MOUNTS_FILE}`;
  if (!existsSync(file)) return {};
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
    const raw = YAML.parse(text) || {};
    if (!isMap(raw)) throw new Error('the top level must be a mapping with `mounts:`');
    for (const key of Object.keys(raw)) if (key !== 'mounts') problems.push(`${label}: unknown key '${key}' (mounts)`);
    if (raw.mounts === undefined || raw.mounts === null) return {};
    if (isMap(raw.mounts)) return raw.mounts;
    problems.push(`${label}: 'mounts' must be a mapping`);
  } catch (e) {
    problems.push(`${label} does not parse (${e.message.split('\n')[0]})`);
    unread.local = scanMountKeys(text);
  }
  return {};
}

/** The organization's email domain without '@', lowercase, or null when none is configured. */
export function emailDomain() {
  const d = config().organization.email_domain;
  return d ? String(d).trim().replace(/^@/, '').toLowerCase() : null;
}

/** Every connector the installation lists under some skill in `connectors:`; empty when it lists none. */
export const listedConnectors = () => new Set(Object.values(config().connectors).flat());
