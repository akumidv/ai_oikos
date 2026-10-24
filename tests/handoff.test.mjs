// `handoff park` and `list` (npm test, ADR 0005 D01–D03), in a copy of examples/installation with
// the session scratchpad faked as a temporary folder (TMPDIR): the package folder is the task key
// lowercased or a slug, never a closed or legacy store name of .local/; --from is judged by the path
// rule of `jira attach` (tools/common/local-files.mjs) — inside the installation or the scratchpad,
// never a home path, a closed store, an .env file or a dot-named entry outside a working folder of
// .local/ — and one refusal copies nothing; without --yes nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installation, tempDir, tool } from './helpers/installation.mjs';

const DRAFT = '# Review of the API draft\n\nTwo points left.\n';

/** An installation and a scratchpad with draft-review.md and notes/ (two files). */
function setup() {
  const dir = installation((t) => t);
  const scratch = tempDir('scratch-');
  writeFileSync(join(scratch, 'draft-review.md'), DRAFT);
  mkdirSync(join(scratch, 'notes'));
  writeFileSync(join(scratch, 'notes', 'a.md'), 'a\n');
  writeFileSync(join(scratch, 'notes', 'b.md'), 'bb\n');
  const park = (args) => tool(dir, 'handoff', ['park', ...args], { TMPDIR: scratch });
  return { dir, scratch, park, local: (...p) => join(dir, '.local', ...p) };
}

/** The --from arguments of the scratchpad's draft-review.md and notes/. */
const fromArgs = (scratch) => ['--from', join(scratch, 'draft-review.md'), '--from', join(scratch, 'notes')];

test('park without --yes says what it would copy and write, and changes nothing', () => {
  const s = setup();
  const r = s.park(['--task', 'PROJ-123', '--title', 'Review of the API draft', ...fromArgs(s.scratch)]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Would park PROJ-123 in \.local\/proj-123\/:$/m);
  assert.match(r.stdout, /^ {2}draft-review\.md ← .*draft-review\.md: \d+ bytes — 1 new$/m);
  assert.match(r.stdout, /^ {2}notes\/ ← .*notes: 2 files, 5 bytes — 2 new$/m);
  assert.match(r.stdout, /^ {4}- PROJ-123 · Review of the API draft · parked · \[handoff\]\(proj-123\/HANDOFF\.md\)$/m);
  assert.match(r.stdout, /preview only — nothing written; --yes parks it/);
  assert.deepEqual(readdirSync(s.local()), []);
});

