// `desk` (npm test, ADR 0006 D03), in a copy of examples/installation: new topic folders, the derived
// INDEX.md, list, find, compact (a plan unless --yes; warm and cold steps) and reopen. Topics are
// seeded as files and aged with utimesSync. A topic's status, age and tier are computed from the
// folders, nothing is ever deleted, and the tool writes only under .local/desk/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { deskProblems, deskSettings } from '../tools/common/desk.mjs';
import { unitsOf } from '../tools/desk/cli.mjs';
import { CORE, cleanEnv, installation, tempDir, tool } from './helpers/installation.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A plan.md with the unit rows `rows` ([status, key]) under the standard header. */
const planOf = (...rows) => [
  '---', 'title: Plan title', 'tags: [infra]', '---', '',
  '| # | unit | kind | where | source | status | key |',
  '|---|------|------|-------|--------|--------|-----|',
  ...rows.map(([status, key], i) => `| ${i + 1} | unit ${i + 1} | task | PROJ | chat | ${status} | ${key || '—'} |`),
  '',
].join('\n');

const CARD = '---\ntitle: Closed topic\nkeys: [PROJ-77, PROJ-78]\ntags: [billing]\n---\nOutcome: two tasks created.\n';
const SUMMARY = 'Outcome: two tasks.\nDecided: use the new gateway.\n';

/** The whole folder of a topic gets the mtime `days` (and an hour) ago. */
function age(folder, days) {
  const when = new Date(Date.now() - days * DAY_MS - 60 * 60 * 1000);
  const walk = (at) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(at, e.name));
      else utimesSync(join(at, e.name), when, when);
    }
  };
  walk(folder);
}

/** The `oikos.yaml` text `t` with its `desk:` part (the fixture has one) replaced by `part`. */
const withDesk = (t, part) => `${t.replace(/^desk:\n(?: {2}.*\n)+/m, '').trimEnd()}\n${part}\n`;

/** An installation with a desk and the helpers to seed topics and run the tool. */
function setup(config = (t) => t) {
  const dir = installation(config);
  const desk = (...p) => join(dir, '.local', 'desk', ...p);
  const seed = (date, slug, files, days, where = []) => {
    const folder = desk(...where, date, slug);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      writeFileSync(join(folder, name), text);
    }
    age(folder, days);
    return folder;
  };
  const run = (...args) => tool(dir, 'desk', args);
  const json = (...args) => {
    const r = run(...args, '--json');
    assert.equal(r.status, 0, r.output);
    return JSON.parse(r.stdout);
  };
  return { dir, desk, seed, run, json };
}

/** Every file of the desk but INDEX.md, as `<date>/<slug>/<name>\0<content>`, wherever it sits. */
function inventory(desk) {
  const found = [];
  const walk = (at) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const abs = join(at, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.name !== 'INDEX.md' || dirname(abs) !== desk) {
        const parts = relative(desk, abs).split('/');
        const id = (parts[0] === '_archive' ? parts.slice(2) : parts).join('/');
        found.push(`${id}\0${readFileSync(abs, 'utf8')}`);
      }
    }
  };
  if (existsSync(desk)) walk(desk);
  return found.sort();
}

// == new ==

test('new makes the topic folder with notes.md and plan.md, never overwrites, and indexes it', () => {
  const s = setup();
  const r = s.run('new', 'api-review', '--title', 'API review', '--tags', 'infra,api', '--date', '2026-10-27');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^\.local\/desk\/2026-10-27\/api-review$/m);
  assert.equal(readFileSync(s.desk('2026-10-27', 'api-review', 'notes.md'), 'utf8'), '# API review\n');
  const plan = readFileSync(s.desk('2026-10-27', 'api-review', 'plan.md'), 'utf8');
  assert.match(plan, /^title: API review$/m);
  assert.match(plan, /^ {2}- infra$/m);
  assert.match(plan, /^\| # \| unit \| kind \| where \| source \| status \| key \|$/m);
  assert.match(plan, /^\|[-|]+\|$/m);
  assert.match(readFileSync(s.desk('INDEX.md'), 'utf8'), /^- 2026-10-27 · api-review · open · — · infra, api · API review · 2026-10-27\/api-review$/m);
});

test('new takes the next free slug on the same date, and says so', () => {
  const s = setup();
  s.run('new', 'api-review', '--date', '2026-10-27');
  writeFileSync(s.desk('2026-10-27', 'api-review', 'notes.md'), 'mine\n');
  const r = s.run('new', 'api-review', '--date', '2026-10-27');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^\.local\/desk\/2026-10-27\/api-review-2$/m);
  assert.match(r.stdout, /^note: 'api-review' is taken on 2026-10-27 — created 'api-review-2'$/m);
  assert.equal(readFileSync(s.desk('2026-10-27', 'api-review', 'notes.md'), 'utf8'), 'mine\n');
  const third = s.run('new', 'api-review', '--date', '2026-10-27');
  assert.match(third.stdout, /api-review-3$/m);
});

