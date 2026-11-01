// The content check of outgoing text (ADR 0003, npm test): one finding per category from the pure
// `outgoingFindings`, the installation's `.local/outgoing.yaml` (terms, allow), and the check as the
// write tools run it — a flagged dry run shows its preview and exits 3 (`flagged: content check:`),
// the real run refuses (`refused: content check:`, exit 3) unless `--allow-flagged` is in both runs,
// a secret is masked, withheld from the preview and never overridden by the flag, a binary attachment
// is checked by its name only; and the read-only `outgoing check`. Canned answers only (fake-fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation, tool, withFakeFetch } from './helpers/installation.mjs';
import { GuardRefusal } from '../tools/common/cli.mjs';
import { BUILT_IN_RULES, EXECUTABLE_KINDS, MIN_ALLOW_LENGTH, allowedPasses, checkLines, checkOutgoing, maskSecret, nonLatinLetters, outgoingFindings, outgoingRules, viewsOf } from '../tools/common/outgoing.mjs';

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

test('language: Greek letters are the symbols of a formula, not a finding; other scripts beside them still are', () => {
  assert.deepEqual(categories('the rate is α·Δt + σ², with ω = 2πf'), []);
  assert.deepEqual(categories('ἀρχή and ά'), []);
  assert.deepEqual(categories('α is the learning rate, готово'), ['language']);
  assert.equal(nonLatinLetters('αβγ Привет'), 'Пвеирт');
});

test('assistant: the name, its files and command line, a skill in path form — not a bare skill name', () => {
  for (const text of ['set up by oikos', 'see oikos.yaml', 'OIKOS.md says', 'OIKOS_HOME=/srv', 'run node oikos/tools/jira/cli.mjs', 'skills/wiki/SKILL.md', 'the SKILL.md file']) {
    assert.deepEqual(categories(text), ['assistant'], text);
  }
  assert.deepEqual(categories('update the wiki and the documents'), []);
});

