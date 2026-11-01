// The skills a mount offers (docs/design/mounts.md § What `sync` writes per mount, item 4): one per
// skill folder under the mount's `skills.from` that has a SKILL.md, named `<prefix>-<folder>`. Both
// `sync` (the pointers) and `landscape` (the origin) read the list from here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { frontmatter } from './landscape.mjs';

/**
 * The prefix of a mount's skill pointers: `skills.prefix`, else the last folder of the declared
 * path, lowercased, with anything but a-z, 0-9 and - turned into -.
 */
export const skillPrefix = (m) => m.skills.prefix ?? basename(m.path).toLowerCase().replace(/[^a-z0-9-]/g, '-');

/** The `description` of the skill file `file`, or `fallback` when it has none or its frontmatter does not read. */
function descriptionOf(file, fallback) {
  try {
    const description = frontmatter(readFileSync(file, 'utf8'))?.fm.description;
    return typeof description === 'string' && description.trim() ? description.trim() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The skills of a mount used for skills — those named in `skills.only` when it is set, by folder
 * name — each `{ dir, name, file, description }`: `name` is the pointer's name (`<prefix>-<dir>`),
 * `file` the real path of its SKILL.md. Empty for a mount that is not used for skills or whose
 * `skills.from` is missing (a problem reported by config()).
 * @param {object} m a resolved mount (tools/common/mounts.mjs)
 * @returns {{dir: string, name: string, file: string, description: string}[]}
 */
export function mountSkills(m) {
  if (!m.skills || !existsSync(join(m.root, m.skills.from))) return [];
  const prefix = skillPrefix(m);
  return readdirSync(join(m.root, m.skills.from)).sort()
    .filter((dir) => (m.skills.only ? m.skills.only.includes(dir) : true))
    .map((dir) => ({ dir, file: join(m.root, m.skills.from, dir, 'SKILL.md') }))
    .filter(({ file }) => existsSync(file))
    .map(({ dir, file }) => ({ dir, name: `${prefix}-${dir}`, file, description: descriptionOf(file, `The ${dir} skill of the mount ${m.path}`) }));
}
