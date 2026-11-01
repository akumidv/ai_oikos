// The skills a mount offers (docs/design/mounts.md § What `sync` writes per mount, item 4): one per
// skill folder under the mount's `skills.from` that has a SKILL.md, named `<prefix>-<folder>` (the
// prefix and the length of the name are checked in mounts.mjs). Both `sync` (the pointers) and
// `landscape` (the origin) read the list from here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatter } from './landscape.mjs';
import { hasPointer, pointerName, skillFolders } from './mounts.mjs';

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
 * `file` the real path of its SKILL.md. Empty for a mount that is not used for skills, whose
 * `skills.from` is missing or that has no usable prefix; a skill whose pointer name is over the
 * limit is left out (each a problem reported by config()).
 * @param {object} m a resolved mount (tools/common/mounts.mjs)
 * @returns {{dir: string, name: string, file: string, description: string}[]}
 */
export function mountSkills(m) {
  return skillFolders(m)
    .filter((dir) => hasPointer(m, dir))
    .map((dir) => {
      const file = join(m.root, m.skills.from, dir, 'SKILL.md');
      return { dir, name: pointerName(m, dir), file, description: descriptionOf(file, `The ${dir} skill of the mount ${m.path}`) };
    });
}