test('path: a home folder, a Windows or WSL path, /tmp/, the scratchpad, .local/, file://', () => {
  for (const text of ['/home/ada/notes.md', '/Users/ada/x', 'C:\\Users\\ada', '/mnt/d/Users/ada', '\\\\wsl$\\Ubuntu', '/tmp/x.log', 'in the scratchpad', 'in .local/cv', 'file://server/share']) {
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

test('allow: an entry drops a secret only when it contains the secret; other categories keep the line rule (D-ALLOW-SECRET)', () => {
  const other = `ghp_${'b'.repeat(36)}`;
  const rules = (...allow) => ({ ...BUILT_IN_RULES, allow });
  const line = `use ${TOKEN} for the job in /tmp/x`;
  assert.deepEqual(categories(line, rules('for the job')), ['secret'], 'a phrase on the line drops the path, not the secret');
  assert.deepEqual(categories(line, rules(TOKEN.slice(0, 12))), ['secret'], 'a part of the secret does not contain it');
  assert.deepEqual(categories(line, rules(TOKEN)), [], 'an entry holding the secret drops it, and the line is allowed');
  const two = outgoingFindings(`${TOKEN} and ${other}`, rules(TOKEN));
  assert.deepEqual(two.map((f) => f.match), [other], 'every secret on the line needs its own entry');
});

test('secret: a token followed by more characters is still caught', () => {
  for (const tail of ['x', '_x', 'abc', '0']) assert.deepEqual(categories(`${TOKEN}${tail}`), ['secret'], tail);
  assert.deepEqual(categories(`AKIA${'A'.repeat(16)}_x`), ['secret']);
  assert.deepEqual(categories(`id ghp_${'a'.repeat(35)}`), [], 'a body one character short is not a token');
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

test('allow: an entry that is empty, not a string or shorter than MIN_ALLOW_LENGTH is a problem and is ignored; the others count', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), `allow: ["", "   ", 42, "/tmp/", "1234567", "12345678", "  /tmp/ is the server's  "]\n`);
  const rules = outgoingRules(dir);
  assert.equal(MIN_ALLOW_LENGTH, 8);
  assert.deepEqual(rules.allow, ['12345678', '/tmp/ is the server\'s'], 'an entry of exactly the minimum counts, entries are trimmed');
  assert.deepEqual(rules.problems, [
    '.local/outgoing.yaml: allow: "" is empty — ignored',
    '.local/outgoing.yaml: allow: "   " is empty — ignored',
    '.local/outgoing.yaml: allow: 42 is not a string — ignored',
    '.local/outgoing.yaml: allow: "/tmp/" is shorter than 8 characters — ignored',
    '.local/outgoing.yaml: allow: "1234567" is shorter than 8 characters — ignored',
  ]);
  assert.deepEqual(categories('/tmp/x.log', rules), ['path'], 'a short entry lets nothing through');
  assert.deepEqual(outgoingRules(fresh()).problems, [], 'no file, no problem');
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'allow: "/tmp/ is the server\'s"\n');
  assert.throws(() => outgoingRules(dir), /allow: is a list of non-empty strings/, 'a list is still required');
});

test('allow: the check lists each line an entry let pass, with the entry; a secret-holding entry is masked', () => {
  const rules = { ...BUILT_IN_RULES, allow: ["/tmp/ is the server's", TOKEN] };
  const text = `fine\n/tmp/ is the server's scratch folder\nsee /tmp/x and /home/ada/a\nuse ${TOKEN} here\nuse ${TOKEN} and ghp_${'b'.repeat(36)}`;
  assert.deepEqual(allowedPasses(text, rules).map(({ line, entry }) => [line, entry === TOKEN ? 'TOKEN' : entry]), [
    [2, "/tmp/ is the server's"], [4, 'TOKEN'], [5, 'TOKEN'],
  ]);
  const check = checkOutgoing([{ label: 'comment', text }], rules);
  assert.equal(check.allowed, 3);
  const lines = checkLines(check);
  assert.ok(lines.includes('  3 line(s) let pass by allow: in .local/outgoing.yaml'));
  assert.ok(lines.includes(`  comment line 2: let pass by allow: "/tmp/ is the server's"  │ /tmp/ is the server's scratch folder`));
  assert.ok(lines.includes('  comment line 4: let pass by allow: "ghp_… (40 characters)"  │ use ghp_… (40 characters) here'));
  assert.ok(!lines.join('\n').includes(TOKEN), 'no secret is printed');
  assert.deepEqual(allowedPasses('/tmp/x', rules), [], 'a line nothing allows is not listed');
  assert.deepEqual(allowedPasses('/tmp/ is the server\'s', BUILT_IN_RULES), []);
});

test('outgoing.yaml of another shape is a usage error naming the key', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'terms: Globex\n');
  assert.throws(() => outgoingRules(dir), /terms: is a list of non-empty strings/);
});

test('sync reports an ignored allow: entry and an unreadable outgoing.yaml as problems', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'allow: ["tmp"]\n');
  const short = tool(dir, 'sync', ['--check'], {});
  assert.match(short.stdout, /^problem: \.local\/outgoing\.yaml: allow: "tmp" is shorter than 8 characters — ignored$/m);
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'terms: [unclosed\n');
  const broken = tool(dir, 'sync', ['--check'], {});
  assert.match(broken.stdout, /^problem: \.local\/outgoing\.yaml does not parse/m);
  assert.equal(broken.status, 1);
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