test('new defaults the date to today and names an open topic of the same slug on another date', () => {
  const s = setup();
  s.run('new', 'api-review', '--date', '2026-01-05');
  const r = s.run('new', 'api-review');
  assert.equal(r.status, 0, r.output);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.match(r.stdout, new RegExp(`^\\.local/desk/${today}/api-review$`, 'm'));
  assert.match(r.stdout, /^note: open topic 2026-01-05\/api-review has the same slug/m);
});

test('new refuses a bad slug, the archive name, a missing slug and a bad date, creating nothing', () => {
  const s = setup();
  for (const args of [['new', 'Bad_Slug'], ['new', '_archive'], ['new', 'x/y'], ['new'], ['new', 'ok', '--date', '2026-02-30'], ['new', 'ok', '--date', 'tomorrow']]) {
    const r = s.run(...args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.output}`);
    assert.match(r.stderr, /^desk: /);
  }
  assert.equal(existsSync(s.desk()), false);
});

// == index ==

test('index lists live and archived topics by date then slug, and is idempotent', () => {
  const s = setup();
  s.seed('2026-10-02', 'beta', { 'plan.md': planOf(['drafted', '']), 'notes.md': 'n\n' }, 1);
  s.seed('2026-10-01', 'closed-one', { 'plan.md': planOf(['created', 'PROJ-1'], ['dropped', '']), 'card.md': CARD, 'summary.md': SUMMARY }, 1);
  s.seed('2026-03-04', 'cold-one', { 'card.md': CARD, 'summary.md': SUMMARY }, 200, ['_archive', '2026-03']);
  const r = s.run('index');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /INDEX\.md: 3 topic line\(s\)$/m);
  const text = readFileSync(s.desk('INDEX.md'), 'utf8');
  const lines = text.split('\n');
  assert.equal(lines[0], '# Desk index');
  assert.equal(lines[1], '');
  assert.match(lines[2], /do not edit by hand/);
  const topics = lines.filter((l) => l.startsWith('- '));
  assert.deepEqual(topics, [
    '- 2026-03-04 · cold-one · archived · PROJ-77, PROJ-78 · billing · Closed topic · _archive/2026-03/2026-03-04/cold-one',
    '- 2026-10-01 · closed-one · closed · PROJ-77, PROJ-78, PROJ-1 · billing, infra · Closed topic · 2026-10-01/closed-one',
    '- 2026-10-02 · beta · open · — · infra · Plan title · 2026-10-02/beta',
  ]);
  const past = new Date(Date.now() - 5 * DAY_MS);
  utimesSync(s.desk('INDEX.md'), past, past);
  const again = s.run('index');
  assert.match(again.stdout, /3 topic line\(s\) \(unchanged\)/);
  assert.equal(Math.round(statSync(s.desk('INDEX.md')).mtimeMs), Math.round(past.getTime()));
});

test('a topic with raw material in the archive and card and summary live is listed once, live wins', () => {
  const s = setup();
  s.seed('2026-05-01', 'warm-one', { 'card.md': CARD, 'summary.md': SUMMARY }, 40);
  s.seed('2026-05-01', 'warm-one', { 'notes.md': 'raw\n' }, 40, ['_archive', '2026-05']);
  s.run('index');
  const topics = readFileSync(s.desk('INDEX.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '));
  assert.equal(topics.length, 1);
  assert.match(topics[0], /^- 2026-05-01 · warm-one · closed · .* · 2026-05-01\/warm-one$/);
});

// == list ==

test('list says open, done and closed from the plan and the card; an unknown unit status stays open', () => {
  const s = setup();
  s.seed('2026-10-01', 'no-plan', { 'notes.md': 'n\n' }, 1);
  s.seed('2026-10-01', 'empty-plan', { 'plan.md': planOf() }, 2);
  s.seed('2026-10-01', 'drafting', { 'plan.md': planOf(['created', 'PROJ-1'], ['drafted', '']) }, 3);
  s.seed('2026-10-01', 'unknown', { 'plan.md': planOf(['created', 'PROJ-2'], ['maybe', '']) }, 4);
  s.seed('2026-10-01', 'finished', { 'plan.md': planOf(['created', 'PROJ-3'], ['sent', '']) }, 5);
  s.seed('2026-10-02', 'closed-card', { 'plan.md': planOf(['created', 'PROJ-4, PROJ-5']), 'card.md': CARD }, 6);
  s.seed('2026-10-02', 'compacted', { 'card.md': CARD, 'summary.md': SUMMARY }, 7);
  s.seed('2026-10-02', 'stale-card', { 'plan.md': planOf(['drafted', '']), 'card.md': CARD }, 8);
  const r = s.run('list');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^8 topic\(s\): 5 open, 1 done, 2 closed$/m);
  const row = (slug) => r.stdout.split('\n').find((l) => l.includes(`  ${slug}  `));
  assert.equal(row('no-plan'), '2026-10-01  no-plan  open  1d  hot  -');
  assert.equal(row('empty-plan'), '2026-10-01  empty-plan  open  2d  hot  -');
  assert.equal(row('drafting'), '2026-10-01  drafting  open  3d  hot  PROJ-1');
  assert.equal(row('unknown'), '2026-10-01  unknown  open  4d  hot  PROJ-2');
  assert.equal(row('finished'), '2026-10-01  finished  done  5d  hot  PROJ-3');
  assert.match(row('closed-card'), /^2026-10-02 {2}closed-card {2}closed {2}6d {2}hot {2}PROJ-77, PROJ-78, PROJ-4, PROJ-5$/);
  assert.match(row('compacted'), /^2026-10-02 {2}compacted {2}closed {2}7d {2}hot/);
  assert.match(r.stdout, /^note: 2026-10-02\/stale-card has a card\.md but a unit is not final/m);
});

test('list --json gives the typed topics; --all adds the archived-only ones', () => {
  const s = setup();
  s.seed('2026-10-01', 'live-one', { 'plan.md': planOf(['created', 'PROJ-3'], ['maybe', '']), 'notes.md': 'n\n' }, 2);
  s.seed('2026-03-04', 'cold-one', { 'card.md': CARD }, 200, ['_archive', '2026-03']);
  const live = s.json('list');
  assert.equal(live.length, 1);
  assert.deepEqual(live[0], {
    date: '2026-10-01', slug: 'live-one', status: 'open', ageDays: 2, tier: 'hot', keys: ['PROJ-3'], tags: ['infra'],
    title: 'Plan title', path: '2026-10-01/live-one', units: [{ status: 'created', key: 'PROJ-3' }, { status: '?', key: '' }], archived: false,
  });
  const all = s.json('list', '--all');
  assert.deepEqual(all.map((t) => [t.slug, t.status, t.tier, t.archived]), [['cold-one', 'archived', 'cold', true], ['live-one', 'open', 'hot', false]]);
  const text = s.run('list', '--all').stdout;
  assert.match(text, /^2 topic\(s\): 1 open, 0 done, 0 closed, 1 archived$/m);
});

test('list on an empty desk says how to start', () => {
  const s = setup();
  const r = s.run('list');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /no topics on the desk — start one: node oikos\/tools\/desk\/cli\.mjs new <slug>/);
  assert.equal(existsSync(s.desk()), false);
});

test('unitsOf reads the status and key columns by name, in any order', () => {
  const body = '| status | note | KEY |\n|---|---|---|\n| Created | x | PROJ-1 |\n| nonsense | y | — |\n|  |  |  |\n\nafter\n';
  assert.deepEqual(unitsOf(body), [{ status: 'created', key: 'PROJ-1' }, { status: '?', key: '' }]);
  assert.deepEqual(unitsOf('no table here'), []);
});

// == thresholds ==

test('thresholds come from the desk part of oikos.yaml, and a flag overrides them', () => {
  const s = setup((t) => withDesk(t, 'desk:\n  warm_days: 5\n  cold_days: 10'));
  s.seed('2026-10-01', 'aged', { 'plan.md': planOf(['created', 'PROJ-1']), 'card.md': CARD, 'summary.md': SUMMARY }, 7);
  assert.equal(s.json('list')[0].tier, 'warm');
  assert.equal(s.json('list', '--warm-days', '8', '--cold-days', '20')[0].tier, 'hot');
  assert.match(s.run('compact').stdout, /^2026-10-01\/aged: warm — 1 file\(s\) to /m);
  assert.match(s.run('compact', '--warm-days', '8', '--cold-days', '20').stdout, /nothing to compact/);
});

test('thresholds that are not whole positive days, or cold not after warm, are refused', () => {
  const s = setup();
  for (const args of [['--warm-days', '0'], ['--warm-days', 'x'], ['--cold-days', '2.5'], ['--warm-days', '30', '--cold-days', '30'], ['--cold-days', '10']]) {
    const r = s.run('list', ...args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.output}`);
    assert.match(r.stderr, /^desk: /);
  }
  const bad = setup((t) => withDesk(t, 'desk: { warm_days: 20, cold_days: 10 }'));
  const r = bad.run('list');
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /cold days \(10\) must be greater than warm days \(20\)/);
});

