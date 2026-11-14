// A moved installation (docs/design/mounts.md § Moving an installation, slice S5): the folder is copied
// to another path and `oikos/` relinked, as BOOTSTRAP.md says. `sync --check` is then red on every
// generated file that names the old root, naming it; `sync` rewrites them to the new root, replacing the
// mount wiring written for the old paths instead of leaving it beside the new; `sync --check` is then
// green. An installation that did not move is never reported. Temporary installations (ACME Corp), real
// `git init` mounts, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CORE, installation, tempDir } from './helpers/installation.mjs';
import { mounted, readJson, sync, write } from './helpers/mounts.mjs';

/** A copy of the installation `dir` at another path, `oikos/` pointing at the core again; its real path. */
function moved(dir) {
  const target = join(tempDir('moved-'), 'acme');
  cpSync(dir, target, { recursive: true, verbatimSymlinks: true });
  rmSync(join(target, 'oikos'));
  symlinkSync(relative(target, CORE), join(target, 'oikos'), 'dir');
  return realpathSync(target);
}

/** The generated files of `dir` that hold `text`, relative to it. */
const naming = (dir, text) => ['.mcp.json', '.claude/settings.local.json', '.local/sync.json', 'vaults/team/.claude/settings.local.json', 'projects/dev-root/.claude/settings.local.json']
  .filter((file) => existsSync(join(dir, file)) && readFileSync(join(dir, file), 'utf8').includes(text));

test('a moved installation: sync --check is red on each file naming the old root, sync rewrites them, the check is green again', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  assert.deepEqual(naming(now, dir).sort(), ['.claude/settings.local.json', '.local/sync.json', '.mcp.json', 'projects/dev-root/.claude/settings.local.json', 'vaults/team/.claude/settings.local.json']);

  const red = sync(now, '--check');
  assert.equal(red.status, 1, red.output);
  assert.match(red.stdout, new RegExp(`note: this installation was moved — an earlier sync recorded ${dir}`));
  for (const file of ['.mcp.json', '.claude/settings.local.json claudeMdExcludes', 'vaults/team/.claude/settings.local.json claudeMdExcludes', 'projects/dev-root/.claude/settings.local.json claudeMdExcludes', '.local/sync.json']) {
    assert.match(red.stdout, new RegExp(`out of date: ${file.replace(/\./g, '\\.')} \\(names the old root ${dir}\\)`), file);
  }
  assert.deepEqual(naming(now, dir).length, 5, '--check writes nothing');

  const fixed = sync(now);
  assert.equal(fixed.status, 0, fixed.output);
  assert.match(fixed.stdout, /wrote: \.mcp\.json \(names the old root/);
  assert.deepEqual(naming(now, dir), [], 'nothing names the old root any more');
  assert.doesNotMatch(fixed.stdout, /no longer configured/, 'the old paths are the same mounts, not mounts that were removed');
  assert.deepEqual(readJson(join(now, '.mcp.json')).mcpServers['akmon-browser'].env, { OIKOS_HOME: now });

  const green = sync(now, '--check');
  assert.equal(green.status, 0, green.output);
  assert.doesNotMatch(green.stdout, /this installation was moved|out of date:/);
});

test('the rewrite replaces the mount wiring of the old paths and keeps what the person wrote and the outside mount', () => {
  const { dir, own } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  // the person's own entries in the same lists, and a line of their own in a mount's own settings
  const settings = readJson(join(now, '.claude', 'settings.local.json'));
  write(join(now, '.claude', 'settings.local.json'), `${JSON.stringify({ ...settings, claudeMdExcludes: ['/elsewhere/**/CLAUDE.md', ...settings.claudeMdExcludes] }, null, 2)}\n`);
  assert.equal(sync(now).status, 0);

  const after = readJson(join(now, '.claude', 'settings.local.json'));
  assert.deepEqual(after.claudeMdExcludes, [
    '/elsewhere/**/CLAUDE.md',
    ...['vaults/team', 'projects/dev-root'].flatMap((m) => ['CLAUDE.md', 'CLAUDE.local.md', '.claude/rules/**'].map((f) => `${now}/${m}/**/${f}`)),
  ]);
  assert.ok(after.permissions.additionalDirectories.includes(own), 'the outside mount stays wired');
  assert.deepEqual(Object.keys(readJson(join(now, '.local', 'sync.json')).mounts).sort(), [own, `${now}/projects/dev-root`, `${now}/vaults/team`].sort());
  assert.deepEqual(readJson(join(now, 'vaults', 'team', '.claude', 'settings.local.json')).claudeMdExcludes,
    ['CLAUDE.md', 'CLAUDE.local.md', 'vaults/CLAUDE.md', 'vaults/CLAUDE.local.md'].map((f) => `${now}/${f}`));
  assert.equal(sync(now, '--check').status, 0);
});

