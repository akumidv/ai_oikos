#!/usr/bin/env node
// Vault: the notes of the wiki mounts (ADR 0007 D04) — search, read, create, append, replace-section.
// A vault is a `use: wiki` mount of the installation (oikos.yaml `mounts:` or `.local/mounts.yaml`); this
// tool is the one route that writes into a mount, and only a `.md` note into the vault's inbox or a
// folder below its root. Every write has --dry-run, goes through the content check (common/outgoing.mjs)
// with the vault's rules and has no override flag: the way past a finding is an `allow:` line of
// `.local/outgoing.yaml`, which the user writes. Committing a vault is the user's.
import { readFileSync } from 'node:fs';
import { runCli, printJson, UsageError } from '../common/cli.mjs';
import { config } from '../common/config.mjs';
import { usableWikis } from '../common/mounts.mjs';
import { guardOutgoing } from '../common/outgoing.mjs';
import { appendToPage, findSection, replaceSection } from '../common/sections.mjs';
import {
  checkRequired, composeNote, findNote, judgeTarget, noteFolder, noteName, noteRules, pickWiki, readNote, searchNotes, vaultRules, writeNote,
} from '../common/vault.mjs';

const TOOL = 'vault';
const RULE = '-'.repeat(40);
/** The lines of a note shown around an appended section in a dry run. */
const CONTEXT_LINES = 10;

/** The configuration's mounts and problems, the usable wikis among them and every wiki mount. */
function wikis() {
  const { mounts, problems } = config();
  return { mounts, problems, usable: usableWikis(mounts, problems), all: mounts.filter((m) => m.wiki) };
}

/** The wiki a command without a note means (`--wiki`, the default, the only one). */
function chosenWiki(v) {
  const ctx = wikis();
  return { ...ctx, mount: pickWiki(ctx.usable, v.wiki, ctx) };
}

/**
 * The note `--note` means: in the wiki `--wiki` names, else in whichever usable wiki has it — one must.
 * @returns {{mount: object, rel: string, mounts: object[]}}
 */
function locate(v) {
  if (!v.note) throw new UsageError('--note is required (a path from the vault\'s root, or a note name)');
  const ctx = wikis();
  const candidates = v.wiki ? [pickWiki(ctx.usable, v.wiki, ctx)] : ctx.usable;
  const found = candidates.flatMap((mount) => {
    const rel = findNote(mount, v.note);
    return rel === null ? [] : [{ mount, rel }];
  });
  if (found.length > 1) throw new UsageError(`the note ${JSON.stringify(v.note)} is in several wikis (${found.map((f) => f.mount.wiki.name).join(', ')}) — name one with --wiki`);
  if (!found.length) throw new UsageError(`no note ${JSON.stringify(v.note)} in ${v.wiki ? `the wiki '${v.wiki}'` : `any wiki (${candidates.map((m) => m.wiki.name).join(', ')})`}`);
  return { ...found[0], mounts: ctx.mounts };
}

/** The markdown a write sends: `--text`, or the content of `--file`. */
function bodyText(v, { required }) {
  const text = v.file ? readFileSync(v.file, 'utf8') : v.text;
  if (required && !text) throw new UsageError('--text or --file is required (markdown)');
  return text ?? '';
}

/** `text`'s last (or with `atStart` first) lines, with a note of what was left out. */
function context(text, atStart) {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length <= CONTEXT_LINES) return lines;
  const cut = `… (${lines.length - CONTEXT_LINES} more line(s) not shown)`;
  return atStart ? [...lines.slice(0, CONTEXT_LINES), cut] : [cut, ...lines.slice(-CONTEXT_LINES)];
}

/** The lines `search` prints for one wiki's result `r`: its titles and lines, each hit with a line of context. */
function searchLines(r, v) {
  const lines = [`## ${r.wiki} (${r.path})`];
  if (v.title) lines.push(`Titles matching "${v.title}":`, ...(r.titles.length ? r.titles.map((f) => `  ${f}`) : ['  (none)']));
  if (v.query) {
    lines.push(`Lines containing "${v.query}":`);
    for (const h of r.hits) {
      if (h.before !== null) lines.push(`  ${h.file}-${h.line - 1}- ${h.before.slice(0, 160)}`);
      lines.push(`  ${h.file}:${h.line}: ${h.text.slice(0, 160)}`);
      if (h.after !== null) lines.push(`  ${h.file}-${h.line + 1}- ${h.after.slice(0, 160)}`);
    }
    if (!r.hits.length) lines.push('  (none)');
  }
  lines.push(`${r.titles.length} title(s), ${r.hits.length} line(s) in ${r.wiki}${r.more ? ` … ${r.more} more not shown (raise --limit)` : ''}\n`);
  return lines;
}

/**
 * The frame every write shares: the content check of the vault's rules over `change.texts`, then a dry run
 * (printed, nothing written) or the write through a temporary file renamed into place.
 * @param {object} v the command's values
 * @param {{mount: object, target: object, rules: object, current: string|null, next: string, texts: object[], preview: string[]}} change
 */
function apply(v, change) {
  const { mount, target, current, next } = change;
  guardOutgoing(change.texts, v, vaultRules(mount, change.rules), { flags: false });
  if (v['dry-run']) {
    console.log('--- DRY RUN (requested --dry-run) ---');
    console.log(`Vault: ${mount.wiki.name} (${mount.path}, ${mount.layer} layer)`);
    console.log(`Note: ${target.rel} (${current === null ? 'new' : 'exists'})`);
    for (const line of change.preview) console.log(line);
    if (current === next) console.log('(no change: the note already reads so — the write would change nothing)');
    console.log('DRY RUN — nothing written to the vault.');
    return 0;
  }
  if (current === next) {
    console.log(`No change: ${target.rel} already reads so; nothing written.`);
    return 0;
  }
  writeNote(target, next);
  console.log(`${current === null ? 'Created' : 'Updated'} ${target.rel} in the wiki '${mount.wiki.name}' (${mount.path}) — not committed: committing a vault is the user's.`);
  return 0;
}