test('deskSettings and deskProblems: defaults, unknown key, non-integer, cold not after warm', () => {
  assert.deepEqual(deskSettings(undefined), { warmDays: 30, coldDays: 90 });
  assert.deepEqual(deskSettings({ warm_days: 7 }), { warmDays: 7, coldDays: 90 });
  assert.deepEqual(deskSettings({ warm_days: 'x', cold_days: 0 }), { warmDays: 30, coldDays: 90 });
  assert.deepEqual(deskProblems({ warm_days: 10, cold_days: 40 }), []);
  assert.deepEqual(deskProblems(undefined), []);
  assert.match(deskProblems({ warm_day: 10 })[0], /^desk\.warm_day: unknown key/);
  assert.match(deskProblems({ warm_days: 1.5 })[0], /^desk\.warm_days: must be a whole number of days/);
  assert.match(deskProblems({ cold_days: 20, warm_days: 20 })[0], /desk\.cold_days \(20\) must be greater than desk\.warm_days \(20\)/);
});

// == compact ==

/** A desk with a closed topic old enough for the warm step, one with open units, one without a summary and a fresh one. */
function agedDesk() {
  const s = setup();
  const closed = { 'plan.md': planOf(['created', 'PROJ-1']), 'notes.md': 'the gateway timeout was 30s\n', 'draft-1.md': 'draft\n', 'card.md': CARD, 'summary.md': SUMMARY };
  s.seed('2026-06-01', 'old-closed', closed, 40);
  s.seed('2026-06-01', 'old-open', { 'plan.md': planOf(['drafted', '']), 'notes.md': 'n\n' }, 40);
  s.seed('2026-06-01', 'old-bare', { 'notes.md': 'n\n' }, 40);
  s.seed('2026-06-01', 'no-summary', { 'plan.md': planOf(['created', 'PROJ-2']), 'card.md': CARD }, 40);
  s.seed('2026-10-01', 'fresh', { 'plan.md': planOf(['created', 'PROJ-3']), 'card.md': CARD, 'summary.md': SUMMARY }, 5);
  return s;
}

