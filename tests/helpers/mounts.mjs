// Shared pieces of the mounts tests (mounts.test.mjs, mounts-edit.test.mjs): real `git init` mounts in
// a temporary installation (ACME Corp), the installation with its three mounts, sync, the resolved
// configuration as an agent's tool sees it, and a guard run through the hook dispatcher.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanEnv, installation, script, tempDir, tool } from './installation.mjs';

/** A git environment that ignores the developer's own global ignore rules, so what git ignores is only what the test set up. */
const gitEnv = () => ({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: tempDir('xdg-') });
export const ENV = gitEnv();

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

/** A new empty repository at `path` (created when absent). */
export function repository(path) {
  mkdirSync(path, { recursive: true });
  const r = spawnSync('git', ['init', '-q', path], { encoding: 'utf8', env: cleanEnv(ENV) });
  assert.equal(r.status, 0, r.stderr);
  return path;
}

/** A skill folder `name` with a SKILL.md under `from` of the mount `root`. */
export const skill = (root, from, name) => write(join(root, from, name, 'SKILL.md'), `---\nname: ${name}\ndescription: a skill of the mount\n---\n`);

/** `git status --porcelain` of the repository `root`: what its owner would see as changed. */
export const status = (root) => spawnSync('git', ['-C', root, 'status', '--porcelain', '-uall'], { encoding: 'utf8', env: cleanEnv(ENV) }).stdout.trim();

/**
 * An installation with the three mounts: `vaults/team` (shared, a wiki named team), `projects/dev-root`
 * (shared, skills from .claude/skills) and an outside wiki, `own` (local, the default wiki).
 * `dir` is the real path, so the absolute paths the tests compare are the ones sync writes.
 */
export function mounted({ shared = '', local = '' } = {}) {
  const dir = realpathSync(installation((t) => `${t.trimEnd()}

mounts:
  vaults/team:
    use: [wiki]
    wiki: { name: team, rules: NOTES.md, inbox: inbox/ }
  projects/dev-root:
    use: [skills]
    skills: { from: .claude/skills, prefix: dev, only: [deploy-status] }
${shared}`));
  const team = repository(join(dir, 'vaults', 'team'));
  const dev = repository(join(dir, 'projects', 'dev-root'));
  skill(dev, '.claude/skills', 'deploy-status');
  skill(dev, '.claude/skills', 'search-artifacts');
  const own = realpathSync(repository(tempDir('own-vault-')));
  write(join(dir, '.local', 'mounts.yaml'), `mounts:
  ${own}:
    use: [wiki]
    wiki: { name: own, default: true }
${local}`);
  return { dir, team, dev, own };
}

export const sync = (dir, ...args) => tool(dir, 'sync', args, ENV);

/** The configuration problems and resolved mounts, as an agent's tool sees them from `dir`. */
export function configOf(dir) {
  const r = script(dir, "import { config } from './oikos/tools/common/config.mjs'; console.log(JSON.stringify({ mounts: config().mounts, problems: config().problems }));");
  assert.equal(r.status, 0, r.output);
  return JSON.parse(r.stdout);
}

/** Run a guard through the dispatcher with the host's payload (and `env` on top of the environment); the decision it printed, or {}. */
export function hook(dir, guard, payload, env = {}) {
  const r = spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'hooks', 'host-hook.mjs'), guard],
    { cwd: dir, input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: dir, ...env }) });
  return r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : {};
}
