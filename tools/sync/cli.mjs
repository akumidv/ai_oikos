#!/usr/bin/env node
// Keep the generated wiring in step with its sources and check the sources. Where it writes
// depends on where it runs (common/paths.mjs):
// - in an installation (or with OIKOS_HOME set to one), the installation's wiring, every entry
//   leading into `oikos/`:
//   - skills/<name>/SKILL.md → a pointer in every agent host's skill folder (.claude/skills/,
//     .qwen/skills/), `../../../oikos/skills/<name>/SKILL.md`; an agent the installation switches on
//     (`agents:` of oikos.yaml) gets one in the same folders, to `agents/<name>/README.md` (ADR 0006);
//   - tools/hooks/wiring.mjs → oikos's entries in the `hooks` of every host's settings file,
//     `$CLAUDE_PROJECT_DIR/oikos/tools/hooks/host-hook.mjs`;
//   - oikos's own MCP servers plus the installation's (`mcp_servers` of oikos.yaml) → .mcp.json,
//     git-ignored, with this machine's absolute paths and OIKOS_HOME;
//   - the core's real path → `permissions.additionalDirectories` of .claude/settings.local.json,
//     so the host reads oikos through the `oikos/` link without asking (recorded as `coreDirs` in
//     .local/sync.json; a moved installation drops a recorded entry of the old core); for Qwen, `oikos` in
//     `context.includeDirectories` of .qwen/settings.json does the same;
//   - the declared mounts (`mounts` of oikos.yaml and .local/mounts.yaml) → rule exclusions both ways
//     for an inside mount, its real path in `additionalDirectories` for an outside one, and the
//     files written inside a mount in its `.git/info/exclude` (tools/sync/mounts.mjs); a mount used
//     for skills also gets a pointer per skill, `<prefix>-<name>`, in the same folders as the skills'
//     (tools/sync/pointers.mjs), those of an outside or local-layer mount kept out of the
//     installation's commits by its own `.git/info/exclude`;
// - in the core repository, only its own hooks (`$CLAUDE_PROJECT_DIR/tools/hooks/…`): it is where
//   oikos is developed, not used, so it gets no skill pointers and no MCP servers.
// Sync owns only its entries: another tool's hooks, skills and MCP servers (akmon's, the person's)
// survive it. Its skill pointers carry a marker; its MCP servers and mount wiring are listed in .local/sync.json.
// The resource notes and the skills' frontmatter are checked, never copied: the overview is
// computed on request (tools/landscape).
// In an installation it also appends `.local/private.yaml` (the people file) to the root `.gitignore`
// when that exists without the line, and moves the stores of `.local/` still at their old places to their
// dot-named ones (common/local-stores.mjs, ADR 0002): the browser profile only while this
// installation's Chrome is stopped — and, under the same condition, the browser store's content
// to akmon's names (`chrome-profile-cft`, `chrome/chrome/`, ADR 0009).
// `--check` changes nothing and exits 1 on any problem or drift.
// A moved installation is told by the root an earlier sync wrote into .mcp.json (`OIKOS_HOME` of oikos's
// own server): when that is another folder, every generated file that names it is out of date and
// says so, and sync rewrites them to this root — the mounts' record in .local/sync.json is carried
// over to the new paths first, so the entries written for the old root are replaced, not left behind.
// A mount that has disappeared from the configuration keeps its wiring — ignore lines, rule exclusions,
// pointers, the recorded root — and sync says so with a `note:`; `--prune` takes it away, and is a
// guarded write (tools/hooks/writes.mjs): the same command with `--dry-run` first, which lists what
// would change and writes nothing (it exits 1 only on a problem, as `--check` also does on drift).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { CORE_ROOT } from '../common/env.mjs';
import { installRoot, INSTALL_FILE } from '../common/paths.mjs';
import { taskTrackingConflicts } from '../common/transitions.mjs';
import { loadLandscape } from '../common/landscape.mjs';
import { config } from '../common/config.mjs';
import { moveBrowserParts, moveLocalStores } from '../common/local-stores.mjs';
import { outgoingRules } from '../common/outgoing.mjs';
import { PEOPLE_IGNORE_COMMENT, PEOPLE_IGNORE_LINE } from '../common/people.mjs';
import { buildRunning, chromeRunning } from '../browser/running.mjs';
import { WRITES } from '../hooks/writes.mjs';
import { goneRoots, namesRoot, wireMounts } from './mounts.mjs';
import { MARKER, isOurs, pointer, mountPointers } from './pointers.mjs';
import { HOSTS, hostNames, settingsFile, hooksFor, guardsIn, mergeHooks, migrateSeededRules } from '../hooks/wiring.mjs';