test('a secret is masked, the preview withheld, and --allow-flagged does not override it; an allow: entry holding it does', () => {
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

  // An entry that merely sits on the line does not let a secret pass; one that holds the secret does.
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'allow: ["for the job"]\n');
  const nearby = run(dir, [], [...args, '--dry-run'], { creds: {} });
  assert.equal(nearby.status, 3, nearby.output);
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), `allow: ["${TOKEN}"]\n`);
  const allowed = run(dir, [], [...args, '--dry-run'], { creds: {} });
  assert.equal(allowed.status, 0, allowed.output);
  assert.match(allowed.stdout, /1 line\(s\) let pass by allow: in \.local\/outgoing\.yaml/);
  assert.match(allowed.stdout, /^ {2}comment line 1: let pass by allow: "ghp_… \(40 characters\)" {2}│ Use the token ghp_… \(40 characters\) for the job$/m, 'the line and the entry are listed, masked');
});

test('a secret on a line with another finding is masked in the check block, the refusal and `outgoing check`', () => {
  const dir = fresh();
  const token = `ghp_${'a'.repeat(36)}`;
  const text = `token ${token} see /tmp/x and ${token}`;
  const args = ['comment', '--task', 'PROJ-15', '--text', text, '--allow-flagged'];
  const dry = run(dir, [], [...args, '--dry-run'], { creds: {} });
  assert.equal(dry.status, 3, dry.output);
  assert.match(dry.stdout, /comment line 1: path — \/tmp\/ {2}│ token ghp_… \(40 characters\) see \/tmp\/x and ghp_… \(40 characters\)/);
  assert.doesNotMatch(dry.output, /ghp_a{4}/);
  const real = run(dir, [POST_COMMENT], args.slice(0, -1));
  assert.equal(real.status, 3, real.output);
  assert.match(real.stderr, /^refused: content check: path, secret/);
  assert.match(real.stderr, /path — \/tmp\/ {2}│ token ghp_… \(40 characters\)/);
  assert.doesNotMatch(real.output, /ghp_a{4}/);
  assert.deepEqual(writesOf(real.calls), []);
  const check = tool(dir, 'outgoing', ['check', '--text', text], {});
  assert.equal(check.status, 3, check.output);
  assert.match(check.stdout, /│ token ghp_… \(40 characters\) see/);
  assert.doesNotMatch(check.output, /ghp_a{4}/);
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
  assert.deepEqual(JSON.parse(json.stdout), { findings: [{ line: 3, category: 'path', match: '/tmp/' }], allowed: 0, passes: [], problems: [] });
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'allow: ["the log is in /tmp/x.log", "tmp"]\n');
  const allowed = check(['--file', 'draft.md', '--json']);
  assert.equal(allowed.status, 0, allowed.output);
  assert.deepEqual(JSON.parse(allowed.stdout), {
    findings: [], allowed: 1, passes: [{ line: 3, entry: 'the log is in /tmp/x.log' }], problems: ['.local/outgoing.yaml: allow: "tmp" is shorter than 8 characters — ignored'],
  });
  const plain = check(['--file', 'draft.md']);
  assert.match(plain.stdout, /^ {2}file line 3: let pass by allow: "the log is in \/tmp\/x\.log" {2}│ the log is in \/tmp\/x\.log$/m);
  assert.match(plain.stdout, /^ {2}problem: \.local\/outgoing\.yaml: allow: "tmp" is shorter than 8 characters — ignored$/m);
  assert.equal(check([]).status, 1);
});

// -- normalised text (ADR 0007 D04, F13) ------------------------------------------------------

const WORDS = { ...BUILT_IN_RULES, terms: ['Globex', 'ACME Corp'] };
const kinds = (text, rules = WORDS) => outgoingFindings(text, rules).map((f) => `${f.line}:${f.category}`);

