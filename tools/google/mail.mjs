// Gmail over IMAP with a Google app password, the way a desktop mail client reads it: no
// Google Cloud project. The password is GMAIL_APP_PASSWORD (environment or the local env file,
// typed by the user with `node oikos/tools/setup/cli.mjs token GMAIL_APP_PASSWORD`); the account is
// GMAIL_USER, else JIRA_EMAIL, else the git email when it is in the organization's email domain —
// always a corporate one. Read-only: "All
// Mail" is opened with EXAMINE, bodies are fetched with BODY.PEEK, so nothing is even marked
// read. Search takes the Gmail search box's operators (X-GM-RAW); ids are Gmail's own message
// and thread ids (X-GM-MSGID, X-GM-THRID), the same ones the web interface uses.
// imapflow and mailparser are tools/google's own dependencies, installed on first use.
import { writeFileSync, mkdirSync } from 'node:fs';
import { UsageError } from '../common/cli.mjs';
import { envValue, orgEmail, orgEmailLabel, orgGitEmail } from '../common/env.mjs';
import { toolDependenciesInstalled } from '../common/programs.mjs';
import { htmlToText, safeName, freeName } from './api.mjs';

const HOST = 'imap.gmail.com';
const PORT = 993;

export const mailConfigured = () => Boolean(envValue('GMAIL_APP_PASSWORD'));
export const mailAccount = () => {
  const named = envValue('GMAIL_USER') || envValue('JIRA_EMAIL');
  return named ? orgEmail(named) : orgGitEmail();
};

export const MAIL_DEPENDENCIES = 'imapflow + mailparser (~15 MB) into tools/google/node_modules';

async function connect() {
  if (!mailConfigured()) {
    throw new UsageError('no Gmail app password: the user creates one at https://myaccount.google.com/apppasswords and types it with `node oikos/tools/setup/cli.mjs token GMAIL_APP_PASSWORD`');
  }
  const user = mailAccount();
  if (!user) throw new UsageError(`no work account for mail: set GMAIL_USER (or JIRA_EMAIL) to ${orgEmailLabel()}`);
  if (!toolDependenciesInstalled('google')) {
    throw new UsageError(`the mail libraries are not installed yet (${MAIL_DEPENDENCIES}): node oikos/tools/google/cli.mjs install — a plan, then --yes`);
  }
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: HOST, port: PORT, secure: true, logger: false,
    auth: { user, pass: envValue('GMAIL_APP_PASSWORD').replace(/\s+/g, '') },
  });
  client.on('error', () => {}); // a dropped connection surfaces through the pending command
  try {
    await client.connect();
  } catch (e) {
    if (e.authenticationFailed) {
      throw new UsageError(`Gmail refused the app password for ${user}: create a new one at https://myaccount.google.com/apppasswords and run \`node oikos/tools/setup/cli.mjs token GMAIL_APP_PASSWORD\``);
    }
    if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(e.code)) {
      throw new UsageError(`no channel to ${HOST}:${PORT} (${e.code}): check the network or proxy, or use the browser route`);
    }
    throw new Error(`IMAP: ${e.responseText || e.message}`, { cause: e });
  }
  return { client, user };
}

/** Run `fn(client)` with "All Mail" open read-only. */
async function withAllMail(fn) {
  const { client, user } = await connect();
  try {
    const all = (await client.list()).find((b) => b.specialUse === '\\All');
    if (!all) throw new UsageError('no "All Mail" folder over IMAP: in Gmail → Settings → Labels, tick "Show in IMAP" for All Mail');
    await client.mailboxOpen(all.path, { readOnly: true });
    return await fn(client, { user, mailbox: all.path });
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const addresses = (a) => (a?.value || []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');
const envelopeFrom = (list) => (list || []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');

async function uidsOf(client, query) {
  const uids = await client.search(query, { uid: true });
  return (uids || []).sort((a, b) => a - b);
}

/** Who the mail route signs in as, and how big All Mail is. */
export const mailStatus = () => withAllMail(async (client, { user, mailbox }) => ({
  account: user, host: HOST, mailbox, messages: client.mailbox.exists,
}));

export function searchMail(query, { limit = 20 } = {}) {
  return withAllMail(async (client) => {
    const uids = (await uidsOf(client, { gmraw: query })).slice(-limit);
    if (!uids.length) return [];
    const list = [];
    for await (const m of client.fetch(uids, { uid: true, envelope: true, emailId: true, threadId: true, internalDate: true }, { uid: true })) {
      list.push({
        id: m.emailId, thread: m.threadId, date: (m.envelope.date || m.internalDate)?.toISOString?.() || null,
        from: envelopeFrom(m.envelope.from), subject: m.envelope.subject || '', snippet: '',
      });
    }
    return list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  });
}

async function parsed(client, uid) {
  const { simpleParser } = await import('mailparser');
  const m = await client.fetchOne(uid, { uid: true, source: true, emailId: true, threadId: true }, { uid: true });
  const p = await simpleParser(m.source);
  return {
    id: m.emailId, thread: m.threadId, date: p.date?.toISOString() || null,
    from: addresses(p.from), to: addresses(p.to), cc: addresses(p.cc), subject: p.subject || '',
    text: (p.text || htmlToText(p.html || '')).trim(),
    attachments: p.attachments.filter((a) => a.filename || a.contentDisposition === 'attachment')
      .map((a) => ({ name: a.filename || 'attachment', type: a.contentType, size: a.size, content: a.content })),
  };
}

const bare = ({ attachments, ...m }) => ({ ...m, attachments: attachments.map(({ content: _content, ...a }) => a) });

async function uidOfMessage(client, id) {
  if (!/^\d+$/.test(String(id))) throw new UsageError('a Gmail message id is a number (the id column of `mail`)');
  const [uid] = await uidsOf(client, { emailId: String(id) });
  if (!uid) throw new UsageError(`no message ${id} in All Mail`);
  return uid;
}

export const readMessage = (id) => withAllMail(async (client) => bare(await parsed(client, await uidOfMessage(client, id))));

/** The whole thread, oldest first: `id` is a thread id or the id of any message in it. */
export const readThread = (id) => withAllMail(async (client) => {
  if (!/^\d+$/.test(String(id))) throw new UsageError('a Gmail thread or message id is a number');
  let uids = await uidsOf(client, { threadId: String(id) });
  if (!uids.length) {
    const m = await client.fetchOne(await uidOfMessage(client, id), { uid: true, threadId: true }, { uid: true });
    uids = await uidsOf(client, { threadId: m.threadId });
  }
  const list = [];
  for (const uid of uids) list.push(bare(await parsed(client, uid)));
  return list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
});

export const saveAttachments = (id, out, { name } = {}) => withAllMail(async (client) => {
  const m = await parsed(client, await uidOfMessage(client, id));
  const chosen = m.attachments.filter((a) => !name || a.name.toLowerCase().includes(name.toLowerCase()));
  if (!chosen.length) throw new UsageError(`no attachment${name ? ` matching "${name}"` : ''} in message ${id}${m.attachments.length ? `; it has: ${m.attachments.map((a) => a.name).join(', ')}` : ''}`);
  mkdirSync(out, { recursive: true });
  return chosen.map((a) => {
    const file = freeName(out, safeName(a.name));
    writeFileSync(file, a.content);
    return file;
  });
});