// Options are read only before `--`, as the write guard reads them: otherwise `sync -- --prune` would
// prune with no dry run the guard could see.
const argsEnd = process.argv.indexOf('--', 2);
const flags = argsEnd < 0 ? process.argv.slice(2) : process.argv.slice(2, argsEnd);
const check = flags.includes('--check');
const dryRun = flags.includes('--dry-run');
const prune = flags.includes('--prune');
const readOnly = check || dryRun; // nothing is written
const { resources, skills, agents, problems } = loadLandscape();
const changed = [];
const INSTALL = installRoot();
const TARGET = INSTALL || CORE_ROOT; // the folder whose wiring is written
const BASE = INSTALL ? 'oikos/' : ''; // where oikos is, seen from that folder
const CORE_REAL = realpathSync(CORE_ROOT);
const BROWSER_SERVER = 'akmon-browser'; // oikos's MCP server in .mcp.json (ADR 0009)
const LEGACY_BROWSER_SERVER = 'chrome-devtools'; // its name before, replaced when sync wrote it

let coreDirs = null; // the core path entries sync owns in additionalDirectories (null: the settings file could not be edited)
let movedFrom = null; // the installation root an earlier sync recorded, when it is not this one (set with the MCP servers)

function write(path, content, label) {
  const had = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (had === content) return;
  changed.push(movedFrom && had !== null && namesRoot(had, movedFrom) ? `${label} (names the old root ${movedFrom})` : label);
  if (!readOnly) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

/** One edit of tools/sync/mounts.mjs: write the file, or remove it when `content` is null. */
function apply({ path, content, label }) {
  if (content !== null) return write(path, content, label);
  changed.push(label);
  if (!readOnly) rmSync(path, { force: true });
}

function readJson(path, label) {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    problems.push(`${label}: not a JSON object`);
  } catch (e) {
    problems.push(`${label}: the file does not parse (${e.message.split('\n')[0]})`);
  }
  return null;
}

/**
 * The installation root `recorded` names, when it is not this installation's: an absolute path that
 * is neither `INSTALL` nor another way to reach it (a link). Null for anything else — nothing
 * recorded, not a path, or the same folder.
 */
function recordedRoot(recorded) {
  if (typeof recorded !== 'string' || !isAbsolute(recorded) || recorded === INSTALL) return null;
  try {
    if (realpathSync(recorded) === realpathSync(INSTALL)) return null;
  } catch { /* the recorded folder is gone: it is the old root */ }
  return recorded;
}

const json = (data) => `${JSON.stringify(data, null, 2)}\n`;

console.log(INSTALL ? `installation: ${INSTALL}` : `the oikos core repository (${CORE_REAL}): its own hooks only`);

// -- skill and agent pointers -------------------------------------------------------------
// One pointer per skill per host, byte-identical: each host's folder nests the skill at the same
// depth, so the relative link resolves the same wherever it was written. The pointer carries the
// skill's own `name` and `description` — that block is all a host reads before deciding whether a
// question belongs to the skill, so a pointer without one loads only when the skill is named.
// A standing agent the installation lists is delivered the same way (ADR 0006 D01): a pointer of
// the agent's name in the same folder, to its charter, so both hosts need no machinery of their own.
// A folder without the marker is someone else's skill and is left alone.
// The template, the marker and the pointers of the mounts' skills are in tools/sync/pointers.mjs.
const agentPointer = (fm) => `---
name: ${fm.name}
description: ${fm.description}
---

# ${fm.name}

${MARKER}

Standing agent: [../../../${BASE}agents/${fm.name}/README.md](../../../${BASE}agents/${fm.name}/README.md)

Start this agent: read its charter and follow it — its mission, the skills it uses, what it owns and what it never does. Do not duplicate its contents here.
`;

// What an earlier sync wrote besides the files: the MCP servers' names and the mounts' wiring.
const statePath = INSTALL ? join(INSTALL, '.local', 'sync.json') : null;
const state = (INSTALL && readJson(statePath, '.local/sync.json')) || {};

const oikosPointers = INSTALL
  ? [...skills.map((s) => ({ name: s.dir, text: () => pointer({ ...s, name: s.dir }, `../../../${BASE}skills/${s.dir}/SKILL.md`) })),
    ...agents.filter((a) => a.enabled).map((a) => ({ name: a.dir, text: () => agentPointer({ ...a, name: a.dir }) }))]
  : [];
