// The one reader of oikos's self-description, and of how an installation uses it:
// - skills (skills/<name>/SKILL.md): one per kind of work — code hosting, task tracking, … — each
//   with the connectors it can drive (`connectors:`), one file per connector in
//   skills/<name>/connectors/<connector>.md;
// - the installation's `oikos.yaml` `connectors:` — which of them this organization uses
//   for each skill, the first being the default (config.mjs);
// - resource notes (the installation's resources/<id>.md — they describe one organization, so they
//   stay out of the core; absent until the user adds them), each naming in `via:` the skills or
//   connectors that reach it.
// Skills are the core's (CORE_ROOT); the configuration and the notes are the installation's, and
// outside one (the core repository) there are none.
// All are sources of truth; every view of them — the skill pointers sync writes, the `resources`
// and `skills` overviews of tools/landscape — is computed from what this module returns, so no second
// copy of a fact is kept anywhere.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { CORE_ROOT, installRoot, INSTALL_FILE, coreLabel } from './paths.mjs';
import { config } from './config.mjs';

export const SKILLS = join(CORE_ROOT, 'skills');
/** The installation's resource notes folder, or null outside an installation. */
export const resourcesDir = () => (installRoot() ? join(installRoot(), 'resources') : null);
const RES = 'resources';
const SKILL_KEYS = ['name', 'description', 'when_to_use', 'surface', 'refuses'];
const RESOURCE_KEYS = ['id', 'title', 'domain', 'status', 'resource', 'kind', 'network', 'url', 'auth'];

/** `---` YAML frontmatter and the body after it; throws when the YAML does not parse. */
export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = YAML.parse(m[1]);
  return fm && typeof fm === 'object' ? { fm, body: m[2] } : null;
}

/** A frontmatter value that may be a list or a comma-separated string, as a list. */
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

function read(file, label, problems) {
  try {
    const parsed = frontmatter(readFileSync(file, 'utf8'));
    if (!parsed) problems.push(`${label}: no frontmatter`);
    return parsed;
  } catch (e) {
    problems.push(`${label}: frontmatter does not parse (${e.message.split('\n')[0]})`);
    return null;
  }
}

/**
 * Skills, resources and the links between them, plus every schema problem found.
 * skills: [{ ...frontmatter, dir, connectors: [name], configured: [name] | null, file }]
 *   (`configured` null = the installation does not choose, every connector is available);
 * resources: [{ ...frontmatter, via: [name], purpose, file, skills: [name] }].
 */
export function loadLandscape() {
  const cfg = config();
  const problems = [...cfg.problems];

  const skills = [];
  const dirs = existsSync(SKILLS) ? readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  for (const dir of dirs) {
    const file = join(SKILLS, dir, 'SKILL.md');
    if (!existsSync(file)) { problems.push(`skills/${dir}: no SKILL.md`); continue; }
    const parsed = read(file, `skills/${dir}/SKILL.md`, problems);
    if (!parsed) continue;
    const { fm } = parsed;
    for (const k of SKILL_KEYS) if (!fm[k]) problems.push(`skills/${dir}/SKILL.md: missing '${k}'`);
    // The owner sits under `metadata:`, where the Agent Skills format and akmon's verify expect it.
    if (!fm.metadata?.owner) problems.push(`skills/${dir}/SKILL.md: missing 'metadata.owner'`);
    if (fm.name && fm.name !== dir) problems.push(`skills/${dir}/SKILL.md: name '${fm.name}' differs from the folder`);
    if (fm.resources !== undefined) problems.push(`skills/${dir}/SKILL.md: 'resources' is gone — a resource note names the skill in its 'via'`);
    const connectors = list(fm.connectors);
    const cdir = join(SKILLS, dir, 'connectors');
    const files = existsSync(cdir) ? readdirSync(cdir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : [];
    for (const c of connectors) if (!files.includes(c)) problems.push(`skills/${dir}/SKILL.md: connector '${c}' has no connectors/${c}.md`);
    for (const f of files) if (!connectors.includes(f)) problems.push(`skills/${dir}/connectors/${f}.md: not listed in the skill's 'connectors'`);
    const configured = cfg.connectors[dir] ?? null;
    for (const c of configured || []) if (!connectors.includes(c)) problems.push(`${INSTALL_FILE}: connectors.${dir} names '${c}', which the skill does not have (${connectors.join(', ') || 'none'})`);
    skills.push({ ...fm, dir, connectors, configured, file: coreLabel(`skills/${dir}/SKILL.md`) });
  }
  for (const s of Object.keys(cfg.connectors)) if (!dirs.includes(s)) problems.push(`${INSTALL_FILE}: connectors.${s} — no such skill`);

  // A name in a resource's `via` is a skill or one of a skill's connectors.
  const reachedBy = (name) => skills.filter((s) => s.dir === name || s.connectors.includes(name)).map((s) => s.dir);
  const resources = [];
  const notes = resourcesDir();
  for (const file of notes && existsSync(notes) ? readdirSync(notes).filter((f) => f.endsWith('.md')).sort() : []) {
    const parsed = read(join(notes, file), `${RES}/${file}`, problems);
    if (!parsed) continue;
    const { fm, body } = parsed;
    for (const k of RESOURCE_KEYS) if (!fm[k]) problems.push(`${RES}/${file}: missing '${k}'`);
    if (fm.resource && `${fm.resource}.md` !== file) problems.push(`${RES}/${file}: resource '${fm.resource}' differs from the file name`);
    if (fm.resource && fm.id !== `business-resources-${fm.resource}`) problems.push(`${RES}/${file}: id must be business-resources-${fm.resource}`);
    const via = list(fm.via);
    const reaching = new Set();
    for (const v of via) {
      const by = reachedBy(v);
      if (!by.length) problems.push(`${RES}/${file}: via '${v}' is neither a skill nor a connector`);
      by.forEach((s) => reaching.add(s));
    }
    const purpose = (body.match(/## What it is for\n+([\s\S]*?)(\n## |$)/)?.[1] || '').trim().replace(/\s+/g, ' ');
    resources.push({ ...fm, auth_env: list(fm.auth_env), via, purpose, file: `${RES}/${file}`, skills: [...reaching].sort() });
  }
  return { resources, skills, problems };
}