test('park --yes copies into .local/<key-lowercase>/, writes the skeleton and the backlog line, prints the prompt', () => {
  const s = setup();
  const r = s.park(['--task', 'proj-123', '--title', 'Review of the API draft', ...fromArgs(s.scratch), '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(s.local('proj-123', 'draft-review.md'), 'utf8'), DRAFT);
  assert.equal(readFileSync(s.local('proj-123', 'notes', 'b.md'), 'utf8'), 'bb\n');
  const handoff = readFileSync(s.local('proj-123', 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /^# PROJ-123 — Review of the API draft$/m);
  const headings = [...handoff.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['Where things are', 'Agreed rules', 'Decisions', 'Next steps', 'How to start']);
  assert.match(handoff, /^- `draft-review\.md` — \d+ bytes: <what it is>$/m);
  assert.match(handoff, /^- `notes\/` — 2 files, 5 bytes: <what it is>$/m);
  const prompt = 'Resume PROJ-123: read .local/proj-123/HANDOFF.md and continue from "Next steps".';
  assert.ok(handoff.includes(prompt));
  assert.equal(readFileSync(s.local('TASKS.md'), 'utf8'), '- PROJ-123 · Review of the API draft · parked · [handoff](proj-123/HANDOFF.md)\n');
  assert.equal(r.stdout.trim().split('\n').at(-1), prompt);
});

test('park --name takes a slug for work with no key, lowercased', () => {
  const s = setup();
  const r = s.park(['--name', 'Api-Review', '--title', 'Draft', '--from', join(s.scratch, 'draft-review.md'), '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.ok(existsSync(s.local('api-review', 'draft-review.md')));
  assert.match(readFileSync(s.local('TASKS.md'), 'utf8'), /^- api-review · Draft · parked · \[handoff\]\(api-review\/HANDOFF\.md\)$/m);
});

test('park refuses a dot name, a legacy store name in any case, a path-like name and a non-key', () => {
  const s = setup();
  for (const args of [['--name', '.secrets'], ['--name', 'browser'], ['--name', 'Google'], ['--task', '.PROJ-1'], ['--name', '../x'], ['--task', 'acme/tools#24']]) {
    const r = s.park([...args, '--from', join(s.scratch, 'draft-review.md'), '--yes']);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.output}`);
    assert.match(r.stderr, /closed store name|not a path|not a task key/, args.join(' '));
  }
  assert.match(s.park(['--name', 'Google', '--from', 'x']).stderr, /Refusing package 'Google': it is a closed store name of \.local\//);
  assert.deepEqual(readdirSync(s.local()), []);
});

test('park refuses a home path, ~/.ssh included, and a path outside the installation and the scratchpad', () => {
  const s = setup();
  const outside = tempDir('outside-');
  writeFileSync(join(outside, 'x.md'), 'x\n');
  const cases = [
    ['~/.ssh', /a home or network path is not read/],
    [join(homedir(), '.ssh'), /Refusing --from/],
    [join(outside, 'x.md'), /it resolves outside the installation or the session scratchpad/],
  ];
  for (const [from, why] of cases) {
    const r = s.park(['--task', 'PROJ-123', '--from', join(s.scratch, 'draft-review.md'), '--from', from, '--yes']);
    assert.equal(r.status, 1, `${from}: ${r.output}`);
    assert.match(r.stderr, why, from);
  }
  assert.deepEqual(readdirSync(s.local()), []);
});

test('park refuses a folder holding an .env file or a dot-named entry, and copies nothing', () => {
  const s = setup();
  writeFileSync(join(s.scratch, 'notes', '.env.local'), 'TOKEN=x\n');
  let r = s.park(['--task', 'PROJ-123', '--from', join(s.scratch, 'draft-review.md'), '--from', join(s.scratch, 'notes'), '--yes']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing --from '.*notes' \(notes\/\.env\.local\): \.env\.local is a \.env file, never read\. Nothing was copied\./);
  assert.deepEqual(readdirSync(s.local()), []);

  const other = tempDir('scratch-dot-');
  mkdirSync(join(other, 'notes', '.cache'), { recursive: true });
  writeFileSync(join(other, 'notes', '.cache', 'x.md'), 'x\n');
  r = tool(s.dir, 'handoff', ['park', '--task', 'PROJ-123', '--from', join(other, 'notes'), '--yes'], { TMPDIR: other });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /it is under \.cache, a dot-named file or folder/);
});

test('park takes a dot-named entry inside a working folder of .local/', () => {
  const s = setup();
  mkdirSync(s.local('cv', '.drafts'), { recursive: true });
  writeFileSync(s.local('cv', '.drafts', 'v1.md'), 'v1\n');
  const r = s.park(['--task', 'PROJ-123', '--from', '.local/cv', '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(s.local('proj-123', 'cv', '.drafts', 'v1.md'), 'utf8'), 'v1\n');
});

test('park refuses a closed store of .local/, by name or through a symlink in the scratchpad', () => {
  const s = setup();
  mkdirSync(s.local('.secrets', 'google'), { recursive: true });
  writeFileSync(s.local('.secrets', 'google', 'token.json'), '{}');
  mkdirSync(s.local('browser'));
  writeFileSync(s.local('browser', 'Cookies.txt'), 'c\n');
  symlinkSync(s.local('.secrets', 'google', 'token.json'), join(s.scratch, 'token.json'));
  for (const from of ['.local/.secrets/google/token.json', '.local/browser', join(s.scratch, 'token.json')]) {
    const r = s.park(['--task', 'PROJ-123', '--from', from, '--yes']);
    assert.equal(r.status, 1, `${from}: ${r.output}`);
    assert.match(r.stderr, /a closed store of the installation's private \.local\/ folder/, from);
  }
  assert.ok(!existsSync(s.local('proj-123')));
});

test('park refuses a name taken by other content unless --replace; the same content is left as it is', () => {
  const s = setup();
  assert.equal(s.park(['--task', 'PROJ-123', '--title', 'T', ...fromArgs(s.scratch), '--yes']).status, 0);
  writeFileSync(join(s.scratch, 'notes', 'a.md'), 'changed\n');
  let r = s.park(['--task', 'PROJ-123', ...fromArgs(s.scratch), '--yes']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing to park: \.local\/proj-123\/notes\/a\.md exists with other content \(--replace overwrites it\)\. Nothing was copied\./);
  assert.equal(readFileSync(s.local('proj-123', 'notes', 'a.md'), 'utf8'), 'a\n');
  r = s.park(['--task', 'PROJ-123', ...fromArgs(s.scratch), '--replace', '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /notes\/ ← .*: 2 files, \d+ bytes — 1 replaced, 1 unchanged/);
  assert.equal(readFileSync(s.local('proj-123', 'notes', 'a.md'), 'utf8'), 'changed\n');
});

test('park upserts the backlog line by key: replaced, appended to a file without a final newline, other lines kept', () => {
  const s = setup();
  const from = ['--from', join(s.scratch, 'draft-review.md')];
  writeFileSync(s.local('TASKS.md'), '# my tasks\n- PROJ-123 · Old title · active\n- PROJ-7 · Other · parked · [handoff](proj-7/HANDOFF.md)');
  let r = s.park(['--task', 'PROJ-123', '--title', 'New title', ...from, '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /\.local\/TASKS\.md: the line replaced/);
  assert.equal(readFileSync(s.local('TASKS.md'), 'utf8'),
    '# my tasks\n- PROJ-123 · New title · parked · [handoff](proj-123/HANDOFF.md)\n- PROJ-7 · Other · parked · [handoff](proj-7/HANDOFF.md)');
  r = s.park(['--task', 'PROJ-9', ...from, '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /\.local\/TASKS\.md: the line appended/);
  assert.equal(readFileSync(s.local('TASKS.md'), 'utf8'),
    '# my tasks\n- PROJ-123 · New title · parked · [handoff](proj-123/HANDOFF.md)\n- PROJ-7 · Other · parked · [handoff](proj-7/HANDOFF.md)\n'
    + '- PROJ-9 · untitled · parked · [handoff](proj-9/HANDOFF.md)\n');
  r = s.park(['--task', 'PROJ-123', ...from, '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /\.local\/TASKS\.md: the line already there/);
  assert.match(readFileSync(s.local('TASKS.md'), 'utf8'), /^- PROJ-123 · New title · parked/m);
});

test('park keeps an existing HANDOFF.md and names the files to add to it', () => {
  const s = setup();
  mkdirSync(s.local('proj-123'));
  writeFileSync(s.local('proj-123', 'HANDOFF.md'), '# PROJ-123 — filled by the agent\n');
  const r = s.park(['--task', 'PROJ-123', ...fromArgs(s.scratch), '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /HANDOFF\.md: kept as it is — add the newly copied files under "Where things are"/);
  assert.equal(readFileSync(s.local('proj-123', 'HANDOFF.md'), 'utf8'), '# PROJ-123 — filled by the agent\n');
  assert.ok(existsSync(s.local('proj-123', 'notes', 'a.md')));
});

test('list shows the parked packages from the backlog and the folders, never a closed store', () => {
  const s = setup();
  assert.match(tool(s.dir, 'handoff', ['list']).stdout, /no parked packages/);
  assert.equal(s.park(['--task', 'PROJ-123', '--title', 'Review', ...fromArgs(s.scratch), '--yes']).status, 0);
  mkdirSync(s.local('loose'));
  writeFileSync(s.local('loose', 'HANDOFF.md'), '# loose\n');
  mkdirSync(s.local('.browser'));
  writeFileSync(s.local('.browser', 'HANDOFF.md'), '# no\n');
  const r = tool(s.dir, 'handoff', ['list']);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'loose  (no line in .local/TASKS.md) — .local/loose/HANDOFF.md',
    'proj-123  PROJ-123 · Review · parked — .local/proj-123/HANDOFF.md',
  ]);
});