test('a moved installation without mounts: the check names .mcp.json, sync rewrites it', () => {
  const dir = realpathSync(installation((t) => t));
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  const red = sync(now, '--check');
  assert.equal(red.status, 1, red.output);
  assert.match(red.stdout, new RegExp(`out of date: \\.mcp\\.json \\(names the old root ${dir}\\)`));
  assert.equal(sync(now).status, 0);
  assert.equal(sync(now, '--check').status, 0);
});

test('--dry-run on a moved installation lists the rewrite and writes nothing', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  const before = readFileSync(join(now, '.mcp.json'), 'utf8');
  const r = sync(now, '--dry-run');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /would write: \.mcp\.json \(names the old root/);
  assert.equal(readFileSync(join(now, '.mcp.json'), 'utf8'), before);
  assert.deepEqual(naming(now, dir).length, 5);
});

test('an installation that did not move is never reported, however often it is synced', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  for (const args of [['--check'], [], ['--check'], ['--dry-run']]) {
    const r = sync(dir, ...args);
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.stdout, /this installation was moved|names the old root|out of date:|would write:|wrote:/);
  }
});

test('a mount removed from the configuration after the move keeps its wiring until --prune takes it away', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  write(join(now, 'oikos.yaml'), readFileSync(join(now, 'oikos.yaml'), 'utf8').replace(/\n {2}projects\/dev-root:\n {4}use: \[skills\]\n {4}skills:.*\n/, '\n'));
  const r = sync(now);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, new RegExp(`note: the mount ${now}/projects/dev-root is no longer configured; its wiring is kept`), 'told by its new path');
  const kept = () => readJson(join(now, '.claude', 'settings.local.json')).claudeMdExcludes.filter((e) => e.includes('/projects/dev-root/'));
  assert.equal(kept().length, 3, 'kept as written, a removed mount\'s wiring is the person\'s to prune');

  const dry = sync(now, '--prune', '--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.equal(kept().length, 3, 'the dry run writes nothing');
  assert.equal(sync(now, '--prune').status, 0);
  assert.deepEqual(kept(), []);
  assert.deepEqual(naming(now, dir), [], 'nothing names the old root once pruned');
  assert.equal(sync(now, '--check').status, 0);
});

// The core moved together with the installation (D-S5-CORE-MOVED): the old core path stays in
// `permissions.additionalDirectories` unless sync wrote it — then it is recorded as `coreDirs` in
// .local/sync.json and a moved installation replaces it. `OLD_CORE` stands for the core's former place.
const OLD_CORE = `/old/place/${CORE.split('/').pop()}`;
const SETTINGS = ['.claude', 'settings.local.json'];

/** Replaces the additionalDirectories of the installation `now` by `change(list)`. */
function setDirectories(now, change) {
  const path = join(now, ...SETTINGS);
  const settings = readJson(path);
  write(path, `${JSON.stringify({ ...settings, permissions: { ...settings.permissions, additionalDirectories: change(settings.permissions.additionalDirectories) } }, null, 2)}\n`);
}

/**
 * `now` as if its core had been at OLD_CORE when sync last ran: the entry there, and in sync's record
 * unless `record` is 'none' (a record that predates the key) or 'person' (an entry sync did not write).
 */
