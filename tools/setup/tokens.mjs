// The personal tokens an installation's connectors need: where to create each, the tool whose
// `whoami` checks it, and the connectors that need it. Shared by `setup` and the session-start
// hook, so both ask for the same tokens.
import { envValue } from '../common/env.mjs';
import { listedConnectors } from '../common/config.mjs';

// One token per service (F7 Q6): its permissions are the union of what the listed connectors of
// that service need, so the help text follows the connectors in use — read-only only when the
// code-hosting connector is the service's only one.
const listedOf = (names) => { const listed = listedConnectors(); return names.filter((c) => listed.has(c)); };
const writes = (names) => listedOf(names).length > 0;

function githubTokenUrl() {
  const org = envValue('GITHUB_ORG') || 'the organization';
  if (!writes(['github-issues', 'github-wiki'])) return `https://github.com/settings/tokens (fine-grained, read-only Contents + Metadata on ${org}; or \`gh auth login\`)`;
  const fine = ['Metadata read'];
  if (listedOf(['github']).length) fine.push('Contents read');
  if (writes(['github-issues'])) fine.push('Issues read/write', 'organization Projects read/write');
  if (writes(['github-wiki'])) fine.push('Contents read/write (the wiki; a fine-grained token may not reach wiki git — then a classic token or `gh`)');
  return `https://github.com/settings/tokens (fine-grained on ${org}: ${fine.join(', ')}; or classic: repo${writes(['github-issues']) ? ' + project' : ''}; or \`gh auth login\`${writes(['github-issues']) ? ' and `gh auth refresh -s project`' : ''})`;
}

export const TOKENS = {
  JIRA_API_TOKEN: { for: ['jira', 'confluence'], whoami: ['jira'], url: 'https://id.atlassian.com/manage-profile/security/api-tokens (Jira and Confluence)' },
  GITLAB_TOKEN: { for: ['gitlab', 'gitlab-issues', 'gitlab-wiki'], get url() { return `${envValue('GITLAB_URL') || '<GITLAB_URL>'}/-/user_settings/personal_access_tokens (scope ${writes(['gitlab-issues', 'gitlab-wiki']) ? 'api — the issue and wiki connectors write' : 'read_api'})`; } },
  GITHUB_TOKEN: { for: ['github', 'github-issues', 'github-wiki'], get url() { return githubTokenUrl(); } },
  // optional: asked only when named (`token GMAIL_APP_PASSWORD`), the mail route of connector google
  GMAIL_APP_PASSWORD: { optional: true, for: ['google'], whoami: [], url: 'https://myaccount.google.com/apppasswords (Gmail over IMAP, read-only use)' },
};

/**
 * Whether the installation lists a connector the token is for. Nothing listed — for a skill, or at
 * all — means no connector, so no token (the same rule as common/cli.mjs requireConnector).
 */
export const needed = (t) => { const listed = listedConnectors(); return (t.for || []).some((c) => listed.has(c)); };

/** The listed connectors whose tool's `whoami` checks the token `t` (`whoami`, else every one it is for). */
export const whoamiTools = (t) => listedOf(t.whoami || t.for || []);

/** The keys a session needs set: the required tokens of the listed connectors, and JIRA_EMAIL with Jira's. */
export function neededKeys() {
  const keys = Object.entries(TOKENS).filter(([, t]) => !t.optional && needed(t)).map(([k]) => k);
  return keys.includes('JIRA_API_TOKEN') ? ['JIRA_EMAIL', ...keys] : keys;
}

/**
 * The tokens `setup token` asks for when no key is named, from `sources` (each candidate key → where
 * its value comes from now: '.local/.env' | 'config' | 'env' | null): every one not yet in the
 * installation's `.local/.env` — missing, or only in oikos.yaml or the shell environment — so each
 * moves there; `all` asks for every one again.
 */
export function tokensToAsk(sources, { all = false } = {}) {
  return Object.entries(sources).filter(([, source]) => all || source !== '.local/.env').map(([key]) => key);
}
