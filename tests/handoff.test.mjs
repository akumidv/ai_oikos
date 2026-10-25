// `handoff park` and `list` (npm test, ADR 0005 D01–D03), in a copy of examples/installation with
// the session scratchpad faked under a temporary folder (TMPDIR): the package folder is the task key
// lowercased or a slug, never a closed or legacy store name of .local/; --from is judged by the path
// rule of `jira attach` (tools/common/local-files.mjs) — inside the installation, its session
// scratchpad or $OIKOS_SCRATCH (D-PARK-SCRATCH), nothing else in the temporary folder,
// never a home path, a closed store, an .env file or a dot-named entry outside a working folder of
// .local/ — and one refusal copies nothing; without --yes nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installation, tempDir, tool } from './helpers/installation.mjs';
import { projectSlug, sourceOf } from '../tools/handoff/cli.mjs';

const DRAFT = '# Review of the API draft\n\nTwo points left.\n';

/**
 * A temporary folder (the TMPDIR to run with) holding the Claude Code session scratchpad of the
 * installation `dir`: `<tmp>/claude-<uid>/<slug>/<session>/scratchpad`.
 */
function claudeScratch(dir, project = projectSlug(realpathSync(dir)), session = 'session-1') {
  const tmp = tempDir('tmp-');
  const scratch = join(tmp, `claude-${process.getuid()}`, project, session, 'scratchpad');
  mkdirSync(scratch, { recursive: true });
  return { tmp, scratch };
}

/** An installation and its session scratchpad with draft-review.md and notes/ (two files). */
function setup() {
  const dir = installation((t) => t);
  const { tmp, scratch } = claudeScratch(dir);
  writeFileSync(join(scratch, 'draft-review.md'), DRAFT);
  mkdirSync(join(scratch, 'notes'));
  writeFileSync(join(scratch, 'notes', 'a.md'), 'a\n');
  writeFileSync(join(scratch, 'notes', 'b.md'), 'bb\n');
  const park = (args, env = {}) => tool(dir, 'handoff', ['park', ...args], { TMPDIR: tmp, ...env });
  return { dir, tmp, scratch, park, local: (...p) => join(dir, '.local', ...p) };
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
    [join(outside, 'x.md'), /it resolves outside the installation, this installation's session scratchpad \(.*scratchpad\) or \$OIKOS_SCRATCH/],
  ];
  for (const [from, why] of cases) {
    const r = s.park(['--task', 'PROJ-123', '--from', join(s.scratch, 'draft-review.md'), '--from', from, '--yes']);
    assert.equal(r.status, 1, `${from}: ${r.output}`);
    assert.match(r.stderr, why, from);
  }
  assert.deepEqual(readdirSync(s.local()), []);
});

