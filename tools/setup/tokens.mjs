// The personal tokens an installation's connectors need: where to create each, the tool whose
// `whoami` checks it, and the connectors that need it. Shared by `setup` and the session-start
// hook, so both ask for the same tokens.
import { envValue } from '../common/env.mjs';
import { config } from '../common/config.mjs';

export const TOKENS = {
  JIRA_API_TOKEN: { tool: 'jira', for: ['jira', 'confluence'], url: 'https://id.atlassian.com/manage-profile/security/api-tokens (Jira and Confluence)' },
  GITLAB_TOKEN: { tool: 'gitlab', for: ['gitlab'], get url() { return `${envValue('GITLAB_URL') || '<GITLAB_URL>'}/-/user_settings/personal_access_tokens (scope read_api)`; } },
  GITHUB_TOKEN: { tool: 'github', for: ['github'], get url() { return `https://github.com/settings/tokens (fine-grained, read-only Contents + Metadata on ${envValue('GITHUB_ORG') || 'the organization'}; or \`gh auth login\`)`; } },
  // optional: asked only when named (`token GMAIL_APP_PASSWORD`), the mail route of connector google
  GMAIL_APP_PASSWORD: { optional: true, for: ['google'], url: 'https://myaccount.google.com/apppasswords (Gmail over IMAP, read-only use)' },
};

/** The connectors this installation uses (null — all of them — when oikos.yaml chooses none). */
export function usedConnectors() {
  const chosen = Object.values(config().connectors).flat();
  return chosen.length ? new Set(chosen) : null;
}

/** Whether the installation uses a connector the token is for. */
export const needed = (t) => { const used = usedConnectors(); return !used || (t.for || []).some((c) => used.has(c)); };

/** The keys a session needs set: the required tokens of the connectors in use, and JIRA_EMAIL with Jira's. */
export function neededKeys() {
  const keys = Object.entries(TOKENS).filter(([, t]) => !t.optional && needed(t)).map(([k]) => k);
  return keys.includes('JIRA_API_TOKEN') ? ['JIRA_EMAIL', ...keys] : keys;
}