// A mount used for skills adds one pointer per skill, next to oikos's own; one whose name an oikos
// pointer or another mount's already has is a problem and is not written.
const mountPlan = INSTALL ? mountPointers(INSTALL, config().mounts, oikosPointers.map((w) => w.name)) : { pointers: [], problems: [] };
problems.push(...mountPlan.problems);
const wanted = [...oikosPointers, ...mountPlan.pointers];
const names = wanted.map((w) => w.name);
// The pointers of a mount that has gone stay until --prune (tools/sync/mounts.mjs): they are not stale.
const heldPointers = INSTALL && !prune ? goneRoots(config().mounts, state.mounts).flatMap((root) => state.mounts[root]?.pointers ?? []) : [];
for (const host of hostNames) {
  const wired = join(TARGET, HOSTS[host].dir, 'skills');
  for (const w of wanted) {
    const file = join(wired, w.name, 'SKILL.md');
    if (existsSync(join(wired, w.name)) && !isOurs(file)) {
      problems.push(`${HOSTS[host].dir}/skills/${w.name}: a skill of the same name that oikos did not write — rename one of them`);
      continue;
    }
    write(file, w.text(HOSTS[host].dir), `${HOSTS[host].dir}/skills/${w.name}/SKILL.md`);
  }
  if (!existsSync(wired)) continue;
  for (const d of readdirSync(wired, { withFileTypes: true })) {
    if (d.isDirectory() && !names.includes(d.name) && !heldPointers.includes(d.name) && isOurs(join(wired, d.name, 'SKILL.md'))) {
      changed.push(`${HOSTS[host].dir}/skills/${d.name} (${INSTALL ? 'stale' : 'not wired in the core repository'})`);
      if (!readOnly) rmSync(join(wired, d.name), { recursive: true });
    }
  }
}

// -- agent host settings ------------------------------------------------------------------
// tools/hooks/wiring.mjs is the source of oikos's entries in the `hooks` key; every other entry
// and every other key belong to the host, the person or another tool, so the generated part is
// merged into the file instead of replacing it.
for (const host of hostNames) {
  const path = join(TARGET, settingsFile(host));
  const label = `${settingsFile(host)} hooks`;
  const hooks = hooksFor(host, BASE);
  const current = readJson(path, label);
  if (!current) continue;
  const want = guardsIn(hooks);
  const have = guardsIn(current.hooks || {});
  for (const key of new Set([...Object.keys(want), ...Object.keys(have)])) {
    const w = (want[key] || []).join(', ') || 'nothing';
    const h = (have[key] || []).join(', ') || 'nothing';
    if (check && existsSync(path) && w !== h) problems.push(`${label}: ${key} wires ${h}, tools/hooks/wiring.mjs says ${w} — sync`);
  }
  // The read-only rules seeded under the old server name become the new ones; the rest of the file is the host's.
  const base = existsSync(path) ? migrateSeededRules(current) : HOSTS[host].seed;
  const settings = { ...base, hooks: mergeHooks(current.hooks || {}, hooks) };
  write(path, json(INSTALL && host === 'qwen' ? withOikosIncluded(settings) : settings), settingsFile(host));
}

/**
 * Qwen settings with `oikos` in `context.includeDirectories`: Qwen refuses every read through the
 * `oikos/` link otherwise. Relative, so it resolves against the start folder and Qwen follows the
 * link itself — Qwen's counterpart of Claude's `additionalDirectories` below. Other entries stay.
 */
function withOikosIncluded(settings) {
  const dirs = settings.context?.includeDirectories || [];
  if (dirs.includes('oikos')) return settings;
  return { ...settings, context: { ...settings.context, includeDirectories: [...dirs, 'oikos'] } };
}

