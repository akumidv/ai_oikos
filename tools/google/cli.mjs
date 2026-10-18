#!/usr/bin/env node
// Google Workspace on the user's machine, never through the Claude cloud.
// Without a token: `drive` finds the Google Drive for desktop folder in this environment; `link`
// reads a Drive link file (.gdoc, .gsheet, …: a small JSON, not the content) and gives the
// document's id and the URLs to open or export it in the shared browser.
// With the user's own sign-in (auth.mjs: their OAuth client, the token in .local/google/):
// read-only Gmail, Drive and Calendar over the REST APIs (api.mjs). Mail also works without it,
// over IMAP with a Google app password (mail.mjs), the way a mail client reads it; that route
// wins when GMAIL_APP_PASSWORD is set. The API route needs an OAuth
// client in a Google Cloud project, so it is off unless OIKOS_GOOGLE_API=1 (environment or the
// local env file); `logout` works either way. Nothing here sends, shares, deletes or changes
// anything at Google.
//
// The folder is looked up in this order: OIKOS_GDRIVE_PATH (environment or the local env
// file); the catalog root `gdrive` (.local/catalog.yaml); then the usual places — a Windows drive
// whose label is "Google Drive" or whose root looks like Drive's (natively, and under WSL as
// /mnt/<letter>), ~/Library/CloudStorage/GoogleDrive-<account> on macOS. Linux has no client.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { envValue, environment, orgEmail } from '../common/env.mjs';
import { missingMessage } from '../common/files.mjs';
import { loadCatalog } from '../catalog/cli.mjs';
import { SCOPES, clientFile, importClient, signIn, signOut, status } from './auth.mjs';
import * as gmailApi from './api.mjs';
import { searchFiles, fileId, readFile, downloadFile, listEvents } from './api.mjs';
import * as imap from './mail.mjs';
import { toolDependenciesInstalled, installToolDependencies } from '../common/programs.mjs';

const CATALOG_ROOT = 'gdrive';

// Top-level folders of a Drive mount; Drive names them in the system's language.
const MY_DRIVE = ['My Drive', 'Мой диск', 'Meine Ablage', 'Mon Drive', 'Mi unidad', 'Il mio Drive'];
const SHARED = ['Shared drives', 'Общие диски', 'Geteilte Ablagen', 'Drives partagés', 'Unidades compartidas', 'Drive condivisi'];
const MARKER = '.shortcut-targets-by-id';

const entries = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Whether `dir` is the root of a Drive for desktop mount, by the folders Drive keeps there. */
export function looksLikeDrive(dir) {
  const names = entries(dir);
  return names.includes(MARKER) || names.some((n) => MY_DRIVE.includes(n) || SHARED.includes(n));
}

/** Windows drives as `{ letter, label }`, from Windows itself (natively or through WSL interop). */
function windowsDrives(wsl) {
  const r = spawnSync(wsl ? 'powershell.exe' : 'powershell',
    ['-NoProfile', '-Command', 'Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Name + "|" + $_.Description }'],
    { encoding: 'utf8', timeout: 20000, cwd: wsl ? '/mnt/c' : undefined });
  return (r.stdout || '').split(/\r?\n/).map((l) => l.match(/^([A-Za-z])\|(.*)$/)).filter(Boolean)
    .map(([, letter, label]) => ({ letter: letter.toUpperCase(), label: label.trim() }));
}

/**
 * Candidates in this environment: `{ path, account?, drive?, mounted }`. Under WSL a Windows
 * drive that WSL has not mounted comes back with mounted: false and the command to mount it.
 */
export function findDriveFolders() {
  const where = environment();
  if (where.os === 'macos') {
    const cloud = join(homedir(), 'Library', 'CloudStorage');
    const found = entries(cloud).filter((n) => n.startsWith('GoogleDrive-'))
      .map((n) => ({ path: join(cloud, n), account: n.slice('GoogleDrive-'.length), mounted: true }));
    const legacy = '/Volumes/GoogleDrive';
    if (!found.length && looksLikeDrive(legacy)) found.push({ path: legacy, mounted: true });
    return found;
  }
  if (where.os !== 'windows' && !where.wsl) return [];
  const toPath = (letter) => (where.wsl ? `/mnt/${letter.toLowerCase()}` : `${letter}:\\`);
  const found = [];
  for (const { letter, label } of windowsDrives(where.wsl)) {
    const path = toPath(letter);
    const mounted = existsSync(path) && entries(path).length > 0;
    if (/google drive/i.test(label) || (mounted && looksLikeDrive(path))) {
      found.push({ path, drive: `${letter}:`, label, mounted,
        ...(mounted ? {} : { mount: `sudo mkdir -p ${path} && sudo mount -t drvfs ${letter}: ${path}` }) });
    }
  }
  // Interop off (no powershell.exe): the drives WSL already mounts.
  if (!found.length && where.wsl) {
    for (const n of entries('/mnt').filter((x) => /^[a-z]$/.test(x))) {
      if (looksLikeDrive(`/mnt/${n}`)) found.push({ path: `/mnt/${n}`, drive: `${n.toUpperCase()}:`, mounted: true });
    }
  }
  return found;
}

