// `setup mount add|remove`: the helper that changes the declaration of mounts (ADR 0007), which a
// file tool may not (tools/hooks/mounts-lock.mjs). `--personal` edits `.local/mounts.yaml`, `--shared`
// the `mounts:` part of `oikos.yaml`; the rest of the file stays as it is. `--dry-run` prints the diff
// and writes nothing; a change that brings a problem is refused. The command is a write (tools/hooks/
// writes.mjs): the write guard has the user confirm the dry run first.
import { UsageError } from '../common/cli.mjs';
import { installProblem, installRoot } from '../common/paths.mjs';
import { unifiedDiff } from '../common/diff.mjs';
import { writeFileAtomic } from '../common/tracking-config.mjs';
import { changeMounts, mountEntry } from '../common/mount-config.mjs';

const list = (text) => (text ? String(text).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

/** The layer the command works on: exactly one of `--personal` and `--shared`. */
function layerOf(v) {
  if (Boolean(v.personal) === Boolean(v.shared)) throw new UsageError('name the layer: --personal (.local/mounts.yaml) or --shared (the mounts: part of oikos.yaml)');
  return v.shared ? 'shared' : 'local';
}

const ENTRY_OPTIONS = ['use', 'skills-only', 'prefix', 'wiki-name', 'commit-pointers'];

/** The change `verb` asks for on the mount `path`. */
function changeOf(verb, path, v) {
  if (verb === 'remove') {
    if (ENTRY_OPTIONS.some((option) => v[option] !== undefined)) throw new UsageError('mount remove takes only the path and the layer');
    return { remove: path };
  }
  const entry = mountEntry({ use: list(v.use), only: list(v['skills-only']), prefix: v.prefix, wikiName: v['wiki-name'], commit: v['commit-pointers'] });
  return { add: { path, entry } };
}

/**
 * Run `mount <add|remove> <path>` with the parsed options.
 * @param {object} v the command's option values
 * @param {string[]} positionals the verb and the path
 * @returns {number} the exit code
 */
function runMount(v, positionals) {
  const root = installRoot();
  if (!root) throw new UsageError(installProblem());
  const [verb, path, ...extra] = positionals;
  if (!['add', 'remove'].includes(verb) || !path || extra.length) throw new UsageError('usage: mount add|remove <path> (--personal | --shared) [options] [--dry-run]');
  const layer = layerOf(v);
  const asked = changeOf(verb, path, v);
  const result = changeMounts(root, layer, asked);
  const diff = unifiedDiff(result.before, result.after, { labels: [`${result.label} (current)`, `${result.label} (new)`] });
  console.log(diff.length ? diff.join('\n') : `${result.label}: no change`);
  if (result.problems.length) throw new UsageError(`nothing written — the change would bring problems:\n${result.problems.map((p) => `  ${p}`).join('\n')}`);
  if (v['dry-run']) {
    console.log(`dry run: nothing written. Run the same command without --dry-run, after the user confirms, to change ${result.label}; then \`node oikos/tools/sync/cli.mjs\`.`);
    return 0;
  }
  writeFileAtomic(result.after, result.file);
  console.log(`wrote ${result.label}. Next: \`node oikos/tools/sync/cli.mjs\` wires the mount.`);
  return 0;
}

/** The `mount` command of `setup`. */
export const mountCommand = {
  help: 'add or remove a mount (another repository the installation uses as a source of notes or skills): add|remove <path> '
    + '(--personal = .local/mounts.yaml, --shared = the mounts: part of oikos.yaml; --use wiki,skills; --skills-only a,b; --prefix P; '
    + '--wiki-name N; --commit-pointers: personal entry of an inside mount only, its skill pointers may be committed; --dry-run shows the diff and writes nothing); '
    + 'a change that would bring a problem is refused',
  options: {
    personal: { type: 'boolean' }, shared: { type: 'boolean' }, use: { type: 'string' }, 'skills-only': { type: 'string' },
    prefix: { type: 'string' }, 'wiki-name': { type: 'string' }, 'commit-pointers': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  },
  run: runMount,
};