if (INSTALL) {
  // -- the people file stays out of git --------------------------------------------------
  // `.local/` is ignored as a whole; the people file (personal data on purpose) is also named, so
  // it stays out of git even if `.local/` is ever un-ignored. Only an installation that has a
  // `.gitignore` (is in git) is touched, and only by appending: no other line is rewritten.
  const gitignore = join(INSTALL, '.gitignore');
  if (existsSync(gitignore)) {
    const text = readFileSync(gitignore, 'utf8');
    if (!text.split(/\r?\n/).some((line) => line.trim() === PEOPLE_IGNORE_LINE)) {
      write(gitignore, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}\n${PEOPLE_IGNORE_COMMENT}\n${PEOPLE_IGNORE_LINE}\n`, `.gitignore (${PEOPLE_IGNORE_LINE})`);
    }
  }

  // -- the content check's rules ------------------------------------------------------------
  // .local/outgoing.yaml is read by the write tools at the command; a file that cannot be used, or an
  // `allow:` entry that is ignored (too short), is reported here too, where the person looks.
  try {
    problems.push(...outgoingRules(INSTALL).problems);
  } catch (e) {
    problems.push(e.message);
  }

  // -- MCP servers ------------------------------------------------------------------------
  // Every host reads .mcp.json — Qwen Code only once its servers are approved for this folder
  // (`qwen mcp approve --all`, again after an entry here changes; BOOTSTRAP.md). oikos brings the browser's
  // `akmon-browser` server (ADR 0009); the installation adds
  // its own (a knowledge base, …), and one of the same name replaces oikos's. The names oikos
  // wrote are kept in .local/sync.json, so a server it no longer wants goes and a server someone
  // else added stays — which is how the `chrome-devtools` entry an earlier sync wrote is replaced.
  const CORE_MCP = {
    [BROWSER_SERVER]: { type: 'stdio', command: 'node', args: [join(CORE_REAL, 'tools', 'browser', 'mcp.mjs')], env: { OIKOS_HOME: INSTALL } },
  };
  const servers = { ...CORE_MCP, ...config().mcp_servers };
  const mcpPath = join(INSTALL, '.mcp.json');
  const mcp = readJson(mcpPath, '.mcp.json');
  // Only oikos's own entry tells: one the installation overrides, or one sync did not write, is not evidence.
  // An installation not synced since the rename still has the entry under its old name: read it there.
  const ownEntry = [BROWSER_SERVER, LEGACY_BROWSER_SERVER].find((name) => (state.mcp || []).includes(name) && mcp?.mcpServers?.[name]
    && (name === BROWSER_SERVER ? servers[name] === CORE_MCP[name] : !(name in config().mcp_servers)));
  movedFrom = ownEntry && servers[BROWSER_SERVER] === CORE_MCP[BROWSER_SERVER] ? recordedRoot(mcp.mcpServers[ownEntry].env?.OIKOS_HOME) : null;
  if (movedFrom) console.log(`note: this installation was moved — an earlier sync recorded ${movedFrom}; what names it is rewritten to ${INSTALL}`);
  if (mcp) {
    const kept = Object.fromEntries(Object.entries(mcp.mcpServers || {}).filter(([name]) => !(state.mcp || []).includes(name) && !(name in servers)));
    write(mcpPath, json({ ...mcp, mcpServers: { ...servers, ...kept } }), '.mcp.json');
  }

  // -- the core's path in the host's file access ---------------------------------------------
  // The core's real path, machine-specific, so in the git-ignored local settings. Claude Code
  // resolves the `oikos/` link and would otherwise ask before reading the skills it points at.
  // The list is append-only, with one exception (D-S5-CORE-MOVED): when the installation moved, a
  // core path an earlier sync recorded in `.local/sync.json` (`coreDirs`) and that is not this core's
  // is dropped. An entry sync did not record — the person's, or one written before the record existed —
  // is never removed. Sync's mount entries are recorded under `mounts` (tools/sync/mounts.mjs).
  const settingsPath = join(INSTALL, '.claude', 'settings.local.json');
  const local = readJson(settingsPath, '.claude/settings.local.json');
  if (local && !Array.isArray(local.permissions?.additionalDirectories ?? [])) {
    problems.push('.claude/settings.local.json: permissions.additionalDirectories must be a list; the core path is not wired');
  } else if (local) {
    const dirs = local.permissions?.additionalDirectories || [];
    const recorded = Array.isArray(state.coreDirs) ? state.coreDirs.filter((d) => typeof d === 'string') : [];
    const stale = movedFrom ? recorded.filter((d) => d !== CORE_REAL && dirs.includes(d)) : [];
    const kept = dirs.filter((d) => !stale.includes(d));
    const added = kept.includes(CORE_REAL) ? [] : [CORE_REAL];
    if (stale.length || added.length) {
      write(settingsPath, json({ ...local, permissions: { ...local.permissions, additionalDirectories: [...kept, ...added] } }),
        `.claude/settings.local.json additionalDirectories${stale.length ? ` (drops the old core ${stale.join(', ')})` : ''}`);
    }
    // What sync owns here: the recorded entries still in the list, and the one it adds now.
    coreDirs = [...recorded.filter((d) => !stale.includes(d) && dirs.includes(d)), ...added];
    if (movedFrom && recorded.length === 0) {
      const leftover = dirs.filter((d) => d !== CORE_REAL && !existsSync(d) && d.endsWith(`/${basename(CORE_REAL)}`));
      if (leftover.length) console.log(`note: .claude/settings.local.json additionalDirectories still lists ${leftover.join(', ')}, which looks like the old core; sync did not record writing it, so it stays — remove it by hand`);
    }
  }

  // -- mounts -----------------------------------------------------------------------------
  // tools/sync/mounts.mjs computes the wiring of the declared mounts (docs/design/mounts.md) as file
  // edits; what it wrote is recorded in the same .local/sync.json, beside the MCP names.
  const wiredMounts = wireMounts(INSTALL, config().mounts, state.mounts, mountPlan.pointers, { prune, movedFrom });
  problems.push(...wiredMounts.problems);
  for (const edit of wiredMounts.edits) apply(edit);
  for (const { root, wiring } of wiredMounts.pending) {
    console.log(`note: the mount ${root} is no longer configured; its wiring is kept (${wiring}) — \`node oikos/tools/sync/cli.mjs --prune --dry-run\` shows what taking it away would change`);
  }
  const recordMounts = Object.keys(wiredMounts.record).length > 0 || state.mounts !== undefined;
  const recordCore = coreDirs !== null && (coreDirs.length > 0 || state.coreDirs !== undefined);
  if (mcp || recordMounts || recordCore) {
    const { coreDirs: _previous, ...rest } = state;
    write(statePath, json({ ...rest, ...(mcp ? { mcp: Object.keys(servers) } : {}), ...(recordMounts ? { mounts: wiredMounts.record } : {}), ...(recordCore ? { coreDirs } : {}) }), '.local/sync.json');
  }

  // -- stores of .local/ ------------------------------------------------------------------
  // A store at its old place is moved to its dot-named one, which the secret guard keeps closed
  // by name; the old names are closed too, so a store left in place is never open meanwhile.
  // Whether the Chrome runs is asked once for both moves: the store itself, then what akmon names differently in it.
  let running;
  const browserRunning = () => (running ??= chromeRunning());
  const moves = [...await moveLocalStores(INSTALL, { check: readOnly, browserRunning }), ...await moveBrowserParts(INSTALL, { check: readOnly, browserRunning, buildInUse: buildRunning })];
  for (const m of moves) {
    const move = `${m.from} → ${m.to}`;
    if (m.state === 'moved' || m.state === 'out of date') changed.push(move);
    // A failed move is a problem: the rest of sync runs, and it exits 1 like on any other problem.
    else if (m.state === 'failed') problems.push(`${move} not moved (${m.error}); it is still used where it is`);
    else if (m.state === 'running') console.log(`note: ${move} not moved — this installation's Chrome is running; stop it (node oikos/tools/browser/cli.mjs stop) and sync again`);
    else if (m.state === 'in use') console.log(`note: ${move} not moved — a process runs from ${m.from} (likely another installation's Chrome); stop it and sync again`);
    else if (m.shared) console.log(`note: ${m.from} and ${m.to} both exist; ${m.to} is the one akmon uses, and ${m.from} is left as it is — other installations may use it, check before you clean up`);
    else console.log(`note: ${m.from} left in place — ${m.to} exists too and is the one used; remove ${m.from} once nothing in it is needed`);
  }
}