test('compact without --yes plans the warm step and the skips, and changes nothing', () => {
  const s = agedDesk();
  const before = inventory(s.desk());
  const r = s.run('compact');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^2026-06-01\/old-closed: warm — 3 file\(s\) to \.local\/desk\/_archive\/2026-06\/2026-06-01\/old-closed\/$/m);
  assert.match(r.stdout, /^2026-06-01\/old-open: skipped — has open units — stays hot$/m);
  assert.match(r.stdout, /^2026-06-01\/old-bare: skipped — has no plan with units/m);
  assert.match(r.stdout, /^2026-06-01\/no-summary: skipped — needs summary\.md — the agent writes them$/m);
  assert.doesNotMatch(r.stdout, /fresh/);
  assert.match(r.stdout, /preview only — nothing moved; --yes applies it/);
  assert.deepEqual(inventory(s.desk()), before);
  assert.equal(existsSync(s.desk('_archive')), false);
  assert.equal(existsSync(s.desk('INDEX.md')), false);
});

test('compact --yes moves raw material to the archive, keeps card and summary, rebuilds the index, deletes nothing', () => {
  const s = agedDesk();
  const before = inventory(s.desk());
  const r = s.run('compact', '--yes');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /1 topic\(s\) compacted, 3 file\(s\) moved; INDEX\.md rebuilt \(5 topic line\(s\)\)$/m);
  const live = s.desk('2026-06-01', 'old-closed');
  assert.deepEqual(readdirSync(live).sort(), ['card.md', 'summary.md']);
  const archived = s.desk('_archive', '2026-06', '2026-06-01', 'old-closed');
  assert.deepEqual(readdirSync(archived).sort(), ['draft-1.md', 'notes.md', 'plan.md']);
  assert.deepEqual(inventory(s.desk()), before);
  const index = readFileSync(s.desk('INDEX.md'), 'utf8');
  assert.equal(index.split('\n').filter((l) => l.includes(' old-closed ')).length, 1);
  assert.match(index, /^- 2026-06-01 · old-closed · closed · PROJ-77, PROJ-78, PROJ-1 · billing, infra · Closed topic · 2026-06-01\/old-closed$/m);
  // Raw material moved by rename keeps its mtime, so the topic is still as old as its last activity.
  assert.equal(s.json('list').find((t) => t.slug === 'old-closed').ageDays, 40);
  // A second run has nothing more to do for it.
  assert.doesNotMatch(s.run('compact').stdout, /old-closed/);
});

test('compact --yes takes a topic past cold_days all the way, removes the emptied folders and indexes it as archived', () => {
  const s = setup();
  s.seed('2026-05-01', 'ancient', { 'plan.md': planOf(['sent', 'PROJ-9']), 'notes.md': 'n\n', 'card.md': CARD, 'summary.md': SUMMARY }, 100);
  const before = inventory(s.desk());
  const r = s.run('compact', '--yes');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^2026-05-01\/ancient: cold — 4 file\(s\) to \.local\/desk\/_archive\/2026-05\/2026-05-01\/ancient\/$/m);
  assert.equal(existsSync(s.desk('2026-05-01')), false);
  assert.equal(readdirSync(s.desk('_archive', '2026-05', '2026-05-01', 'ancient')).length, 4);
  assert.deepEqual(inventory(s.desk()), before);
  assert.match(readFileSync(s.desk('INDEX.md'), 'utf8'), /^- 2026-05-01 · ancient · archived · PROJ-77, PROJ-78, PROJ-9 · billing, infra · Closed topic · _archive\/2026-05\/2026-05-01\/ancient$/m);
  assert.equal(s.json('list').length, 0);
  assert.equal(s.json('list', '--all')[0].tier, 'cold');
});

test('a warm topic goes cold later: its card and summary follow once past cold_days', () => {
  const s = setup();
  s.seed('2026-05-01', 'two-step', { 'plan.md': planOf(['created', 'PROJ-9']), 'notes.md': 'n\n', 'card.md': CARD, 'summary.md': SUMMARY }, 40);
  s.run('compact', '--yes');
  assert.deepEqual(readdirSync(s.desk('2026-05-01', 'two-step')).sort(), ['card.md', 'summary.md']);
  const [live, archived] = [s.desk('2026-05-01', 'two-step'), s.desk('_archive', '2026-05', '2026-05-01', 'two-step')];
  age(live, 100);
  age(archived, 100);
  const r = s.run('compact', '--yes');
  assert.match(r.stdout, /^2026-05-01\/two-step: cold — 2 file\(s\)/m);
  assert.equal(existsSync(s.desk('2026-05-01')), false);
  assert.equal(readdirSync(archived).length, 4);
});