/** The folder in use: `{ path, source }`, or `{ path: null, candidates }` when there is none yet. */
export function driveFolder() {
  const explicit = envValue('OIKOS_GDRIVE_PATH');
  if (explicit) {
    if (!existsSync(explicit)) throw new UsageError(`OIKOS_GDRIVE_PATH=${explicit} does not exist`);
    return { path: explicit, source: 'OIKOS_GDRIVE_PATH' };
  }
  const root = loadCatalog().roots[CATALOG_ROOT];
  if (root) {
    if (!existsSync(root)) throw new UsageError(`catalog root @${CATALOG_ROOT} (${root}) does not exist: is Drive for desktop running?`);
    return { path: root, source: `catalog @${CATALOG_ROOT}` };
  }
  const candidates = findDriveFolders();
  const usable = candidates.filter((c) => c.mounted);
  // Several accounts (macOS keeps one folder each): the corporate one.
  const pick = usable.find((c) => c.account && orgEmail(c.account)) || (usable.length === 1 ? usable[0] : null);
  return pick ? { path: pick.path, source: 'found', ...(pick.account ? { account: pick.account } : {}) } : { path: null, candidates };
}

// -- link files -----------------------------------------------------------------------------

// Extension → the Docs editor's path and export formats (the first is the text one to read).
const LINK_KINDS = {
  '.gdoc': { kind: 'document', exports: ['txt', 'docx', 'pdf', 'md'] },
  '.gsheet': { kind: 'spreadsheets', exports: ['csv', 'xlsx', 'pdf'] },
  '.gslides': { kind: 'presentation', exports: ['txt', 'pptx', 'pdf'] },
  '.gdraw': { kind: 'drawings', exports: ['png', 'svg', 'pdf'] },
  '.gform': { kind: 'forms', exports: [] },
  '.gsite': { kind: 'site', exports: [] },
  '.gjam': { kind: 'jam', exports: [] },
  '.gmap': { kind: 'map', exports: [] },
};

/** What a Drive link file points to: id, account, and the URLs to open and export it. */
export function readLink(file) {
  const ext = extname(file).toLowerCase();
  const spec = LINK_KINDS[ext];
  if (!spec) throw new UsageError(`${basename(file)}: not a Drive link file (${Object.keys(LINK_KINDS).join(', ')})`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`${basename(file)}: not readable as a link (${e.message}); an online-only file may need Drive for desktop running`);
  }
  // Drive for desktop writes doc_id (+ resource_key, email); the old Backup and Sync wrote url.
  const id = data.doc_id || String(data.url || '').match(/[?&]id=([\w-]+)|\/d\/([\w-]+)/)?.slice(1).find(Boolean);
  if (!id) throw new UsageError(`${basename(file)}: no document id in the link file`);
  const key = data.resource_key ? `resourcekey=${encodeURIComponent(data.resource_key)}` : '';
  const q = (base, extra = '') => base + ([extra, key].filter(Boolean).length ? `?${[extra, key].filter(Boolean).join('&')}` : '');
  const docs = ['document', 'spreadsheets', 'presentation', 'drawings'].includes(spec.kind);
  const open = docs ? q(`https://docs.google.com/${spec.kind}/d/${id}/edit`) : q(`https://drive.google.com/open`, `id=${id}`);
  // Slides and drawings export by path, Docs and Sheets by ?format=; a Sheet's CSV is its first
  // sheet unless &gid=<gid> (from the sheet's URL) is added.
  const exportUrl = (f) => (['presentation', 'drawings'].includes(spec.kind)
    ? q(`https://docs.google.com/${spec.kind}/d/${id}/export/${f}`)
    : q(`https://docs.google.com/${spec.kind}/d/${id}/export`, `format=${f}`));
  return {
    file,
    kind: spec.kind,
    id,
    ...(data.email ? { account: data.email } : {}),
    open,
    export: Object.fromEntries(spec.exports.map((f) => [f, exportUrl(f)])),
  };
}

