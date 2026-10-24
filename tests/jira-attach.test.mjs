// Jira `attach` (npm test), against canned answers (fake-fetch.mjs) in a copy of examples/installation:
// local files are uploaded to a task by the path rule of image lines — inside the installation, a
// working folder of .local/ included, never a dot-named store there (ADR 0002 D01) nor a dot-named file
// or folder elsewhere (.claude/, .mcp.json, .git/) — of an allowlist of types (no archive), at most
// 10 MB each. The dry run lists name, size and type and whether the task already
// has an attachment of that name and size (not uploaded again), offline too, and writes nothing; the
// write reads the attachments back and exits 2 when a file is not among them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation, tempDir, tool, withFakeFetch } from './helpers/installation.mjs';

const SITE = 'https://acme.atlassian.net';
const API = `${SITE}/rest/api/3`;
const CREDS = { JIRA_EMAIL: 'ada@acme.example', JIRA_API_TOKEN: 'fake-token' };
const REPORT = '# Report\n\nAll green.\n';
const ATTACHMENTS = `${API}/issue/PROJ-15?fields=attachment`;
const UPLOAD = `${API}/issue/PROJ-15/attachments`;

/** report.md in the installation's root and notes.csv in .local/cv/ (a working folder). */
function files(dir) {
  writeFileSync(join(dir, 'report.md'), REPORT);
  mkdirSync(join(dir, '.local', 'cv'));
  writeFileSync(join(dir, '.local', 'cv', 'notes.csv'), 'a,b\n1,2\n');
}

function run(routes, args, { creds = CREDS, setup = files } = {}) {
  const dir = installation((t) => t);
  setup(dir);
  const fake = withFakeFetch(dir, routes);
  const r = tool(dir, 'jira', args, { ...creds, ...fake.env }, fake);
  return { ...r, dir, calls: fake.calls() };
}

const writesOf = (calls) => calls.filter((c) => c.method !== 'GET');
/** The attachments of PROJ-15, answered once (the read before the write), or always. */
const attachments = (list, times) => ({ url: ATTACHMENTS, ...(times ? { times } : {}), body: { key: 'PROJ-15', fields: { attachment: list } } });
const uploaded = (id, filename, size) => ({ method: 'POST', url: UPLOAD, times: 1, body: [{ id, filename, size }] });
const ARGS = ['attach', '--task', 'PROJ-15', '--file', 'report.md', '--file', '.local/cv/notes.csv'];

test('attach --dry-run lists each file with its size and type, names one already there, and writes nothing', () => {
  const r = run([attachments([{ id: '10400', filename: 'notes.csv', size: 8 }])], [...ARGS, '--dry-run']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Files that WOULD be attached:$/m);
  assert.match(r.stdout, new RegExp(`^ {2}report\\.md → report\\.md \\(${REPORT.length} bytes, text/markdown\\) — uploaded to PROJ-15$`, 'm'));
  assert.match(r.stdout, /^ {2}\.local\/cv\/notes\.csv → notes\.csv \(8 bytes, text\/csv\) — skipped: PROJ-15 has an attachment of that name and size \(id 10400\)$/m);
  assert.match(r.stdout, /DRY RUN — nothing written to Jira\./);
  assert.deepEqual(writesOf(r.calls), []);
});

test('attach --dry-run without credentials reads nothing and says the write needs them', () => {
  const r = run([], [...ARGS, '--dry-run'], { creds: {} });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /report\.md \(\d+ bytes, text\/markdown\) — uploaded, or skipped when the task has an attachment of that name and size \(not read offline\)/);
  assert.match(r.stdout, /no Jira credentials — the write itself needs them/);
  assert.deepEqual(r.calls, []);
});