test('normalised: NFKC, zero-width characters and emphasis markup do not hide a word, in every category', () => {
  for (const text of ['Globex', 'GLOBEX', 'ＧＬＯＢＥＸ', 'Glo​bex', 'Glo­bex', 'Glo﻿be⁠x', '**Glo**bex', '_Glo_bex', 'G~~lo~~bex', '`Glo`bex', 'Glo<b>b</b>ex', 'Glo​**b**ex']) {
    assert.deepEqual(kinds(text), ['1:term'], JSON.stringify(text));
  }
  assert.deepEqual(kinds('about ACME **Corp**'), ['1:term'], 'a term with a space, split by markup');
  assert.deepEqual(kinds('set by **oikos** or ｏｉｋｏｓ'), ['1:assistant']);
  assert.deepEqual(kinds('OIKOS_HOME=/srv'), ['1:assistant'], 'a pattern that holds an underscore still matches as written');
  assert.deepEqual(kinds('in /ho​me/ada/x'), ['1:path']);
  assert.deepEqual(kinds('in /home/**ada**/x'), ['1:path']);
  assert.deepEqual(kinds(`token ghp_${'a1B2c3D4e5'.repeat(3)}ab​cdef`), ['1:secret']);
  assert.deepEqual(kinds('a globe, an excel sheet and some corp'), [], 'words that only share letters are not terms');
});

test('normalised: a word split across a line break is found — joined with a space, with nothing, or after a hyphen — and reported on the line it starts on', () => {
  assert.deepEqual(kinds('about Glo\nbex'), ['1:term']);
  assert.deepEqual(kinds('about Glo-\nbex'), ['1:term']);
  assert.deepEqual(kinds('about ACME\nCorp'), ['1:term'], 'a term with a space wrapped at it');
  assert.deepEqual(kinds('about ACME  \n  **Corp**'), ['1:term'], 'trailing and leading blanks and markup');
  assert.deepEqual(kinds('set by oi-\nkos'), ['1:assistant']);
  assert.deepEqual(kinds('fine\nthen Glo\nbex here\nand fine'), ['2:term']);
  assert.deepEqual(kinds('about Glo\n\nbex'), [], 'a blank line is a paragraph break, not a wrapped word');
  assert.deepEqual(kinds('Globex\nGlobex'), ['1:term', '2:term'], 'a word whole on each line is found once per line, not again across the break');
  assert.deepEqual(kinds('the e-\nmail is fine'), []);
});

test('normalised: the masked line never prints a secret the text hid behind an invisible character or markup', () => {
  const hidden = `use ghp_${'a1B2c3D4e5'.repeat(3)}ab​cdef now`;
  const check = checkOutgoing([{ label: 'text', text: `${hidden}\nin /tmp/x ghp_${'a1B2c3D4e5'.repeat(3)}ab**cd**ef` }], BUILT_IN_RULES);
  const printed = checkLines(check).join('\n');
  assert.doesNotMatch(printed, /a1B2c3D4e5/, printed);
  assert.match(printed, /ghp_… \(40 characters\)/);
});

test('normalised: allow: entries are matched against the line as written and as normalised', () => {
  const rules = { ...BUILT_IN_RULES, allow: ['/tmp/ is the server'] };
  assert.deepEqual(categories('**/tmp/** is the server', rules), []);
  assert.deepEqual(categories('/tmp/ is the server', rules), []);
  assert.equal(allowedPasses('**/tmp/** is the server', rules).length, 1);
});

test('rules: patterns are the installation\'s own shapes (category term); off switches a category; refuse names the executable kinds', () => {
  const rules = { ...BUILT_IN_RULES, patterns: [/\bPROJ-\d+\b/], off: ['assistant'], refuse: ['script', 'template-tag'] };
  assert.deepEqual(kinds('PROJ-123 is the task', rules), ['1:term']);
  assert.deepEqual(kinds('PROJ is no key, PROJECT-1 is another', rules), []);
  assert.deepEqual(kinds('by oikos', rules), [], 'assistant is off');
  assert.deepEqual(kinds('in /home/ada/x by oikos', rules), ['1:path']);
  assert.deepEqual(kinds('a <SCRIPT src=x> and <% tp %>', rules), ['1:executable']);
  assert.equal(outgoingFindings('a <script>', rules)[0].match, 'script');
  assert.deepEqual(kinds('a <script> and <iframe>', BUILT_IN_RULES), [], 'no kinds refused, nothing is found');
});