// -- commands -------------------------------------------------------------------------------

const limitOf = (v, max = 100) => {
  const n = Number(v.limit || 20);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`--limit is 1..${max}`);
  return n;
};
/** A Drive file id from an id, a URL, or a .gdoc/.gsheet link file in the Drive folder. */
const idOf = (arg) => {
  if (!arg) throw new UsageError('a file id, a Drive/Docs URL or a .gdoc/.gsheet file is required');
  return /\.g[a-z]+$/i.test(arg) && existsSync(arg) ? readLink(arg).id : fileId(arg);
};
const outOf = (v) => {
  if (!v.out) throw new UsageError('--out <folder> is required (the session scratchpad unless the user named a place)');
  return v.out;
};
const when = (d) => (d ? new Date(d).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '');

const commands = {
  drive: {
    help: 'where the Google Drive for desktop folder is in this environment, and its top-level folders',
    async run(v) {
      const found = driveFolder();
      if (!found.path) {
        const where = environment();
        const pending = found.candidates.filter((c) => !c.mounted);
        if (v.json) printJson(found);
        else if (pending.length) {
          for (const c of pending) {
            console.log(`Drive for desktop is ${c.drive} on Windows, but WSL does not mount it. The user runs (oikos does not use sudo):\n  ${c.mount}`);
          }
        } else if (found.candidates.length > 1) {
          console.log('Several Drive folders; say which one to use:');
          for (const c of found.candidates) console.log(`  ${c.path}${c.account ? `  (${c.account})` : ''}`);
          console.log(`then: node oikos/tools/catalog/cli.mjs add root ${CATALOG_ROOT} <path>`);
        } else {
          console.log(where.os === 'linux' && !where.wsl
            ? 'no Google Drive client exists for Linux: use the browser route (skills/google/scenarios/browser.md)'
            : 'Google Drive for desktop was not found: not installed, not signed in, or mounted as a folder elsewhere '
              + '(then OIKOS_GDRIVE_PATH or the catalog root). Otherwise use the browser route.');
        }
        return 1;
      }
      const folders = entries(found.path).filter((n) => !n.startsWith('.') && statSync(join(found.path, n), { throwIfNoEntry: false })?.isDirectory());
      if (v.json) return printJson({ ...found, folders });
      console.log(`${found.path}  (${found.source}${found.account ? `, ${found.account}` : ''})`);
      for (const f of folders) console.log(`  ${f}/`);
      if (found.source === 'found') console.log(`remember it (preview, then --yes): node oikos/tools/catalog/cli.mjs add root ${CATALOG_ROOT} "${found.path}"`);
    },
  },
  link: {
    help: 'a Drive link file (.gdoc, .gsheet, .gslides, …): document id, account, the URL to open it and the export URLs',
    async run(v, files) {
      if (!files.length) throw new UsageError('a link file is required: link <file.gdoc> [...]');
      for (const f of files) if (!existsSync(f)) throw new UsageError(missingMessage(f));
      const links = files.map(readLink);
      if (v.json) return printJson(links.length === 1 ? links[0] : links);
      for (const l of links) {
        console.log(`${l.file}\n  ${l.kind} ${l.id}${l.account ? `  (${l.account})` : ''}\n  open: ${l.open}`);
        for (const [f, url] of Object.entries(l.export)) console.log(`  ${f}: ${url}`);
      }
    },
  },
};

// The API route: off unless OIKOS_GOOGLE_API=1 (it needs a Google Cloud project).
const API_OFF = 'the Google API route is off: it needs an OAuth client in a Google Cloud project. Use the browser '
  + 'route or the Drive folder (skills/google/SKILL.md); the user turns it on with OIKOS_GOOGLE_API=1 in .local/.env';
const apiOn = () => envValue('OIKOS_GOOGLE_API') === '1';

/** The mail route: IMAP with the app password when it is set, else the API when it is on. */
function mailRoute() {
  if (imap.mailConfigured()) return imap;
  if (apiOn()) return gmailApi;
  throw new UsageError('no mail route yet: the user creates a Google app password at https://myaccount.google.com/apppasswords and types it with `node oikos/tools/setup/cli.mjs token GMAIL_APP_PASSWORD`; otherwise mail goes through the browser (skills/google/scenarios/browser.md)');
}