test('a move onto other content refuses that topic and the others go on; identical content is moved as it is', () => {
  const s = setup();
  const closed = (note) => ({ 'plan.md': planOf(['created', 'PROJ-1']), 'notes.md': note, 'card.md': CARD, 'summary.md': SUMMARY });
  s.seed('2026-04-01', 'clash', closed('live note\n'), 40);
  s.seed('2026-04-01', 'clash', { 'notes.md': 'archived note\n' }, 40, ['_archive', '2026-04']);
  s.seed('2026-04-01', 'twin', closed('same note\n'), 40);
  s.seed('2026-04-01', 'twin', { 'notes.md': 'same note\n' }, 40, ['_archive', '2026-04']);
  const before = inventory(s.desk());
  const preview = s.run('compact');
  assert.match(preview.stdout, /^2026-04-01\/clash: refused — \.local\/desk\/_archive\/2026-04\/2026-04-01\/clash\/notes\.md exists with other content$/m);
  assert.match(preview.stdout, /^2026-04-01\/twin: warm — 2 file\(s\)/m);
  const r = s.run('compact', '--yes');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /1 topic\(s\) compacted, 2 file\(s\) moved/);
  assert.equal(readFileSync(s.desk('2026-04-01', 'clash', 'notes.md'), 'utf8'), 'live note\n');
  assert.equal(readFileSync(s.desk('_archive', '2026-04', '2026-04-01', 'clash', 'notes.md'), 'utf8'), 'archived note\n');
  assert.equal(existsSync(s.desk('2026-04-01', 'twin', 'notes.md')), false);
  assert.equal(readFileSync(s.desk('_archive', '2026-04', '2026-04-01', 'twin', 'notes.md'), 'utf8'), 'same note\n');
  const after = inventory(s.desk());
  // The identical copy was moved over its twin: exactly one copy of that content is left, nothing else is lost.
  const expected = [...before];
  expected.splice(expected.indexOf('2026-04-01/twin/notes.md\0same note\n'), 1);
  assert.deepEqual(after, expected);
  const plan = s.json('compact').topics.find((t) => t.slug === 'clash');
  assert.equal(plan.action, 'conflict');
  assert.match(plan.conflicts[0], /exists with other content/);
});

test('compact --json carries the plan: action, reason, files', () => {
  const s = agedDesk();
  const { applied, topics } = s.json('compact');
  assert.equal(applied, false);
  const byslug = Object.fromEntries(topics.map((t) => [t.slug, t]));
  assert.equal(byslug['old-closed'].action, 'warm');
  assert.equal(byslug['old-closed'].files.length, 3);
  assert.equal(byslug['old-closed'].files[0].fate, 'new');
  assert.equal(byslug['old-open'].action, 'skip');
  assert.match(byslug['no-summary'].reason, /summary\.md/);
});

// == find ==

test('find matches slug, title, keys and tags case-insensitively, and the text of card.md and summary.md', () => {
  const s = setup();
  s.seed('2026-10-01', 'payments', { 'plan.md': planOf(['created', 'PROJ-77']), 'card.md': CARD, 'summary.md': SUMMARY, 'notes.md': 'the gateway timeout was 30s\n' }, 2);
  s.seed('2026-10-01', 'other', { 'plan.md': planOf(['drafted', '']), 'notes.md': 'unrelated\n' }, 2);
  assert.match(s.run('find', 'proj-77').stdout, /^2026-10-01 payments \(closed\)$/m);
  assert.match(s.run('find', 'BILLING').stdout, /^2026-10-01 payments \(closed\)$/m);
  assert.match(s.run('find', 'closed topic').stdout, /^2026-10-01 payments \(closed\)$/m);
  assert.match(s.run('find', 'infra').stdout, /^2026-10-01 other \(open\)$/m);
  const text = s.run('find', 'GATEWAY');
  assert.equal(text.status, 0, text.output);
  assert.match(text.stdout, /^1 hit\(s\) for 'GATEWAY'$/m);
  assert.match(text.stdout, /^\.local\/desk\/2026-10-01\/payments\/summary\.md:2: Decided: use the new gateway\.$/m);
  // The raw notes of a live topic are not searched: card and summary are.
  assert.doesNotMatch(text.stdout, /notes\.md/);
});

test('find says when nothing matches, refuses an empty query, and --archive reaches the raw notes', () => {
  const s = setup();
  s.seed('2026-06-01', 'payments', { 'plan.md': planOf(['created', 'PROJ-1']), 'notes.md': 'the gateway timeout was 30s\n', 'card.md': CARD, 'summary.md': SUMMARY }, 40);
  s.run('compact', '--yes');
  const none = s.run('find', 'timeout');
  assert.equal(none.status, 0, none.output);
  assert.match(none.stdout, /^no hits for 'timeout' — --archive also reads the archived raw material$/m);
  const deep = s.run('find', 'timeout', '--archive');
  assert.match(deep.stdout, /^\.local\/desk\/_archive\/2026-06\/2026-06-01\/payments\/notes\.md:1: the gateway timeout was 30s$/m);
  for (const empty of ['', '   ']) {
    const r = s.run('find', empty);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /^desk: find needs a text or a task key/);
  }
  const bare = s.run('find');
  assert.equal(bare.status, 1);
  const json = s.json('find', 'gateway');
  assert.deepEqual(json.map((h) => h.type), ['line']);
});