test('every write command takes the normalised text: a jira comment with a term split by markup, a zero-width character or a line break is flagged', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'terms: [Globex]\n');
  for (const text of ['about **Glo**bex', 'about Glo​bex', 'about Glo-\nbex']) {
    const dry = run(dir, [], ['comment', '--task', 'PROJ-15', '--text', text, '--dry-run'], { creds: {} });
    assert.equal(dry.status, 3, `${JSON.stringify(text)}: ${dry.output}`);
    assert.match(dry.stderr, /^flagged: content check: term/m);
    const real = run(dir, [POST_COMMENT], ['comment', '--task', 'PROJ-15', '--text', text]);
    assert.equal(real.status, 3, real.output);
    assert.deepEqual(writesOf(real.calls), []);
  }
});

test('the read-only outgoing check takes the normalised text too', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.local', 'outgoing.yaml'), 'terms: [Globex]\n');
  const r = tool(dir, 'outgoing', ['check', '--text', 'about Glo​**b**ex'], {});
  assert.equal(r.status, 3, r.output);
  assert.match(r.stdout, /term — Globex/);
});

// -- audit fixes of the vault check: remote embeds, allow:, whitespace, linked terms ---------------

const REFUSING = { ...BUILT_IN_RULES, refuse: Object.keys(EXECUTABLE_KINDS) };

test('executable: a remote embed is found in every spelling — srcset, poster, a reference-style image, a tag split over lines, CSS url(), an entity-encoded address', () => {
  const remote = {
    '<img srcset="https://cdn.example.com/p.png 1x">': '1:executable',
    '<img srcset="a.png 1x, https://cdn.example.com/p.png 2x">': '1:executable',
    '<img srcset=//cdn.example.com/p.png>': '1:executable',
    '<video poster="https://cdn.example.com/p.png"></video>': '1:executable',
    '![a][r]\n\n[r]: https://cdn.example.com/p.png': '1:executable',
    'text\n![R]\n\n[r]: <https://cdn.example.com/p.png>': '2:executable',
    '![a][]\n\n[a]:\n  //cdn.example.com/p.png': '1:executable',
    'text\n<img\n  alt="a"\n  src="https://cdn.example.com/p.png">': '2:executable',
    '![a](\nhttps://cdn.example.com/p.png)': '1:executable',
    '<div style="background:url(https://cdn.example.com/p.png)">x</div>': '1:executable',
    '<div style="background:url(\'//cdn.example.com/p.png\')">x</div>': '1:executable',
    '<style>@import "https://cdn.example.com/a.css";</style>': '1:executable',
    '<img src="&#104;ttps://cdn.example.com/p.png">': '1:executable',
    '<img src="https&colon;//cdn.example.com/p.png">': '1:executable',
  };
  for (const [text, expected] of Object.entries(remote)) {
    assert.deepEqual(kinds(text, REFUSING), [expected], JSON.stringify(text));
    assert.equal(outgoingFindings(text, REFUSING)[0].match, 'remote-embed', JSON.stringify(text));
  }
});

test('executable: ordinary notes still pass — local images, plain links, reference links, local CSS, an escaped tag, an ampersand', () => {
  const ordinary = [
    '![](img/a.png) and ![[a.png]] and ![alt](img/a.png "title")',
    'a [link](https://example.com) and <https://example.com> and https://example.com/a.png',
    '![a][r]\n\n[r]: img/a.png',
    'see [the page][r]\n\n[r]: https://example.com/page',
    '[r]: https://example.com/unused',
    '<img src="img/a.png" srcset="img/a.png 1x, img/b.png 2x" alt="x">',
    '<div style="background:url(img/a.png)">x</div>',
    'Tom & Jerry, R&D, AT&amp;T, a &lt;script&gt; tag and &#60;script&#62; as text',
    '![[a.png]]\n![a][b]\n\n[b]: attachments/b.png',
  ];
  for (const text of ordinary) assert.deepEqual(kinds(text, REFUSING), [], JSON.stringify(text));
});