const api = {
  client: {
    help: 'import the user\'s OAuth client (Desktop app JSON from Google Cloud) into .local/google/; --yes replaces one',
    options: { yes: { type: 'boolean' } },
    async run(v, [src]) {
      if (!src) throw new UsageError('the downloaded client JSON is required: client <client_secret_….json>');
      if (!existsSync(src)) throw new UsageError(missingMessage(src));
      const r = importClient(src, { replace: v.yes });
      console.log(`client saved to ${r.file} (mode 600${r.project ? `, project ${r.project}` : ''}); the downloaded file can be deleted.\nnext: node oikos/tools/google/cli.mjs auth`);
    },
  },
  auth: {
    help: 'sign in to Google in the browser (loopback + PKCE), read-only; --scopes mail,drive,calendar (default all), --print only prints the URL',
    options: { scopes: { type: 'string' }, print: { type: 'boolean' } },
    async run(v) {
      const names = (v.scopes || Object.keys(SCOPES).join(',')).split(',').map((x) => x.trim()).filter(Boolean);
      const bad = names.filter((n) => !SCOPES[n]);
      if (bad.length) throw new UsageError(`unknown scope ${bad.join(', ')}; one of ${Object.keys(SCOPES).join(', ')}`);
      const s = await signIn({ scopes: names.map((n) => SCOPES[n]), print: v.print, log: (l) => console.error(l) });
      if (v.json) return printJson(s);
      console.log(`signed in as ${s.account}: ${s.scopes.join(', ')} (read-only); token in ${s.files}`);
    },
  },
  logout: {
    help: 'revoke the local Google sign-in and delete its token: a plan by default, --yes does it',
    options: { yes: { type: 'boolean' } },
    async run(v) {
      const s = status();
      if (!s.account) return console.log('not signed in');
      if (!v.yes) return console.log(`would revoke the sign-in of ${s.account} at Google and delete its token; run again with --yes`);
      await signOut();
      console.log(`signed out ${s.account}; the OAuth client stays (client.json)`);
    },
    always: true,
  },
  files: {
    help: 'Drive search by words in the name or text, all drives: --type document|spreadsheet|presentation|pdf|folder, --folder <id|url>, --q <raw Drive query>, --limit',
    options: { type: { type: 'string' }, folder: { type: 'string' }, q: { type: 'string' }, limit: { type: 'string' } },
    async run(v, words) {
      if (!words.length && !v.folder && !v.q && !v.type) throw new UsageError('words, --folder, --type or --q is required');
      const list = await searchFiles({ words: words.join(' '), type: v.type, folder: v.folder, raw: v.q, limit: limitOf(v, 1000) });
      if (v.json) return printJson(list);
      if (!list.length) return console.log('no files');
      for (const f of list) {
        console.log(`${f.id}  ${when(f.modifiedTime)}  ${f.name}  [${f.mimeType.replace('application/vnd.google-apps.', 'google ')}]${f.owners?.[0] ? `  ${f.owners[0].emailAddress}` : ''}\n  ${f.webViewLink}`);
      }
    },
  },
  read: {
    help: 'a Drive file\'s text (id, URL or .gdoc): a Doc as txt (--format md), a Sheet as csv (first sheet), Slides as txt, a text file as is',
    options: { format: { type: 'string' } },
    async run(v, [arg]) {
      const { file, text } = await readFile(idOf(arg), { format: v.format });
      if (v.json) return printJson({ file, text });
      console.log(`# ${file.name}  (${file.webViewLink})\n\n${text}`);
    },
  },
  download: {
    help: 'save a Drive file into --out: a native file exported (--format docx|xlsx|pptx|pdf|csv|txt|md; default the office one), anything else as is',
    options: { out: { type: 'string' }, format: { type: 'string' } },
    async run(v, [arg]) {
      const { file } = await downloadFile(idOf(arg), outOf(v), { format: v.format });
      console.log(file);
    },
  },
  events: {
    help: 'calendar events: --from YYYY-MM-DD (default today), --to YYYY-MM-DD (default a week), --calendar <id|email> (default own)',
    options: { from: { type: 'string' }, to: { type: 'string' }, calendar: { type: 'string' } },
    async run(v) {
      const list = await listEvents({ from: v.from, to: v.to, calendar: v.calendar || 'primary' });
      if (v.json) return printJson(list);
      if (!list.length) return console.log('no events');
      for (const e of list) {
        const time = e.allDay ? `${e.start} all day` : `${when(e.start)}–${when(e.end).slice(-5)}`;
        console.log(`${time}  ${e.summary}${e.myResponse ? `  [${e.myResponse}]` : ''}${e.location ? `  @ ${e.location}` : ''}${e.attendees.length ? `  (${e.attendees.length} attendees)` : ''}`);
      }
    },
  },
};