// -- hook files ---------------------------------------------------------------------------
// A hook that cannot load is invisible: the dispatcher fails open, so a syntax error costs a
// guard, not a loud failure. The tools would report themselves; only the hooks need a look.
const hookErrors = [];
for (const file of readdirSync(join(CORE_ROOT, 'tools', 'hooks')).filter((f) => f.endsWith('.mjs')).sort()) {
  const r = spawnSync(process.execPath, ['--check', join(CORE_ROOT, 'tools', 'hooks', file)], { encoding: 'utf8' });
  if (r.status !== 0) hookErrors.push(`tools/hooks/${file}: ${(r.stderr || '').split('\n')[0]}`);
}
problems.push(...hookErrors);

// -- browser extension -------------------------------------------------------------------
// Chrome reports a missing file or a script that does not parse only when the extension is
// reloaded, on someone's machine; the manifest's files and the scripts' syntax are checked here.
const extDir = join(CORE_ROOT, 'extension');
if (existsSync(extDir)) {
  try {
    const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
    const files = [
      ...Object.values(manifest.icons || {}),
      ...Object.values(manifest.action?.default_icon || {}),
      manifest.action?.default_popup,
      ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ].filter(Boolean);
    for (const f of new Set(files)) if (!existsSync(join(extDir, f))) problems.push(`extension/manifest.json: ${f} does not exist`);
  } catch (e) {
    problems.push(`extension/manifest.json: ${e.message.split('\n')[0]}`);
  }
  const scripts = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? scripts(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : []);
  for (const file of scripts(extDir)) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) problems.push(`${relative(CORE_ROOT, file)}: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'does not parse'}`);
  }
}