test('attach uploads each file as one multipart part of its type, then prints each by its id as read back', () => {
  const after = [{ id: '10500', filename: 'report.md', size: REPORT.length }, { id: '10501', filename: 'notes.csv', size: 8 }];
  const r = run([attachments([], 1), uploaded('10500', 'report.md', REPORT.length), uploaded('10501', 'notes.csv', 8), attachments(after)], ARGS);
  assert.equal(r.status, 0, r.output);
  const writes = writesOf(r.calls);
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url}`), [`POST ${UPLOAD}`, `POST ${UPLOAD}`]);
  assert.match(writes[0].body, /filename="report\.md"\r\nContent-Type: text\/markdown\r\n\r\n# Report/);
  assert.match(writes[1].body, /filename="notes\.csv"\r\nContent-Type: text\/csv\r\n/);
  assert.match(r.stdout, /^Attachments of PROJ-15, read back:\n {2}\[10500\] report\.md \(\d+ bytes\)\n {2}\[10501\] notes\.csv \(8 bytes\)$/m);
  assert.equal(r.calls.at(-1).url, ATTACHMENTS);
});

test('attach does not upload a file the task already has by name and size, and still reads it back', () => {
  const there = [{ id: '10400', filename: 'report.md', size: REPORT.length }];
  const r = run([attachments(there)], ['attach', '--task', 'PROJ-15', '--file', 'report.md']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(writesOf(r.calls), []);
  assert.match(r.stdout, /Reusing attachment report\.md/);
  assert.match(r.stdout, /^ {2}\[10400\] report\.md/m);
});

test('attach: a file Jira took but the task does not show exits 2, naming it', () => {
  const r = run([attachments([], 1), uploaded('10500', 'report.md', REPORT.length), attachments([])], ['attach', '--task', 'PROJ-15', '--file', 'report.md']);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stdout, /report\.md: attachment 10500 is NOT on PROJ-15/);
  assert.match(r.stderr, /NOT CONFIRMED: report\.md not among the attachments of PROJ-15/);
});

test('attach: a failed upload exits 2 after the others are attached and read back', () => {
  const failing = { method: 'POST', url: UPLOAD, times: 1, status: 413, body: 'too large' };
  const after = [{ id: '10501', filename: 'notes.csv', size: 8 }];
  const r = run([attachments([], 1), failing, uploaded('10501', 'notes.csv', 8), attachments(after)], ARGS);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /report\.md: not attached — HTTP 413/);
  assert.match(r.stdout, /^ {2}\[10501\] notes\.csv \(8 bytes\)$/m);
});

test('attach refuses, before any request, a type off the list, a file over 10 MB, a store of .local/, a path outside, and a bare path', () => {
  const outside = join(tempDir('elsewhere-'), 'x.md');
  writeFileSync(outside, 'x');
  const setup = (dir) => {
    writeFileSync(join(dir, 'run.exe'), 'MZ');
    writeFileSync(join(dir, 'pack.zip'), 'PK');
    writeFileSync(join(dir, 'big.pdf'), Buffer.alloc(10 * 1024 * 1024 + 1));
    mkdirSync(join(dir, '.local', '.secrets'));
    writeFileSync(join(dir, '.local', '.secrets', 'key.txt'), 'secret');
    writeFileSync(join(dir, '.env.yaml'), 'X: 1');
    writeFileSync(join(dir, 'report.md'), REPORT);
  };
  const cases = [
    [['--file', 'run.exe'], /Refusing file 'run\.exe': the type \.exe is not attached; only \.md, .* files are attached\./],
    [['--file', 'pack.zip'], /Refusing file 'pack\.zip': the type \.zip is not attached/],
    [['--file', 'big.pdf'], /Refusing file 'big\.pdf': it is 10485761 bytes, over the 10485760-byte limit of one file\./],
    [['--file', '.local/.secrets/key.txt'], /Refusing file '\.local\/\.secrets\/key\.txt': it is in \.local\/\.secrets, a closed store/],
    [['--file', '.env.yaml'], /\.env\.yaml is a \.env file, never read/],
    [['--file', outside], /resolves outside the installation\./],
    [['--file', 'report.md', 'other.md'], /each file takes its own --file: --file other\.md/],
    [[], /--file PATH is required/],
  ];
  for (const [extra, why] of cases) {
    for (const dry of [[], ['--dry-run']]) {
      const r = run([attachments([])], ['attach', '--task', 'PROJ-15', ...extra, ...dry], { setup });
      assert.equal(r.status, 1, `${extra}: ${r.output}`);
      assert.match(r.stderr, why, extra.join(' '));
      assert.deepEqual(r.calls, [], extra.join(' '));
    }
  }
});

test('attach refuses, before any request, a file under a dot-named file or folder outside the working folders of .local/', () => {
  const setup = (dir) => {
    writeFileSync(join(dir, '.mcp.json'), '{}');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'notes.txt'), 'x');
    mkdirSync(join(dir, 'docs', '.drafts'), { recursive: true });
    writeFileSync(join(dir, 'docs', '.drafts', 'plan.md'), 'x');
    symlinkSync(join(dir, '.claude', 'settings.local.json'), join(dir, 'settings.json'));
  };
  const cases = [
    ['.mcp.json', '.mcp.json'],
    ['.claude/settings.local.json', '.claude'],
    ['.git/notes.txt', '.git'],
    ['docs/.drafts/plan.md', '.drafts'],
    ['settings.json', '.claude'],
  ];
  for (const [file, dotted] of cases) {
    for (const dry of [[], ['--dry-run']]) {
      const r = run([attachments([])], ['attach', '--task', 'PROJ-15', '--file', file, ...dry], { setup });
      assert.equal(r.status, 1, `${file}: ${r.output}`);
      const quoted = file.replace(/\./g, '\\.');
      assert.match(r.stderr, new RegExp(`Refusing file '${quoted}': it is under ${dotted.replace(/\./g, '\\.')}, a dot-named file or folder`), file);
      assert.deepEqual(r.calls, [], file);
    }
  }
});

test('attach takes a file inside a working folder of .local/, a dot-named folder within it included', () => {
  const setup = (dir) => {
    mkdirSync(join(dir, '.local', 'cv', '.drafts'), { recursive: true });
    writeFileSync(join(dir, '.local', 'cv', '.drafts', 'plan.md'), 'x');
  };
  const r = run([], ['attach', '--task', 'PROJ-15', '--file', '.local/cv/.drafts/plan.md', '--dry-run'], { creds: {}, setup });
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^ {2}\.local\/cv\/\.drafts\/plan\.md → plan\.md \(1 bytes, text\/markdown\)/m);
});