test('park refuses the temporary folder itself as a source, and takes a file inside it', () => {
  const s = setup();
  for (const from of [s.scratch, `${s.scratch}/notes/..`]) {
    const r = s.park(['--task', 'PROJ-123', '--from', from, '--yes']);
    assert.equal(r.status, 1, `${from}: ${r.output}`);
    assert.match(r.stderr, /Refusing --from '.*': it is a scratch folder itself — name a file or folder inside it\. Nothing was copied\./, from);
  }
  assert.deepEqual(readdirSync(s.local()), []);
  const r = s.park(['--task', 'PROJ-123', '--from', join(s.scratch, 'draft-review.md'), '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(s.local('proj-123', 'draft-review.md'), 'utf8'), DRAFT);
});

test('sourceOf refuses a file of another owner in the temporary folder, inside a folder and through a symlink, and judges only there', () => {
  const s = setup();
  symlinkSync(join(s.scratch, 'notes', 'a.md'), join(s.scratch, 'link.md'));
  const mine = process.getuid?.();
  const roots = (uid, extra = {}) => ({ base: s.scratch, allowed: [s.scratch], locals: [], install: null, where: 'the scratchpad', scratch: realpathSync(s.scratch), uid, ...extra });
  // The files are the current user's, so a user one apart stands for "another owner".
  const foreign = (mine ?? 0) + 1;
  for (const from of ['draft-review.md', 'notes', 'link.md']) {
    assert.throws(() => sourceOf(from, roots(foreign)), /Refusing --from '[^']*'.*: it is owned by user \d+, not by you \(user \d+\) — a file in a scratch folder is carried only when it is yours\. Nothing was copied\./, from);
  }
  assert.throws(() => sourceOf('notes', roots(foreign)), /\(notes\/a\.md\)/, 'the refused file inside the folder is named');
  if (mine !== undefined) assert.equal(sourceOf('notes', roots(mine)).files.length, 2, 'the current user\'s files are accepted');
  assert.equal(sourceOf('notes', roots(undefined)).files.length, 2, 'no user id (Windows): no owner check');
  assert.equal(sourceOf('draft-review.md', roots(foreign, { scratch: null })).files.length, 1, 'outside the scratchpad nothing is judged');
  assert.equal(sourceOf('draft-review.md', roots(foreign, { install: realpathSync(s.scratch) })).files.length, 1, 'a file of the installation is not judged');
});

test('park refuses a folder holding an .env file or a dot-named entry, and copies nothing', () => {
  const s = setup();
  writeFileSync(join(s.scratch, 'notes', '.env.local'), 'TOKEN=x\n');
  let r = s.park(['--task', 'PROJ-123', '--from', join(s.scratch, 'draft-review.md'), '--from', join(s.scratch, 'notes'), '--yes']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing --from '.*notes' \(notes\/\.env\.local\): \.env\.local is a \.env file, never read\. Nothing was copied\./);
  assert.deepEqual(readdirSync(s.local()), []);

  const other = claudeScratch(s.dir);
  mkdirSync(join(other.scratch, 'notes', '.cache'), { recursive: true });
  writeFileSync(join(other.scratch, 'notes', '.cache', 'x.md'), 'x\n');
  r = tool(s.dir, 'handoff', ['park', '--task', 'PROJ-123', '--from', join(other.scratch, 'notes'), '--yes'], { TMPDIR: other.tmp });
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

// == scratch sources: this installation's session scratchpad or $OIKOS_SCRATCH, and nothing else in the temporary folder ==

/** The park of `from`, in the installation of `s`, with the environment `env` on top of its TMPDIR. */
const parkFrom = (s, from, env = {}) => s.park(['--task', 'PROJ-123', '--from', from, '--yes'], env);

test('park takes a file of this installation\'s session scratchpad, in any session folder', () => {
  const s = setup();
  const later = claudeScratch(s.dir, undefined, 'another-session');
  writeFileSync(join(later.scratch, 'later.md'), 'later\n');
  const r = parkFrom(s, join(later.scratch, 'later.md'), { TMPDIR: later.tmp });
  assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(s.local('proj-123', 'later.md'), 'utf8'), 'later\n');
});

test('park takes a path inside $OIKOS_SCRATCH, not the folder itself, and names a refused or missing one', () => {
  const s = setup();
  const named = tempDir('named-');
  writeFileSync(join(named, 'work.md'), 'w\n');
  const here = { TMPDIR: tempDir('empty-tmp-'), OIKOS_SCRATCH: named };
  let r = parkFrom(s, join(named, 'work.md'), here);
  assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(s.local('proj-123', 'work.md'), 'utf8'), 'w\n');
  r = parkFrom(s, named, here);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /it is a scratch folder itself — name a file or folder inside it\. Nothing was copied\./);
  // Unset, the same file is outside every root; set to a missing folder, the refusal names the value.
  r = parkFrom(s, join(named, 'work.md'), { TMPDIR: here.TMPDIR });
  assert.match(r.stderr, /it resolves outside the installation, this installation's session scratchpad \(.*scratchpad\) or \$OIKOS_SCRATCH\. Nothing was copied\./);
  const missing = join(named, 'missing');
  r = parkFrom(s, join(named, 'work.md'), { TMPDIR: here.TMPDIR, OIKOS_SCRATCH: missing });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, new RegExp(`not taken as a source root: \\$OIKOS_SCRATCH ${missing} does not exist`));
});

test('park refuses another project\'s scratchpad and a loose file of the temporary folder', () => {
  const s = setup();
  const foreign = claudeScratch(s.dir, projectSlug('/home/ada/work/other-project'));
  writeFileSync(join(foreign.scratch, 'theirs.md'), 't\n');
  mkdirSync(join(foreign.tmp, 'oikos-hooks'));
  writeFileSync(join(foreign.tmp, 'oikos-hooks', 'state.json'), '{}');
  writeFileSync(join(foreign.tmp, 'loose.md'), 'l\n');
  for (const from of [join(foreign.scratch, 'theirs.md'), join(foreign.tmp, 'oikos-hooks', 'state.json'), join(foreign.tmp, 'loose.md')]) {
    const r = parkFrom(s, from, { TMPDIR: foreign.tmp });
    assert.equal(r.status, 1, `${from}: ${r.output}`);
    assert.match(r.stderr, /Refusing --from '.*': it resolves outside the installation, this installation's session scratchpad \(.*[/\\]claude-\d+[/\\].*[/\\]<session>[/\\]scratchpad\) or \$OIKOS_SCRATCH\. Nothing was copied\./, from);
  }
  assert.deepEqual(readdirSync(s.local()), []);
});

test('park does not follow a session folder whose scratchpad is a symlink out of the temporary folder', () => {
  const s = setup();
  const out = tempDir('out-');
  writeFileSync(join(out, 'x.md'), 'x\n');
  const lead = claudeScratch(s.dir);
  rmSync(lead.scratch, { recursive: true });
  symlinkSync(out, lead.scratch, 'dir');
  const r = parkFrom(s, join(out, 'x.md'), { TMPDIR: lead.tmp });
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /not taken as a source root: .* leads out of /);
});

// == $TMPDIR as a source root: the temporary folder can be moved onto the user's secrets ==

/** A fake home with `.ssh/id_rsa`, and the park of `from` with TMPDIR at `tmp` and HOME at that home. */
function withHome() {
  const s = setup();
  const home = tempDir('home-');
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
  const parkWith = (env, from) => parkFrom(s, from, { HOME: home, ...env });
  return { ...s, home, parkWith };
}

test('park takes no source from a temporary folder that lies in or is the home folder', () => {
  const s = withHome();
  for (const tmp of [join(s.home, '.ssh'), s.home]) {
    // The scratchpad of this installation exists there too, and is no root either.
    const pad = join(tmp, `claude-${process.getuid()}`, projectSlug(realpathSync(s.dir)), 'session-1', 'scratchpad');
    mkdirSync(pad, { recursive: true });
    writeFileSync(join(pad, 'mine.md'), 'm\n');
    for (const from of [join(s.home, '.ssh', 'id_rsa'), join(pad, 'mine.md')]) {
      const r = s.parkWith({ TMPDIR: tmp }, from);
      assert.equal(r.status, 1, `${tmp}: ${r.output}`);
      assert.match(r.stderr, /Refusing --from '.*': it resolves outside the installation, .*; not taken as a source root: the temporary folder .* is, holds or lies in the home folder .*\. Nothing was copied\./, tmp);
      assert.ok(r.stderr.includes(realpathSync(tmp)), 'the refusal names the temporary folder');
    }
  }
  assert.deepEqual(readdirSync(s.local()), []);
});

test('park takes no source from a temporary folder or $OIKOS_SCRATCH inside a .local/ folder or the home folder, and no closed store of another installation', () => {
  const s = withHome();
  const other = tempDir('other-');
  mkdirSync(join(other, '.local', 'browser'), { recursive: true });
  mkdirSync(join(other, '.local', '.secrets'));
  writeFileSync(join(other, '.local', 'browser', 'Cookies.txt'), 'c\n');
  writeFileSync(join(other, '.local', '.secrets', 'token'), 't\n');
  // The temporary folder is another installation's .local/: nothing in it is a source.
  for (const from of [join(other, '.local', 'browser', 'Cookies.txt'), join(other, '.local', '.secrets', 'token')]) {
    const r = s.parkWith({ TMPDIR: join(other, '.local') }, from);
    assert.equal(r.status, 1, `${from}: ${r.output}`);
    assert.match(r.stderr, /not taken as a source root: .* lies inside a \.local\/ folder/, from);
    assert.match(s.parkWith({ OIKOS_SCRATCH: join(other, '.local') }, from).stderr, /not taken as a source root: \$OIKOS_SCRATCH .* lies inside a \.local\/ folder/, from);
  }
  assert.match(s.parkWith({ OIKOS_SCRATCH: s.home }, join(s.home, '.ssh', 'id_rsa')).stderr, /\$OIKOS_SCRATCH .* is, holds or lies in the home folder/);
  // $OIKOS_SCRATCH is the other installation: a closed store of its .local/ is still no source, directly or through a symlink.
  symlinkSync(join(other, '.local', 'browser', 'Cookies.txt'), join(other, 'link.txt'));
  for (const from of [join(other, '.local', 'browser', 'Cookies.txt'), join(other, '.local', '.secrets'), join(other, 'link.txt')]) {
    const r = s.parkWith({ OIKOS_SCRATCH: other }, from);
    assert.equal(r.status, 1, `${from}: ${r.output}`);
    assert.match(r.stderr, /closed store of a \.local\/ folder/, from);
  }
  assert.deepEqual(readdirSync(s.local()), []);
  // What stays as it was: a plain file there is carried.
  writeFileSync(join(other, 'plain.md'), 'p\n');
  const r = s.parkWith({ OIKOS_SCRATCH: other }, join(other, 'plain.md'));
  assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(s.local('proj-123', 'plain.md'), 'utf8'), 'p\n');
});