// -- write guard list ---------------------------------------------------------------------
// tools/hooks/writes.mjs must name exactly the commands that take --dry-run, read from each
// tool's own --help, so a new write command cannot slip past the write guard. Every tool built on
// runCli is asked, listed or not, so a new tool with a write command fails here until it has an
// entry. A tool is a tools/<name>/cli.mjs that imports runCli from common/cli.mjs; the others
// (sync itself, which would run a sync instead of printing help) are not run.
const toolsDir = join(CORE_ROOT, 'tools');
const runCliTools = readdirSync(toolsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(toolsDir, d.name, 'cli.mjs')))
  .map((d) => d.name)
  .filter((tool) => /^import\s*\{[^}]*\brunCli\b[^}]*\}\s*from\s*'\.\.\/common\/cli\.mjs'/m.test(readFileSync(join(toolsDir, tool, 'cli.mjs'), 'utf8')));
for (const tool of Object.keys(WRITES)) {
  if (!existsSync(join(toolsDir, tool, 'cli.mjs'))) problems.push(`tools/hooks/writes.mjs: ${tool} has no tools/${tool}/cli.mjs`);
}
// One --help per command; run one at a time they were most of the check's time, so they run one
// at once per core and are judged afterwards, in order.
const helpOf = (cli, ...args) => new Promise((done) => {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.on('error', () => done(''));
  child.on('close', () => done(out));
});
/** The results of `jobs` (functions returning a promise), at most `limit` running at a time. */
async function inParallel(jobs, limit) {
  const results = [];
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}
const cliOf = (tool) => join(toolsDir, tool, 'cli.mjs');
const toolHelp = await inParallel(runCliTools.map((tool) => () => helpOf(cliOf(tool), '--help')), availableParallelism());
const commandsOf = runCliTools.map((_, i) => [...toolHelp[i].matchAll(/^ {2}([a-z][a-z-]*)\s/gm)].map((m) => m[1]));
const calls = runCliTools.flatMap((tool, i) => commandsOf[i].map((c) => ({ tool, c })));
const commandHelp = await inParallel(calls.map(({ tool, c }) => () => helpOf(cliOf(tool), c, '--help')), availableParallelism());
const dryRunCommands = (tool) => calls.filter((call, i) => call.tool === tool && /^ {2}--dry-run$/m.test(commandHelp[i])).map((call) => call.c);
for (const [i, tool] of runCliTools.entries()) {
  if (!commandsOf[i].length) { problems.push(`tools/${tool}: --help listed no commands`); continue; }
  const writes = dryRunCommands(tool);
  const listed = WRITES[tool];
  if (!listed) {
    for (const c of writes) problems.push(`tools/hooks/writes.mjs: ${tool} ${c} takes --dry-run but ${tool} has no entry`);
    continue;
  }
  for (const c of writes) if (!listed.includes(c)) problems.push(`tools/hooks/writes.mjs: ${tool} ${c} takes --dry-run but is not guarded`);
  for (const c of listed) if (!writes.includes(c)) problems.push(`tools/hooks/writes.mjs: ${tool} ${c} is not a --dry-run command`);
}

for (const p of problems) console.log(`problem: ${p}`);
// A rule that contradicts the organization's tracker policy is a warning, not a problem (ADR 0004 D02).
for (const w of taskTrackingConflicts(config()['task-tracking'])) console.log(`warning: ${INSTALL_FILE}: ${w}`);
for (const c of changed) console.log(`${check ? 'out of date' : dryRun ? 'would write' : 'wrote'}: ${c}`);
console.log(`${skills.length} skill(s), ${agents.length} agent(s), ${resources.length} resource(s), ${problems.length} problem(s), ${changed.length} ${check ? 'out of date' : dryRun ? 'to change (dry run: nothing written)' : 'change(s)'}`);
process.exit(problems.length || (check && changed.length) ? 1 : 0);