const noteOptions = { note: { type: 'string' }, wiki: { type: 'string' } };
const writeOptions = { 'dry-run': { type: 'boolean' } };

const commands = {
  search: {
    help: 'find notes by title and/or text in the wikis (--title text | --query text, --wiki name, --limit); each hit names its vault',
    options: { title: { type: 'string' }, query: { type: 'string' }, wiki: { type: 'string' }, limit: { type: 'string' } },
    run(v) {
      if (!v.title && !v.query) throw new UsageError('--title or --query is required');
      const limit = Number(v.limit || 25);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive number, got ${v.limit}`);
      const ctx = wikis();
      const selected = v.wiki ? [pickWiki(ctx.usable, v.wiki, ctx)] : ctx.usable;
      const results = selected.map((mount) => ({ wiki: mount.wiki.name, path: mount.path, ...searchNotes(mount, { title: v.title, query: v.query, limit }) }));
      if (v.json) return printJson(results);
      for (const r of results) console.log(searchLines(r, v).join('\n'));
      return 0;
    },
  },

  read: {
    help: 'the current text of one note (--note path-or-name, --wiki name)',
    options: { ...noteOptions },
    run(v) {
      const { mount, rel, mounts } = locate(v);
      const text = readNote(judgeTarget(mount, mounts, rel, { write: false }));
      if (v.json) return printJson({ wiki: mount.wiki.name, path: rel, text });
      console.log(`# ${rel}\n(wiki '${mount.wiki.name}', ${mount.path})\n\n${text.trim() || '(empty note)'}`);
      return 0;
    },
  },

  create: {
    help: 'create a note (--title "Name", --wiki name, --folder path below the vault root, default wiki.inbox, --text|--file markdown, --dry-run) — from wiki.template, front matter checked against wiki.rules; refused when it exists',
    options: { title: { type: 'string' }, wiki: { type: 'string' }, folder: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, ...writeOptions },
    run(v) {
      if (!v.title) throw new UsageError('--title is required (the note\'s name)');
      const { mount, mounts } = chosenWiki(v);
      const rules = noteRules(mount);
      const target = judgeTarget(mount, mounts, `${noteFolder(mount, v.folder)}/${noteName(v.title)}`);
      if (target.exists) throw new UsageError(`the note ${target.rel} exists already; edit it with append or replace-section instead`);
      const note = composeNote(mount, { title: v.title.trim(), text: bodyText(v, { required: false }) });
      checkRequired(note.front, rules, mount.wiki.name);
      return apply(v, {
        mount, target, rules, current: null, next: note.text,
        texts: [{ label: 'title', text: v.title }, { label: 'path', text: target.rel }, { label: 'frontmatter', text: note.front }, { label: 'body', text: note.body }],
        preview: [`New note text${mount.wiki.template ? ` (from ${mount.wiki.template})` : ''}:`, RULE, note.text.replace(/\n$/, ''), RULE],
      });
    },
  },

  append: {
    help: 'append a markdown section to an existing note (--note, --wiki, --heading, --heading-level, --text|--file, --at-start, --dry-run)',
    options: { ...noteOptions, heading: { type: 'string' }, 'heading-level': { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, 'at-start': { type: 'boolean' }, ...writeOptions },
    run(v) {
      const { mount, rel, mounts } = locate(v);
      const text = bodyText(v, { required: true });
      const target = judgeTarget(mount, mounts, rel);
      const current = readNote(target);
      const level = Number(v['heading-level'] || 2);
      const next = appendToPage(current, text, { heading: v.heading, level, atStart: Boolean(v['at-start']) });
      const where = v['at-start'] ? 'start' : 'end';
      const section = `${v.heading ? `${'#'.repeat(level)} ${v.heading.trim()}\n\n` : ''}${text.trim()}`;
      return apply(v, {
        mount, target, rules: noteRules(mount), current, next,
        texts: [{ label: 'path', text: target.rel }, { label: 'heading', text: v.heading }, { label: 'section', text }],
        preview: [`Current ${where} of the note:`, RULE, ...context(current, v['at-start']), RULE, `Section that WOULD be inserted at the ${where} of the note:`, RULE, section, RULE],
      });
    },
  },

  'replace-section': {
    help: 'replace the body under an existing heading, up to the next heading of the same or higher level (--note, --wiki, --heading, --text|--file, --dry-run)',
    options: { ...noteOptions, heading: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, ...writeOptions },
    run(v) {
      if (!v.heading) throw new UsageError('--heading is required (the exact heading text)');
      const { mount, rel, mounts } = locate(v);
      const text = bodyText(v, { required: true });
      const target = judgeTarget(mount, mounts, rel);
      const current = readNote(target);
      const section = findSection(current, v.heading);
      const old = current.split(/\r?\n/).slice(section.bodyStart, section.bodyEnd).join('\n').trim();
      const next = replaceSection(current, v.heading, text);
      return apply(v, {
        mount, target, rules: noteRules(mount), current, next,
        texts: [{ label: 'path', text: target.rel }, { label: 'section', text }],
        preview: [`Section "${section.text}" (level ${section.level}, ${section.bodyEnd - section.bodyStart} line(s)). Current text:`, RULE, old || '(empty)', RULE, 'Would become:', RULE, text.trim(), RULE],
      });
    },
  },
};

runCli(TOOL, commands, { connector: TOOL });