for (const [name, c] of Object.entries(api)) {
  commands[name] = c.always ? c : {
    ...c,
    run(...a) {
      if (!apiOn()) throw new UsageError(API_OFF);
      return c.run(...a);
    },
  };
}

Object.assign(commands, {
  mail: {
    help: 'Gmail search with the search box\'s operators (from: subject: after:2026/09/01 has:attachment …): newest first, --limit',
    options: { limit: { type: 'string' } },
    async run(v, words) {
      if (!words.length) throw new UsageError('a Gmail query is required, e.g. mail from:someone@example.com after:2026/09/01');
      const list = await mailRoute().searchMail(words.join(' '), { limit: limitOf(v) });
      if (v.json) return printJson(list);
      if (!list.length) return console.log('no messages');
      for (const m of list) console.log(`${m.id}  ${when(m.date)}  ${m.from}\n  ${m.subject}${m.snippet ? `\n  ${m.snippet}` : ''}`);
    },
  },
  message: {
    help: 'one Gmail message (or --thread: the whole thread of that message or thread id): headers, text, attachments',
    options: { thread: { type: 'boolean' } },
    async run(v, [id]) {
      if (!id) throw new UsageError('a message id is required (from mail)');
      let list;
      if (v.thread) {
        const r = mailRoute();
        list = await r.readThread(id).catch(async () => r.readThread((await r.readMessage(id)).thread));
      } else list = [await mailRoute().readMessage(id)];
      if (v.json) return printJson(v.thread ? list : list[0]);
      for (const m of list) {
        console.log(`--- ${m.id}  ${when(m.date)}\nFrom: ${m.from}\nTo: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ''}\nSubject: ${m.subject}\n\n${m.text}`);
        for (const a of m.attachments) console.log(`[attachment] ${a.name} (${a.type}, ${Math.round(a.size / 1024)} KB)`);
      }
    },
  },
  attachment: {
    help: 'save a message\'s attachments into --out (all, or --name part of the file name)',
    options: { out: { type: 'string' }, name: { type: 'string' } },
    async run(v, [id]) {
      if (!id) throw new UsageError('a message id is required (from mail)');
      for (const f of await mailRoute().saveAttachments(id, outOf(v), { name: v.name })) console.log(f);
    },
  },
  install: {
    help: `the mail route's libraries (${imap.MAIL_DEPENDENCIES}): a plan by default, --yes installs`,
    options: { yes: { type: 'boolean' } },
    async run(v) {
      if (toolDependenciesInstalled('google')) return console.log('installed: tools/google/node_modules');
      console.log(`would install ${imap.MAIL_DEPENDENCIES} (npm install --prefix tools/google)`);
      if (!v.yes) return console.log('plan only; run again with --yes');
      installToolDependencies('google');
      console.log('installed');
    },
  },
  whoami: {
    help: 'the Google account of each route set up here: mail over IMAP (signs in to check), the API sign-in when on (never the secrets)',
    async run(v) {
      const out = { mail: null, api: apiOn() ? status() : 'off' };
      if (imap.mailConfigured()) {
        try {
          out.mail = await imap.mailStatus();
        } catch (e) {
          if (!(e instanceof UsageError)) throw e;
          out.mail = { account: imap.mailAccount(), error: e.message };
        }
      }
      if (v.json) return printJson(out);
      const m = out.mail;
      console.log(!m ? 'mail: no app password (node oikos/tools/setup/cli.mjs token GMAIL_APP_PASSWORD); mail goes through the browser'
        : m.error ? `mail: ${m.account || '?'} — ${m.error}`
          : `mail: ${m.account} over IMAP (${m.host}), ${m.messages} messages in ${m.mailbox}, read-only`);
      if (out.api === 'off') console.log('api: off (OIKOS_GOOGLE_API)');
      else if (!out.api.client) console.log(`api: no OAuth client (${clientFile()})`);
      else console.log(`api: ${out.api.account || 'not signed in'}  scopes: ${out.api.scopes.join(', ') || 'none'}`);
      return m && !m.error ? 0 : 1;
    },
  },
});

if (isMain(import.meta.url)) runCli('google', commands, { connector: 'google' });