test('find finds an archived-only topic by its key, from its archived card', () => {
  const s = setup();
  s.seed('2026-03-04', 'cold-one', { 'card.md': CARD, 'summary.md': SUMMARY }, 200, ['_archive', '2026-03']);
  assert.match(s.run('find', 'PROJ-78').stdout, /^2026-03-04 cold-one \(archived\)$/m);
});

test('find cuts a flood of line hits and says how many', () => {
  const s = setup();
  s.seed('2026-10-01', 'noisy', { 'summary.md': Array.from({ length: 60 }, (_, i) => `gateway ${i}`).join('\n') }, 1);
  const r = s.run('find', 'gateway');
  assert.match(r.stdout, /^… 10 more line hit\(s\) cut — narrow the text$/m);
});

// == reopen ==

test('reopen moves a compacted topic back, makes it hot, rebuilds the index; a plan unless --yes', () => {
  const s = agedDesk();
  s.run('compact', '--yes');
  const before = inventory(s.desk());
  const preview = s.run('reopen', 'old-closed');
  assert.equal(preview.status, 0, preview.output);
  assert.match(preview.stdout, /^Would reopen 2026-06-01\/old-closed: 3 file\(s\) from \.local\/desk\/_archive\/2026-06\/2026-06-01\/old-closed\/ to \.local\/desk\/2026-06-01\/old-closed\/$/m);
  assert.match(preview.stdout, /preview only — nothing moved/);
  assert.deepEqual(inventory(s.desk()), before);
  assert.equal(existsSync(s.desk('_archive', '2026-06', '2026-06-01', 'old-closed', 'notes.md')), true);
  const r = s.run('reopen', '2026-06-01/old-closed', '--yes');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^Reopened 2026-06-01\/old-closed: 3 file\(s\)/m);
  assert.deepEqual(readdirSync(s.desk('2026-06-01', 'old-closed')).sort(), ['card.md', 'draft-1.md', 'notes.md', 'plan.md', 'summary.md']);
  assert.equal(existsSync(s.desk('_archive', '2026-06')), false);
  assert.deepEqual(inventory(s.desk()), before);
  const topic = s.json('list').find((t) => t.slug === 'old-closed');
  assert.equal(topic.ageDays, 0);
  assert.equal(topic.tier, 'hot');
  assert.equal(topic.archived, false);
  assert.doesNotMatch(s.run('compact').stdout, /old-closed/);
});

test('reopen brings a cold topic back whole', () => {
  const s = setup();
  s.seed('2026-05-01', 'ancient', { 'plan.md': planOf(['sent', 'PROJ-9']), 'notes.md': 'n\n', 'card.md': CARD, 'summary.md': SUMMARY }, 100);
  s.run('compact', '--yes');
  const before = inventory(s.desk());
  const r = s.run('reopen', 'ancient', '--yes');
  assert.equal(r.status, 0, r.output);
  assert.equal(readdirSync(s.desk('2026-05-01', 'ancient')).length, 4);
  assert.deepEqual(inventory(s.desk()), before);
  assert.equal(s.json('list')[0].status, 'closed');
});

test('reopen refuses a conflict and an ambiguous slug, naming the cause, and moves nothing', () => {
  const s = setup();
  s.seed('2026-06-01', 'twice', { 'notes.md': 'a\n' }, 100, ['_archive', '2026-06']);
  s.seed('2026-07-01', 'twice', { 'notes.md': 'b\n' }, 100, ['_archive', '2026-07']);
  s.seed('2026-08-01', 'clash', { 'notes.md': 'archived\n' }, 100, ['_archive', '2026-08']);
  s.seed('2026-08-01', 'clash', { 'notes.md': 'live\n' }, 1);
  const before = inventory(s.desk());
  const ambiguous = s.run('reopen', 'twice', '--yes');
  assert.equal(ambiguous.status, 1, ambiguous.output);
  assert.match(ambiguous.stderr, /'twice' is ambiguous: 2026-06-01\/twice, 2026-07-01\/twice — name one as date\/slug/);
  const conflict = s.run('reopen', 'clash', '--yes');
  assert.equal(conflict.status, 1, conflict.output);
  assert.match(conflict.stderr, /Refusing to reopen 2026-08-01\/clash: \.local\/desk\/2026-08-01\/clash\/notes\.md exists with other content\. Nothing was moved\./);
  const missing = s.run('reopen', 'nothing-here');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no archived topic 'nothing-here'/);
  assert.equal(s.run('reopen').status, 1);
  assert.deepEqual(inventory(s.desk()), before);
  const named = s.run('reopen', '2026-07-01/twice', '--yes');
  assert.equal(named.status, 0, named.output);
  assert.equal(existsSync(s.desk('2026-07-01', 'twice', 'notes.md')), true);
});

