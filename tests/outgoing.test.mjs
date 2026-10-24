// The content check of outgoing text (ADR 0003, npm test): one finding per category from the pure
// `outgoingFindings`, the installation's `.local/outgoing.yaml` (terms, allow), and the check as the
// write tools run it — a flagged dry run shows its preview and exits 3 (`flagged: content check:`),
// the real run refuses (`refused: content check:`, exit 3) unless `--allow-flagged` is in both runs,
// a secret is masked, withheld from the preview and never overridden by the flag, a binary attachment
// is checked by its name only; and the read-only `outgoing check`. Canned answers only (fake-fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';
import { BUILT_IN_RULES, maskSecret, outgoingFindings, outgoingRules } from '../tools/common/outgoing.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
// Assembled, so no token-shaped literal sits in the repository.
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
const POST_COMMENT = { method: 'POST', url: `${API}/issue/PROJ-15/comment`, status: 201, body: { id: '9' } };

const categories = (text, rules = BUILT_IN_RULES) => outgoingFindings(text, rules).map((f) => f.category);

function run(dir, routes, args, { creds = CREDS } = {}) {
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...creds, ...fake.env }, fake);
  return { ...r, calls: fake.calls() };
}
const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');
const fresh = () => installation((t) => t);

// -- the categories -------------------------------------------------------------------------

test('language: non-Latin letters are a finding, Latin with diacritics is not', () => {
  assert.deepEqual(categories('Готово'), ['language']);
  assert.deepEqual(categories('Café déjà vu, Zürich'), []);
});

test('assistant: the name, its files and command line, a skill in path form — not a bare skill name', () => {
  for (const text of ['set up by oikos', 'see oikos.yaml', 'OIKOS.md says', 'OIKOS_HOME=/srv', 'run node oikos/tools/jira/cli.mjs', 'skills/wiki/SKILL.md', 'the SKILL.md file']) {
    assert.deepEqual(categories(text), ['assistant'], text);
  }
  assert.deepEqual(categories('update the wiki and the documents'), []);
});

test('path: a home folder, a Windows or WSL path, /tmp/, the scratchpad, .local/, file://', () => {
  for (const text of ['/home/ada/notes.md', '/Users/ada/x', 'C:\\Users\\ada', '/mnt/c/Users/ada', '\\\\wsl$\\Ubuntu', '/tmp/x.log', 'in the scratchpad', 'in .local/cv', 'file://server/share']) {
    assert.deepEqual(categories(text), ['path'], text);
  }
  assert.deepEqual(categories('https://example.com/docs/page'), []);
});

test('secret: token prefixes with a token body, a private-key block, a JWT shape', () => {
  const secrets = [
    TOKEN, `github_pat_${'x'.repeat(30)}`, `glpat-${'y'.repeat(20)}`, `xoxb-${'1'.repeat(12)}`, `ATATT${'z'.repeat(24)}`,
    `AKIA${'A'.repeat(16)}`, '-----BEGIN RSA PRIVATE KEY-----', `eyJ${'a'.repeat(10)}.eyJ${'b'.repeat(10)}.${'c'.repeat(10)}`,
  ];
  for (const text of secrets) assert.deepEqual(categories(text), ['secret'], text.slice(0, 6));
  assert.deepEqual(categories('the commit ghp is a word; akia too'), []);
  assert.equal(maskSecret(TOKEN), 'ghp_… (40 characters)');
});

test('term: the installation\'s own words, ignoring case; allow: drops a line that holds an allowed string', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'terms: [Globex]\nallow: ["/tmp/ is the server\'s"]\n');
  const rules = outgoingRules(dir);
  assert.deepEqual(categories('a note for GLOBEX', rules), ['term']);
  assert.deepEqual(categories('/tmp/ is the server\'s scratch folder', rules), []);
  assert.deepEqual(categories('/tmp/ elsewhere', rules), ['path']);
  assert.deepEqual(outgoingRules(fresh()), BUILT_IN_RULES, 'no file: the built-in patterns only');
});

test('outgoing.yaml of another shape is a usage error naming the key', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'terms: Globex\n');
  assert.throws(() => outgoingRules(dir), /terms: is a list of non-empty strings/);
});

// -- the check in a write command (jira comment) ------------------------------------------------

test('a flagged dry run prints the findings and the preview, exits 3 with flagged:; the real run refuses with refused:', () => {
  const dir = fresh();
  const text = 'Notes are in /home/ada/notes.md\nand in oikos.yaml.';
  const dry = run(dir, [], ['comment', '--task', 'PROJ-15', '--text', text, '--dry-run'], { creds: {} });
  assert.equal(dry.status, 3, dry.output);
  assert.match(dry.stderr, /^flagged: content check: path, assistant — /);
  assert.match(dry.stdout, /^ {2}comment line 1: path — \/home\/ada\//m);
  assert.match(dry.stdout, /^ {2}comment line 2: assistant — oikos\.yaml/m);
  assert.match(dry.stdout, /^Comment that WOULD be posted:$/m, 'the preview is still shown');
  const real = run(dir, [POST_COMMENT], ['comment', '--task', 'PROJ-15', '--text', text]);
  assert.equal(real.status, 3, real.output);
  assert.match(real.stderr, /^refused: content check: path, assistant — nothing written/);
  assert.deepEqual(writesOf(real.calls), []);
});

test('--allow-flagged in both runs: the dry run marks the findings overridden and exits 0, the real run posts', () => {
  const dir = fresh();
  const args = ['comment', '--task', 'PROJ-15', '--text', 'Notes are in /home/ada/notes.md', '--allow-flagged'];
  const dry = run(dir, [], [...args, '--dry-run'], { creds: {} });
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /comment line 1: path — .*\(overridden\)$/m);
  const real = run(dir, [POST_COMMENT], args);
  assert.equal(real.status, 0, real.output);
  assert.equal(writesOf(real.calls).length, 1);
});

