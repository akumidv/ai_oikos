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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { installRoot, INSTALL_FILE } from './paths.mjs';

/** The installation's `oikos.yaml`, or null outside an installation. */
export const configFile = () => (installRoot() ? join(installRoot(), INSTALL_FILE) : null);

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

let cached;
/** { organization, connectors, settings, mcp_servers, brand, problems } — every part present, maybe empty. */
export function config() {
  if (cached) return cached;
  const problems = [];
  let raw = {};
  const file = configFile();
  if (file && existsSync(file)) {
    try {
      raw = YAML.parse(readFileSync(file, 'utf8')) || {};
    } catch (e) {
      problems.push(`${INSTALL_FILE} does not parse (${e.message.split('\n')[0]})`);
    }
  }
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
  cached = { organization: part('organization'), connectors, settings: part('settings'), mcp_servers: part('mcp_servers'), brand: part('brand'), problems };
  return cached;
}

/** The organization's email domain without '@', lowercase, or null when none is configured. */
export function emailDomain() {
  const d = config().organization.email_domain;
  return d ? String(d).trim().replace(/^@/, '').toLowerCase() : null;
}

/** Every connector the installation lists under some skill in `connectors:`; empty when it lists none. */
export const listedConnectors = () => new Set(Object.values(config().connectors).flat());