// == review findings ==

test('new refuses an impossible calendar day with a usage error naming it, never a crash', () => {
  const s = setup();
  for (const day of ['2026-13-01', '2026-01-32', '2026-00-10', '2026-02-30', '2026-00-00', '9999-99-99']) {
    const r = s.run('new', 'ok', '--date', day);
    assert.equal(r.status, 1, `${day}: ${r.output}`);
    assert.match(r.stderr, new RegExp(`^desk: --date '${day}'`));
    assert.doesNotMatch(r.output, /RangeError/);
  }
  assert.equal(existsSync(s.desk()), false);
  assert.equal(s.run('new', 'ok', '--date', '2028-02-29').status, 0);
});

test('new refuses a --title with a newline, creating nothing', () => {
  const s = setup();
  const r = s.run('new', 'ok', '--title', 'one\ntwo');
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /^desk: --title is one line/);
  assert.equal(existsSync(s.desk()), false);
});

test('new refuses to write through a symlinked desk, date or topic folder, and writes nothing outside', () => {
  const links = {
    'the desk folder': (s, outside) => symlinkSync(outside, s.desk()),
    'the date folder': (s, outside) => { mkdirSync(s.desk()); symlinkSync(outside, s.desk('2026-10-27')); },
    'the topic folder': (s, outside) => { mkdirSync(s.desk('2026-10-27'), { recursive: true }); symlinkSync(outside, s.desk('2026-10-27', 'ok')); },
  };
  for (const [what, link] of Object.entries(links)) {
    const s = setup();
    const outside = tempDir('outside-');
    link(s, outside);
    const r = s.run('new', 'ok', '--date', '2026-10-27');
    assert.equal(r.status, 1, `${what}: ${r.output}`);
    assert.match(r.stderr, /symlink/, what);
    assert.deepEqual(readdirSync(outside), [], what);
  }
});

test('index and new refuse a symlinked INDEX.md, and the file it points to is not touched', () => {
  const s = setup();
  s.seed('2026-10-01', 'one', { 'notes.md': 'n\n' }, 1);
  const target = join(tempDir('outside-'), 'target.md');
  writeFileSync(target, 'keep\n');
  symlinkSync(target, s.desk('INDEX.md'));
  const index = s.run('index');
  assert.equal(index.status, 1, index.output);
  assert.match(index.stderr, /INDEX\.md is a symlink/);
  const made = s.run('new', 'two', '--date', '2026-10-02');
  assert.equal(made.status, 1, made.output);
  assert.equal(existsSync(s.desk('2026-10-02')), false);
  assert.equal(readFileSync(target, 'utf8'), 'keep\n');
});

test('compact and reopen refuse a move that would go through a symlink, and nothing moves', () => {
  const s = setup();
  const outside = tempDir('outside-');
  s.seed('2026-06-01', 'old-closed', { 'plan.md': planOf(['created', 'PROJ-1']), 'notes.md': 'n\n', 'card.md': CARD, 'summary.md': SUMMARY }, 40);
  symlinkSync(outside, s.desk('_archive'));
  const before = inventory(s.desk());
  const compact = s.run('compact', '--yes');
  assert.equal(compact.status, 0, compact.output);
  assert.match(compact.stdout, /^2026-06-01\/old-closed: refused — .*_archive is a symlink/m);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(inventory(s.desk()), before);

  const t = setup();
  const away = tempDir('outside-');
  t.seed('2026-03-04', 'cold-one', { 'card.md': CARD, 'summary.md': SUMMARY }, 200, ['_archive', '2026-03']);
  symlinkSync(away, t.desk('2026-03-04'));
  const kept = inventory(t.desk());
  const reopen = t.run('reopen', 'cold-one', '--yes');
  assert.equal(reopen.status, 1, reopen.output);
  assert.match(reopen.stderr, /2026-03-04 is a symlink/);
  assert.deepEqual(readdirSync(away), []);
  assert.deepEqual(inventory(t.desk()), kept);
});

test('a unit text with an escaped pipe does not shift the columns, so the topic is not compacted early', () => {
  const body = [
    '| # | unit | kind | where | source | status | key |',
    '|---|------|------|-------|--------|--------|-----|',
    '| 1 | use a \\| b | task | PROJ | created | drafted | — |',
    '| 2 | other | task | PROJ | chat | created | PROJ-2 |',
  ].join('\n');
  assert.deepEqual(unitsOf(body), [{ status: 'drafted', key: '' }, { status: 'created', key: 'PROJ-2' }]);
  const s = setup();
  const plan = `---\ntitle: Pipes\n---\n\n${body}\n`;
  s.seed('2026-06-01', 'pipes', { 'plan.md': plan, 'notes.md': 'n\n', 'card.md': CARD, 'summary.md': SUMMARY }, 40);
  assert.equal(s.json('list')[0].status, 'open');
  const r = s.run('compact', '--yes');
  assert.match(r.stdout, /^2026-06-01\/pipes: skipped — has open units/m);
  assert.deepEqual(readdirSync(s.desk('2026-06-01', 'pipes')).sort(), ['card.md', 'notes.md', 'plan.md', 'summary.md']);
});

