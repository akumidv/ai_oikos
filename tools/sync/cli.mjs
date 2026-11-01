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
//     so the host reads oikos through the `oikos/` link without asking; for Qwen, `oikos` in
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
// installation's Chrome is stopped.
// `--check` changes nothing and exits 1 on any problem or drift.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { CORE_ROOT } from '../common/env.mjs';
import { installRoot, INSTALL_FILE } from '../common/paths.mjs';
import { taskTrackingConflicts } from '../common/transitions.mjs';
import { loadLandscape } from '../common/landscape.mjs';
import { config } from '../common/config.mjs';
import { moveLocalStores } from '../common/local-stores.mjs';
import { PEOPLE_IGNORE_COMMENT, PEOPLE_IGNORE_LINE } from '../common/people.mjs';
import { chromeRunning } from '../browser/cli.mjs';
import { WRITES } from '../hooks/writes.mjs';
import { wireMounts } from './mounts.mjs';
import { MARKER, isOurs, pointer, mountPointers } from './pointers.mjs';
import { HOSTS, hostNames, settingsFile, hooksFor, guardsIn, mergeHooks } from '../hooks/wiring.mjs';

const check = process.argv.includes('--check');
const { resources, skills, agents, problems } = loadLandscape();
const changed = [];
const INSTALL = installRoot();
const TARGET = INSTALL || CORE_ROOT; // the folder whose wiring is written
const BASE = INSTALL ? 'oikos/' : ''; // where oikos is, seen from that folder
const CORE_REAL = realpathSync(CORE_ROOT);

function write(path, content, label) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  changed.push(label);
  if (!check) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

/** One edit of tools/sync/mounts.mjs: write the file, or remove it when `content` is null. */
function apply({ path, content, label }) {
  if (content !== null) return write(path, content, label);
  changed.push(label);
  if (!check) rmSync(path, { force: true });
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
    if (d.isDirectory() && !names.includes(d.name) && isOurs(join(wired, d.name, 'SKILL.md'))) {
      changed.push(`${HOSTS[host].dir}/skills/${d.name} (${INSTALL ? 'stale' : 'not wired in the core repository'})`);
      if (!check) rmSync(join(wired, d.name), { recursive: true });
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
  const base = existsSync(path) ? current : HOSTS[host].seed;
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
  // The core's real path, machine-specific, so in the git-ignored local settings. Claude Code
  // resolves the `oikos/` link and would otherwise ask before reading the skills it points at.
  const path = join(INSTALL, '.claude', 'settings.local.json');
  const local = readJson(path, '.claude/settings.local.json');
  if (local) {
    const dirs = local.permissions?.additionalDirectories || [];
    if (!dirs.includes(CORE_REAL)) {
      write(path, json({ ...local, permissions: { ...local.permissions, additionalDirectories: [...dirs, CORE_REAL] } }), '.claude/settings.local.json additionalDirectories');
    }
  }

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

  // -- MCP servers ------------------------------------------------------------------------
  // Every host reads .mcp.json — Qwen Code only once its servers are approved for this folder
  // (`qwen mcp approve --all`, again after an entry here changes; BOOTSTRAP.md). oikos brings the browser's DevTools server; the installation adds
  // its own (a knowledge base, …), and one of the same name replaces oikos's. The names oikos
  // wrote are kept in .local/sync.json, so a server it no longer wants goes and a server someone
  // else added stays.
  const CORE_MCP = {
    'chrome-devtools': { type: 'stdio', command: 'node', args: [join(CORE_REAL, 'tools', 'browser', 'mcp.mjs')], env: { OIKOS_HOME: INSTALL } },
  };
  const servers = { ...CORE_MCP, ...config().mcp_servers };
  const statePath = join(INSTALL, '.local', 'sync.json');
  const state = readJson(statePath, '.local/sync.json') || {};
  const mcpPath = join(INSTALL, '.mcp.json');
  const mcp = readJson(mcpPath, '.mcp.json');
  if (mcp) {
    const kept = Object.fromEntries(Object.entries(mcp.mcpServers || {}).filter(([name]) => !(state.mcp || []).includes(name) && !(name in servers)));
    write(mcpPath, json({ ...mcp, mcpServers: { ...servers, ...kept } }), '.mcp.json');
  }

  // -- mounts -----------------------------------------------------------------------------
  // tools/sync/mounts.mjs computes the wiring of the declared mounts (docs/design/mounts.md) as file
  // edits; what it wrote is recorded in the same .local/sync.json, beside the MCP names.
  const wiredMounts = wireMounts(INSTALL, config().mounts, state.mounts, mountPlan.pointers);
  problems.push(...wiredMounts.problems);
  for (const edit of wiredMounts.edits) apply(edit);
  const recordMounts = Object.keys(wiredMounts.record).length > 0 || state.mounts !== undefined;
  if (mcp || recordMounts) {
    write(statePath, json({ ...state, ...(mcp ? { mcp: Object.keys(servers) } : {}), ...(recordMounts ? { mounts: wiredMounts.record } : {}) }), '.local/sync.json');
  }

  // -- stores of .local/ ------------------------------------------------------------------
  // A store at its old place is moved to its dot-named one, which the secret guard keeps closed
  // by name; the old names are closed too, so a store left in place is never open meanwhile.
  for (const m of await moveLocalStores(INSTALL, { check, browserRunning: () => chromeRunning() })) {
    const move = `${m.from} → ${m.to}`;
    if (m.state === 'moved' || m.state === 'out of date') changed.push(move);
    // A failed move is a problem: the rest of sync runs, and it exits 1 like on any other problem.
    else if (m.state === 'failed') problems.push(`${move} not moved (${m.error}); it is still used where it is`);
    else if (m.state === 'running') console.log(`note: ${move} not moved — this installation's Chrome is running; stop it (node oikos/tools/browser/cli.mjs stop) and sync again`);
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
for (const c of changed) console.log(`${check ? 'out of date' : 'wrote'}: ${c}`);
console.log(`${skills.length} skill(s), ${agents.length} agent(s), ${resources.length} resource(s), ${problems.length} problem(s), ${changed.length} ${check ? 'out of date' : 'change(s)'}`);
process.exit(problems.length || (check && changed.length) ? 1 : 0);
