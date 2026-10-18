// Gmail v1, Drive v3 and Calendar v3 over fetch — read only, no Google client library.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../common/cli.mjs';
import { request, HttpError } from '../common/http.mjs';
import { SCOPES, accessToken } from './auth.mjs';

async function call(scope, url, { as = 'json' } = {}) {
  for (const force of [false, true]) {
    try {
      const { data } = await request(url, { tool: 'google', as, headers: { Authorization: `Bearer ${await accessToken(scope, { force })}` } });
      return data;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401 && !force) continue;
      if (e instanceof HttpError && e.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project/.test(e.body)) {
        const api = { [SCOPES.mail]: 'Gmail API', [SCOPES.drive]: 'Google Drive API', [SCOPES.calendar]: 'Google Calendar API' }[scope];
        throw new UsageError(`the ${api} is not enabled in the OAuth client's Google Cloud project: APIs & Services → Library → ${api} → Enable`);
      }
      throw e;
    }
  }
  return null;
}

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

// -- Gmail ----------------------------------------------------------------------------------

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const header = (m, name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function brief(m) {
  return {
    id: m.id,
    thread: m.threadId,
    date: header(m, 'Date'),
    from: header(m, 'From'),
    to: header(m, 'To'),
    subject: header(m, 'Subject'),
    snippet: decodeEntities(m.snippet || ''),
    labels: m.labelIds || [],
  };
}

/** Messages matching a Gmail search (the operators of the search box), newest first. */
export async function searchMail(query, { limit = 20 } = {}) {
  const list = await call(SCOPES.mail, `${GMAIL}/messages?${qs({ q: query, maxResults: limit })}`);
  const ids = (list.messages || []).map((m) => m.id);
  const meta = qs({ format: 'metadata' }) + ['From', 'To', 'Subject', 'Date'].map((h) => `&metadataHeaders=${h}`).join('');
  return Promise.all(ids.map(async (id) => brief(await call(SCOPES.mail, `${GMAIL}/messages/${id}?${meta}`))));
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (all, k) => (ENT[k.toLowerCase()] ?? (k[0] === '#'
    ? String.fromCodePoint(k[1].toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10))
    : all)));
}

/** Plain text of an HTML mail part: enough to read it, not a renderer. */
export function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const partData = (p) => Buffer.from(p.body?.data || '', 'base64url').toString('utf8');

/** The text of a message and its attachments, from the MIME tree Gmail returns. */
export function messageContent(m) {
  let plain = '';
  let html = '';
  const attachments = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ name: p.filename, type: p.mimeType, size: p.body.size, attachment: p.body.attachmentId });
    } else if (p.mimeType === 'text/plain' && !plain) plain = partData(p);
    else if (p.mimeType === 'text/html' && !html) html = partData(p);
    (p.parts || []).forEach(walk);
  };
  walk(m.payload);
  return { ...brief(m), cc: header(m, 'Cc'), text: (plain || htmlToText(html)).trim(), attachments };
}