test('a table without edge pipes is read; a row with fewer cells than the header is never final', () => {
  const bare = ['unit | status | key', '--- | :---: | ---', 'a | created | PROJ-1', 'b | drafted | —', 'c | sent | PROJ-3, PROJ-4'].join('\n');
  assert.deepEqual(unitsOf(bare), [
    { status: 'created', key: 'PROJ-1' }, { status: 'drafted', key: '' }, { status: 'sent', key: 'PROJ-3, PROJ-4' },
  ]);
  const short = ['| # | unit | kind | where | source | status | key |', '|---|---|---|---|---|---|---|', '| 1 | x | task | PROJ | chat | created |', '| 2 | y | task |'].join('\n');
  assert.deepEqual(unitsOf(short).map((u) => u.status), ['?', '?']);
  assert.deepEqual(unitsOf('status\n---\nnot a table'), []);
  const s = setup();
  s.seed('2026-10-01', 'bare', { 'plan.md': bare }, 1);
  const [topic] = s.json('list');
  assert.equal(topic.status, 'open');
  assert.deepEqual(topic.keys, ['PROJ-1', 'PROJ-3', 'PROJ-4']);
});

test('after the warm step the archived plan still feeds the index fields and find', () => {
  const s = setup();
  s.seed('2026-06-01', 'old-closed', { 'plan.md': planOf(['created', 'PROJ-1']), 'notes.md': 'n\n', 'card.md': '---\ntitle: Only card\n---\nx\n', 'summary.md': SUMMARY }, 40);
  s.run('compact', '--yes');
  assert.equal(existsSync(s.desk('2026-06-01', 'old-closed', 'plan.md')), false);
  const [topic] = s.json('list');
  assert.equal(topic.status, 'closed');
  assert.deepEqual(topic.keys, ['PROJ-1']);
  assert.deepEqual(topic.tags, ['infra']);
  assert.match(s.run('find', 'PROJ-1').stdout, /^2026-06-01 old-closed \(closed\)$/m);
  assert.match(readFileSync(s.desk('INDEX.md'), 'utf8'), /^- 2026-06-01 · old-closed · closed · PROJ-1 · infra · Only card · 2026-06-01\/old-closed$/m);
});

test('the warm step lands under the month of the topic date folder, not the month of its files', () => {
  const s = setup();
  s.seed('2026-02-15', 'feb', { 'plan.md': planOf(['created', 'PROJ-1']), 'notes.md': 'n\n', 'card.md': CARD, 'summary.md': SUMMARY }, 40);
  assert.equal(s.run('compact', '--yes').status, 0);
  assert.deepEqual(readdirSync(s.desk('_archive')), ['2026-02']);
  assert.deepEqual(readdirSync(s.desk('_archive', '2026-02')), ['2026-02-15']);
  assert.deepEqual(readdirSync(s.desk('_archive', '2026-02', '2026-02-15', 'feb')).sort(), ['notes.md', 'plan.md']);
});

test('reopen takes `slug` or `date/slug` only; a longer or malformed target is refused', () => {
  const s = setup();
  s.seed('2026-06-01', 'old-closed', { 'notes.md': 'n\n' }, 100, ['_archive', '2026-06']);
  const before = inventory(s.desk());
  for (const target of ['2026-06-01/old-closed/typo', 'a/b/c/d', 'old-closed/', '/old-closed', 'nodate/old-closed']) {
    const r = s.run('reopen', target, '--yes');
    assert.equal(r.status, 1, `${target}: ${r.output}`);
    assert.match(r.stderr, /^desk: /);
  }
  assert.deepEqual(inventory(s.desk()), before);
  assert.equal(existsSync(s.desk('2026-06-01')), false);
  assert.equal(s.run('reopen', '2026-06-01/old-closed', '--yes').status, 0);
});

test('a card.md or summary.md that is a folder counts as absent; list, find and compact do not crash', () => {
  const s = setup();
  s.seed('2026-06-01', 'odd', { 'plan.md': planOf(['created', 'PROJ-1']), 'notes.md': 'gateway\n', 'card.md/inner.md': 'gateway\n', 'summary.md/inner.md': 'gateway\n' }, 40);
  const list = s.run('list');
  assert.equal(list.status, 0, list.output);
  assert.match(list.stdout, /2026-06-01 {2}odd {2}done/);
  const find = s.run('find', 'gateway');
  assert.equal(find.status, 0, find.output);
  const compact = s.run('compact');
  assert.equal(compact.status, 0, compact.output);
  assert.match(compact.stdout, /^2026-06-01\/odd: skipped — needs card\.md and summary\.md/m);
  assert.equal(s.run('find', 'gateway', '--archive').status, 0);
});

// == outside an installation ==

test('the tool run outside an installation says so and exits 1', () => {
  const r = spawnSync(process.execPath, [join(CORE, 'tools', 'desk', 'cli.mjs'), 'list'], { cwd: CORE, encoding: 'utf8', env: cleanEnv({ PWD: CORE }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^desk: no oikos installation here/);
});