test('a secret is masked, the preview withheld, and --allow-flagged does not override it; an allow: entry does', () => {
  const dir = fresh();
  const args = ['comment', '--task', 'PROJ-15', '--text', `Use the token ${TOKEN} for the job`, '--allow-flagged'];
  const dry = run(dir, [], [...args, '--dry-run'], { creds: {} });
  assert.equal(dry.status, 3, dry.output);
  assert.match(dry.stderr, /^flagged: content check: secret — preview withheld/);
  assert.match(dry.stdout, /comment line 1: secret — ghp_… \(40 characters\)/);
  assert.doesNotMatch(dry.output, new RegExp(TOKEN));
  assert.doesNotMatch(dry.stdout, /Comment that WOULD be posted/);
  const real = run(dir, [POST_COMMENT], args);
  assert.equal(real.status, 3, real.output);
  assert.match(real.stderr, /^refused: content check: secret/);
  assert.doesNotMatch(real.output, new RegExp(TOKEN));
  assert.deepEqual(writesOf(real.calls), []);

  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'allow: ["for the job"]\n');
  const allowed = run(dir, [], [...args, '--dry-run'], { creds: {} });
  assert.equal(allowed.status, 0, allowed.output);
  assert.match(allowed.stdout, /1 line\(s\) let pass by allow: in \.local\/outgoing\.yaml/);
});

test('a --file whose markdown link points at a local file is a path finding', () => {
  const dir = fresh();
  writeFileSync(join(dir, 'note.md'), '# Status\n\nSee [the notes](file:///home/ada/notes.md).\n');
  const r = run(dir, [], ['comment', '--task', 'PROJ-15', '--file', 'note.md', '--dry-run'], { creds: {} });
  assert.equal(r.status, 3, r.output);
  assert.match(r.stdout, /^ {2}comment line 3: path — \/home\/ada\/ {2}│ See \[the notes\]\(file:/m);
  writeFileSync(join(dir, 'note.md'), 'See [the share](file://server/notes.md).\n');
  const share = run(dir, [], ['comment', '--task', 'PROJ-15', '--file', 'note.md', '--dry-run'], { creds: {} });
  assert.match(share.stdout, /^ {2}comment line 1: path — file:\/\//m);
});

test('an uploaded image is checked by its name and alt text, its local path is not sent and not flagged', () => {
  const dir = fresh();
  writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'note.md'), 'The screen:\n\n![the export screen](shot.png)\n');
  const r = run(dir, [], ['comment', '--task', 'PROJ-15', '--file', 'note.md', '--dry-run'], { creds: {} });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}image shot\.png: content not checked/m);
});

test('the transition --comment is checked in the dry run too', () => {
  const dir = fresh();
  const r = run(dir, [], ['transition', '--task', 'PROJ-15', '--to', 'In Progress', '--comment', 'see /tmp/run.log', '--dry-run']);
  assert.match(r.stderr, /^flagged: content check: path/, r.output);
  assert.match(r.stdout, /comment line 1: path — \/tmp\//);
  const real = run(dir, [], ['transition', '--task', 'PROJ-15', '--to', 'In Progress', '--comment', 'see /tmp/run.log']);
  assert.equal(real.status, 3, real.output);
  assert.match(real.stderr, /^refused: content check: path/);
  assert.deepEqual(real.calls, [], 'refused before any request');
});

test('attach: a binary file is checked by its name only and said so; a text file is checked as text', () => {
  const dir = fresh();
  writeFileSync(join(dir, 'report.pdf'), '%PDF-1.4 /home/ada/ inside is not read\n');
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nfrom /home/ada/notes\n');
  const pdf = run(dir, [], ['attach', '--task', 'PROJ-15', '--file', 'report.pdf', '--dry-run'], { creds: {} });
  assert.equal(pdf.status, 0, pdf.output);
  assert.match(pdf.stdout, /^ {2}report\.pdf: content not checked \(not text\) — only its name$/m);
  const md = run(dir, [], ['attach', '--task', 'PROJ-15', '--file', 'notes.md', '--dry-run'], { creds: {} });
  assert.equal(md.status, 3, md.output);
  assert.match(md.stdout, /^ {2}notes\.md line 3: path — \/home\/ada\//m);
});

// -- the read-only check -----------------------------------------------------------------------

test('outgoing check: clean text exits 0, a flagged draft exits 3 with flagged:, --file and --json too', () => {
  const dir = fresh();
  const check = (args) => tool(dir, 'outgoing', ['check', ...args], {});
  const clean = check(['--text', 'The export is ready for review.']);
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.stdout, /^CHECK outgoing text: clean$/m);
  const flagged = check(['--text', `ready, token ${TOKEN}`]);
  assert.equal(flagged.status, 3, flagged.output);
  assert.match(flagged.stderr, /^flagged: content check: secret/);
  assert.doesNotMatch(flagged.output, new RegExp(TOKEN));
  writeFileSync(join(dir, 'draft.md'), 'Hello team,\n\nthe log is in /tmp/x.log\n');
  const json = check(['--file', 'draft.md', '--json']);
  assert.equal(json.status, 3, json.output);
  assert.deepEqual(JSON.parse(json.stdout), { findings: [{ line: 3, category: 'path', match: '/tmp/' }], allowed: 0 });
  assert.equal(check([]).status, 1);
});