export async function readMessage(id) {
  return messageContent(await call(SCOPES.mail, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`));
}

export async function readThread(id) {
  const t = await call(SCOPES.mail, `${GMAIL}/threads/${encodeURIComponent(id)}?format=full`);
  return (t.messages || []).map(messageContent);
}

/** Save a message's attachments (all, or those whose name contains `name`) into `out`. */
export async function saveAttachments(id, out, { name } = {}) {
  const m = await readMessage(id);
  const wanted = m.attachments.filter((a) => !name || a.name.toLowerCase().includes(name.toLowerCase()));
  if (!wanted.length) throw new UsageError(`no attachment${name ? ` matching "${name}"` : ''} in message ${id}${m.attachments.length ? `; it has: ${m.attachments.map((a) => a.name).join(', ')}` : ''}`);
  mkdirSync(out, { recursive: true });
  const saved = [];
  for (const a of wanted) {
    const body = await call(SCOPES.mail, `${GMAIL}/messages/${encodeURIComponent(id)}/attachments/${a.attachment}`);
    const file = freeName(out, safeName(a.name));
    writeFileSync(file, Buffer.from(body.data, 'base64url'));
    saved.push(file);
  }
  return saved;
}

// -- Drive ----------------------------------------------------------------------------------

const DRIVE = 'https://www.googleapis.com/drive/v3';
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives' };
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink,parents';
const G = 'application/vnd.google-apps.';

export const TYPES = {
  document: `${G}document`, spreadsheet: `${G}spreadsheet`, presentation: `${G}presentation`,
  folder: `${G}folder`, pdf: 'application/pdf',
};

// A native Google file's export formats; the first is the text one `read` uses.
const EXPORTS = {
  [`${G}document`]: { txt: 'text/plain', md: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' },
  [`${G}spreadsheet`]: { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' },
  [`${G}presentation`]: { txt: 'text/plain', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf' },
  [`${G}drawing`]: { png: 'image/png', svg: 'image/svg+xml', pdf: 'application/pdf' },
};

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Files by words (name or content), optionally of a type, in a folder, or a raw Drive query. */
export async function searchFiles({ words, type, folder, raw, limit = 20 }) {
  const terms = ['trashed = false'];
  if (raw) terms.push(`(${raw})`);
  if (words) terms.push(`(name contains ${quote(words)} or fullText contains ${quote(words)})`);
  if (type) {
    if (!TYPES[type]) throw new UsageError(`--type is one of ${Object.keys(TYPES).join(', ')}`);
    terms.push(`mimeType = ${quote(TYPES[type])}`);
  }
  if (folder) terms.push(`${quote(fileId(folder))} in parents`);
  const r = await call(SCOPES.drive, `${DRIVE}/files?${qs({ ...ALL_DRIVES, q: terms.join(' and '), pageSize: limit, orderBy: words ? undefined : 'modifiedTime desc', fields: `files(${FILE_FIELDS})` })}`);
  return r.files || [];
}

/** A file id from an id, a Drive/Docs URL, or an `?id=` link. */
export function fileId(value) {
  const s = String(value).trim();
  return s.match(/\/d\/([\w-]{10,})/)?.[1] || s.match(/[?&]id=([\w-]{10,})/)?.[1] || s.match(/\/folders\/([\w-]{10,})/)?.[1] || s;
}

export const fileInfo = (id) => call(SCOPES.drive, `${DRIVE}/files/${encodeURIComponent(id)}?${qs({ supportsAllDrives: true, fields: FILE_FIELDS })}`);

const TEXTUAL = /^text\/|^application\/(json|xml|x-yaml|javascript)$/;

/** A file's content as text: a native Google file is exported, a text file is read as is. */
export async function readFile(id, { format } = {}) {
  const f = await fileInfo(id);
  const exports = EXPORTS[f.mimeType];
  if (exports) {
    const fmt = format || Object.keys(exports)[0];
    if (!/^text\//.test(exports[fmt] || '')) throw new UsageError(`${f.name}: read gives text (${Object.keys(exports).filter((k) => /^text\//.test(exports[k])).join(', ')}); use download for ${fmt}`);
    return { file: f, text: await call(SCOPES.drive, `${DRIVE}/files/${f.id}/export?${qs({ mimeType: exports[fmt] })}`, { as: 'text' }) };
  }
  if (TEXTUAL.test(f.mimeType)) return { file: f, text: await call(SCOPES.drive, `${DRIVE}/files/${f.id}?${qs({ alt: 'media', supportsAllDrives: true })}`, { as: 'text' }) };
  throw new UsageError(`${f.name} is ${f.mimeType}: download it and read it locally (skill documents)`);
}

/** Save a file into `out`: a native Google file exported as `format`, anything else as is. */
export async function downloadFile(id, out, { format } = {}) {
  const f = await fileInfo(id);
  if (f.mimeType === TYPES.folder) throw new UsageError(`${f.name} is a folder: list it with files --folder ${f.id}`);
  const exports = EXPORTS[f.mimeType];
  let url;
  let name = f.name;
  if (exports) {
    const fmt = format || Object.keys(exports).find((k) => !/^text\//.test(exports[k]));
    if (!exports[fmt]) throw new UsageError(`${f.name} exports as ${Object.keys(exports).join(', ')}`);
    url = `${DRIVE}/files/${f.id}/export?${qs({ mimeType: exports[fmt] })}`;
    name = `${f.name}.${fmt}`;
  } else if (f.mimeType.startsWith(G)) {
    throw new UsageError(`${f.name} (${f.mimeType}) has no file form; open it: ${f.webViewLink}`);
  } else {
    if (format) throw new UsageError(`${f.name} is not a native Google file: it downloads as it is`);
    url = `${DRIVE}/files/${f.id}?${qs({ alt: 'media', supportsAllDrives: true })}`;
  }
  mkdirSync(out, { recursive: true });
  const file = freeName(out, safeName(name));
  writeFileSync(file, await call(SCOPES.drive, url, { as: 'buffer' }));
  return { file, source: f };
}

// -- Calendar -------------------------------------------------------------------------------

const CALENDAR = 'https://www.googleapis.com/calendar/v3';

/** Events between two dates (inclusive days, local time), recurring ones expanded. */
export async function listEvents({ from, to, calendar = 'primary', limit = 100 }) {
  const day = (s, end) => {
    const d = s ? new Date(`${s}T00:00:00`) : new Date(new Date().toDateString());
    if (Number.isNaN(d.getTime())) throw new UsageError(`not a date: ${s} (YYYY-MM-DD)`);
    if (end) d.setDate(d.getDate() + 1);
    return d;
  };
  const start = day(from);
  const endDay = to ? day(to, true) : new Date(start.getTime() + 7 * 86_400_000);
  const r = await call(SCOPES.calendar, `${CALENDAR}/calendars/${encodeURIComponent(calendar)}/events?${qs({
    timeMin: start.toISOString(), timeMax: endDay.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: limit,
  })}`);
  return (r.items || []).map((e) => ({
    id: e.id,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: Boolean(e.start?.date),
    summary: e.summary || '(no title)',
    location: e.location || '',
    organizer: e.organizer?.email || '',
    attendees: (e.attendees || []).map((a) => ({ email: a.email, response: a.responseStatus })),
    myResponse: (e.attendees || []).find((a) => a.self)?.responseStatus || null,
    meet: e.hangoutLink || '',
    status: e.status,
  }));
}

// -- files ----------------------------------------------------------------------------------

export const safeName = (name) => String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'file';

export function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let file = join(dir, name);
  for (let i = 2; existsSync(file); i++) file = join(dir, `${stem} (${i})${ext}`);
  return file;
}