// == destinations: a park writes inside .local/<package>/ and .local/ only ==

/** An empty folder outside the installation, for a symlink to lead to. */
const elsewhere = () => tempDir('elsewhere-');
const draft = (s) => ['--from', join(s.scratch, 'draft-review.md')];

test('park refuses a package folder that is a symlink, and writes nothing through it', () => {
  const s = setup();
  const out = elsewhere();
  symlinkSync(out, s.local('proj-123'), 'dir');
  const r = s.park(['--task', 'PROJ-123', ...fromArgs(s.scratch), '--yes']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing to park: \.local\/proj-123 is a symlink, not a folder of \.local\/\. Nothing was copied\./);
  assert.deepEqual(readdirSync(out), []);
  assert.ok(!existsSync(s.local('TASKS.md')));
});

test('park refuses a destination below a symlinked subfolder that leads out of the package folder', () => {
  const s = setup();
  const out = elsewhere();
  mkdirSync(s.local('proj-123'));
  symlinkSync(out, s.local('proj-123', 'notes'), 'dir');
  for (const flags of [[], ['--replace']]) {
    const r = s.park(['--task', 'PROJ-123', ...fromArgs(s.scratch), ...flags, '--yes']);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /Refusing to park: \.local\/proj-123\/notes\/a\.md resolves outside the package folder \(.*\); .*notes\/b\.md resolves outside the package folder.*\. Nothing was copied\./);
  }
  assert.deepEqual(readdirSync(out), []);
  assert.ok(!existsSync(s.local('proj-123', 'draft-review.md')), 'the other source is not copied either');
  assert.ok(!existsSync(s.local('TASKS.md')) && !existsSync(s.local('proj-123', 'HANDOFF.md')));
});