function oldCore(now, record = 'sync') {
  setDirectories(now, (list) => list.map((d) => (d === realpathSync(CORE) ? OLD_CORE : d)));
  const { coreDirs, ...state } = readJson(join(now, '.local', 'sync.json'));
  assert.deepEqual(coreDirs, [realpathSync(CORE)], 'a first sync records the core path it wrote');
  write(join(now, '.local', 'sync.json'), `${JSON.stringify(record === 'sync' ? { ...state, coreDirs: [OLD_CORE] } : state, null, 2)}\n`);
}

const directories = (now) => readJson(join(now, ...SETTINGS)).permissions.additionalDirectories;

test('a recorded old core path is replaced by the new one, the person\'s entries stay, and the check is green', () => {
  const { dir, own } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  oldCore(now);
  setDirectories(now, (list) => ['/elsewhere/notes', ...list]);

  const red = sync(now, '--check');
  assert.equal(red.status, 1, red.output);
  assert.match(red.stdout, new RegExp(`out of date: \\.claude/settings\\.local\\.json additionalDirectories \\(drops the old core ${OLD_CORE}\\)`));
  assert.ok(directories(now).includes(OLD_CORE), '--check writes nothing');

  const fixed = sync(now);
  assert.equal(fixed.status, 0, fixed.output);
  const after = directories(now);
  assert.ok(!after.includes(OLD_CORE), 'the old core is gone');
  assert.ok(after.includes(realpathSync(CORE)), 'the new one is there');
  assert.ok(after.includes('/elsewhere/notes') && after.includes(own), 'the person\'s entry and the outside mount stay');
  assert.deepEqual(readJson(join(now, '.local', 'sync.json')).coreDirs, [realpathSync(CORE)]);
  assert.equal(sync(now, '--check').status, 0);
});

test('a core path sync did not record is the person\'s: it stays, the note says so', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  oldCore(now, 'person');
  const fixed = sync(now);
  assert.equal(fixed.status, 0, fixed.output);
  assert.ok(directories(now).includes(OLD_CORE), 'stale, but not sync\'s to remove');
  assert.ok(directories(now).includes(realpathSync(CORE)));
  assert.match(fixed.stdout, new RegExp(`note: \\.claude/settings\\.local\\.json additionalDirectories still lists ${OLD_CORE}`));
  assert.equal(sync(now, '--check').status, 0);
});

test('a record that predates the key: the old entry stays, nothing crashes, the check explains', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  oldCore(now, 'none');
  assert.equal(readJson(join(now, '.local', 'sync.json')).coreDirs, undefined);
  const red = sync(now, '--check');
  assert.equal(red.status, 1, red.output);
  assert.match(red.stdout, new RegExp(`note: \\.claude/settings\\.local\\.json additionalDirectories still lists ${OLD_CORE}.*remove it by hand`));
  assert.ok(directories(now).includes(OLD_CORE));
  const fixed = sync(now);
  assert.equal(fixed.status, 0, fixed.output);
  assert.ok(directories(now).includes(OLD_CORE) && directories(now).includes(realpathSync(CORE)));
  assert.deepEqual(readJson(join(now, '.local', 'sync.json')).coreDirs, [realpathSync(CORE)], 'the new entry is recorded from now on');
});

test('--dry-run on a moved installation with a recorded old core path writes nothing', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  const now = moved(dir);
  oldCore(now);
  const files = ['.claude/settings.local.json', '.local/sync.json', '.mcp.json'];
  const before = files.map((f) => readFileSync(join(now, f), 'utf8'));
  const r = sync(now, '--dry-run');
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, new RegExp(`would write: \\.claude/settings\\.local\\.json additionalDirectories \\(drops the old core ${OLD_CORE}\\)`));
  assert.deepEqual(files.map((f) => readFileSync(join(now, f), 'utf8')), before);
});

test('an installation that did not move reports nothing about the core; its record holds the one entry', () => {
  const { dir } = mounted();
  assert.equal(sync(dir).status, 0);
  assert.deepEqual(readJson(join(dir, '.local', 'sync.json')).coreDirs, [realpathSync(CORE)]);
  for (const args of [['--check'], [], ['--dry-run']]) {
    const r = sync(dir, ...args);
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.stdout, /additionalDirectories|old core/);
  }
  assert.deepEqual(directories(dir).filter((d) => d === realpathSync(CORE)), [realpathSync(CORE)]);
});