test('executable: an allow: entry lifts no executable finding, as it lifts no secret; the line is not listed as let pass', () => {
  const rules = { ...REFUSING, allow: ['Project Phoenix'] };
  assert.deepEqual(kinds('Project Phoenix <script>alert(1)</script>', rules), ['1:executable']);
  assert.deepEqual(kinds('Project Phoenix ![a](https://cdn.example.com/p.png)', rules), ['1:executable']);
  assert.deepEqual(allowedPasses('Project Phoenix <script>alert(1)</script>', rules), [], 'nothing was let through');
  assert.deepEqual(kinds('Project Phoenix in /home/ada/x', rules), [], 'another category is still lifted');
  assert.equal(allowedPasses('Project Phoenix in /home/ada/x', rules).length, 1);
});

test('normalised: runs of blanks, no-break and other Unicode spaces, space entities and numeric entities do not hide a term; underscores keep their meaning', () => {
  const rules = { ...BUILT_IN_RULES, terms: ['Acme Corp'] };
  for (const text of ['Acme  Corp', 'Acme   \t Corp', 'Acme&nbsp;Corp', 'Acme&NBSP;Corp', 'Acme Corp', 'Acme Corp', 'Acme Corp', 'Acme⠀Corp',
    'Acme&#32;Corp', 'Acme&#x20;Corp', 'Acme&#160;Corp', 'Acme&emsp;Corp', 'Acme&#10;Corp', 'Acme​Corp', 'Acme​ ​Corp', 'Ac&#109;e Corp', 'AcmeCorp']) {
    assert.deepEqual(kinds(text, rules), ['1:term'], JSON.stringify(text));
  }
  assert.deepEqual(kinds('Acme and Corp', rules), [], 'two words apart are no term');
  assert.deepEqual(kinds('Tom &amp; Jerry &copy; R&D &#xZZ; &#99999999; &constructor; &toString &__proto__;', rules), [], 'an entity of no word of ours is no finding');
  assert.deepEqual(viewsOf('a &constructor; b'), ['a &constructor; b'], 'an inherited property name is no entity');
  assert.deepEqual(kinds('OIKOS_HOME is set', BUILT_IN_RULES), ['1:assistant']);
  assert.deepEqual(kinds(`ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`, BUILT_IN_RULES), ['1:secret']);
});

/** A linked installation (it has an oikos.yaml) with `content` as its `.local/outgoing.yaml`, or without the file. */
const linkedWith = (content) => {
  const other = fresh();
  if (content !== undefined) writeFileSync(join(other, '.local', 'outgoing.yaml'), content);
  return { path: 'linked', root: other };
};

test('outgoingRules: a linked installation whose terms file does not read refuses — a GuardRefusal that names the file; a missing file adds nothing', () => {
  const root = fresh();
  const refusal = (e) => e instanceof GuardRefusal && /^refused: content check: the terms file .*outgoing\.yaml of a linked installation cannot be used/.test(e.message);
  const broken = linkedWith('terms: [unclosed\n');
  assert.throws(() => outgoingRules(root, { mounts: [broken] }), (e) => refusal(e) && e.message.includes(join(broken.root, '.local', 'outgoing.yaml')) && /does not parse/.test(e.message));
  assert.throws(() => outgoingRules(root, { mounts: [linkedWith('terms: just-text\n')] }), refusal, 'a terms: that is not a list');
  const folder = linkedWith();
  mkdirSync(join(folder.root, '.local', 'outgoing.yaml'));
  assert.throws(() => outgoingRules(root, { mounts: [folder] }), refusal, 'a file that cannot be read');
  assert.deepEqual(outgoingRules(root, { mounts: [linkedWith()] }).terms.filter((t) => !t.startsWith('/')), [], 'a missing file: no terms, no error');
  assert.ok(outgoingRules(root, { mounts: [linkedWith('terms: [Initech]\n')] }).terms.includes('Initech'), 'a good file adds its terms');
});