test('park refuses an existing destination file that is a symlink, a dangling one included, and leaves its target alone', () => {
  const s = setup();
  const out = elsewhere();
  writeFileSync(join(out, 'victim.md'), 'keep me\n');
  mkdirSync(s.local('proj-123'));
  symlinkSync(join(out, 'victim.md'), s.local('proj-123', 'draft-review.md'));
  for (const flags of [[], ['--replace']]) {
    const r = s.park(['--task', 'PROJ-123', ...draft(s), ...flags, '--yes']);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /Refusing to park: \.local\/proj-123\/draft-review\.md is a symlink — a park writes plain files only\. Nothing was copied\./);
  }
  assert.equal(readFileSync(join(out, 'victim.md'), 'utf8'), 'keep me\n');
  // A dangling symlink is not "there" to existsSync, yet is refused too — before a copy could follow it.
  symlinkSync(join(out, 'not-there.md'), s.local('proj-123', 'dangling.md'));
  const r = s.park(['--task', 'PROJ-123', '--from', join(s.scratch, 'notes', 'a.md'), '--from', join(s.scratch, 'draft-review.md'), '--replace', '--yes']);
  assert.equal(r.status, 1, r.output);
  assert.ok(!existsSync(join(out, 'not-there.md')));
});

test('park refuses a HANDOFF.md or a backlog that is a symlink out of .local/, before copying anything', () => {
  const s = setup();
  const out = elsewhere();
  mkdirSync(s.local('proj-123'));
  symlinkSync(join(out, 'handoff-target.md'), s.local('proj-123', 'HANDOFF.md'));
  let r = s.park(['--task', 'PROJ-123', ...draft(s), '--yes']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing to park: \.local\/proj-123\/HANDOFF\.md is a symlink/);
  assert.ok(!existsSync(join(out, 'handoff-target.md')));
  assert.ok(!existsSync(s.local('proj-123', 'draft-review.md')), 'nothing is copied before the refusal');

  const t = setup();
  writeFileSync(join(out, 'tasks-target.md'), '- X-1 · t · parked\n');
  symlinkSync(join(out, 'tasks-target.md'), t.local('TASKS.md'));
  r = t.park(['--task', 'PROJ-123', ...draft(t), '--yes']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /Refusing to park: \.local\/TASKS\.md is a symlink/);
  assert.equal(readFileSync(join(out, 'tasks-target.md'), 'utf8'), '- X-1 · t · parked\n');
  assert.ok(!existsSync(t.local('proj-123')), 'nothing is copied before the refusal');
});

test('park still works when .local/ itself is a symlink to a real folder', () => {
  const s = setup();
  const real = elsewhere();
  rmSync(s.local(), { recursive: true });
  symlinkSync(real, s.local(), 'dir');
  const r = s.park(['--task', 'PROJ-123', '--title', 'T', ...draft(s), '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.ok(existsSync(join(real, 'proj-123', 'draft-review.md')));
  assert.ok(existsSync(join(real, 'TASKS.md')));
});
