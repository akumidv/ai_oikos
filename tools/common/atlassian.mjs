// Atlassian Cloud client shared by the jira and confluence tools: one identity for both.
// JIRA_BASE_URL comes from the installation's settings; JIRA_EMAIL falls back to
// `git config user.email` only when that is in the organization's email domain (none without a
// configured domain); JIRA_API_TOKEN is the one value a person must supply.
import { lookup, orgEmail, orgEmailLabel, orgGitEmail, credentialsHelp } from './env.mjs';
import { emailDomain } from './config.mjs';
import { request } from './http.mjs';
import { UsageError } from './cli.mjs';

export function atlassianCreds(prefix = 'JIRA') {
  const pick = (name) => lookup(`${prefix}_${name}`).value || lookup(`JIRA_${name}`).value;
  const baseUrl = (pick('BASE_URL') || '').replace(/\/+$/, '') || null;
  const email = orgEmail(pick('EMAIL')) || orgGitEmail();
  return { baseUrl, email, token: pick('API_TOKEN') };
}

export const credsComplete = (c) => Boolean(c.baseUrl && c.email && c.token);

export function atlassianHelp(c) {
  const extra = [];
  if (!c.email) extra.push(`  JIRA_EMAIL must be ${orgEmailLabel()} (.local/.env or env${emailDomain() ? ', or git config user.email' : ''}).`);
  extra.push('  Token: https://id.atlassian.com/manage-profile/security/api-tokens');
  return credentialsHelp(['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'], { extra });
}

/**
 * The error for a command that would `what` without complete credentials `c`: a usage error (exit 1)
 * that names each missing key, raised before any request. `product` names the side ('Jira',
 * 'Atlassian') in the first line.
 */
export function missingCreds(c, product, what) {
  return new UsageError(`no ${product} credentials — cannot ${what}\n${atlassianHelp(c)}`);
}

export function atlassianClient(c, tool) {
  const auth = 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64');
  const call = (method, path, body, opts = {}) =>
    request(path.startsWith('http') ? path : `${c.baseUrl}${path}`, {
      tool,
      method,
      body,
      ...opts,
      headers: { Authorization: auth, ...opts.headers },
    });
  return {
    get: (path, opts) => call('GET', path, undefined, opts).then((r) => r.data),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    raw: call,
  };
}
