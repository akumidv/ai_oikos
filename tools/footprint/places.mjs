// The user's settings of the footprint: where a piece of work was done — the organization, a
// personal project, another client — told apart by the repository, project or space it touched,
// and which commits and files are a tool's output rather than the person's writing. They come from
// `.local/footprint/config.yaml` (the user's working folder, the reports sit beside it; no secret in
// it) and the command line; what no rule names is the organization's — the tool never guesses that a
// repository is personal.
//
//   default_place: ACME Corp            # else organization.name of oikos.yaml
//   places:                             # label → substrings of a repository's path or remote URL,
//     personal: [ada-tools, side-project]  #   a code host's owner/repo, a Jira project key, a space key
//   skip_commits:                       # subjects of commits that are a tool's snapshots: left out, counted apart
//     - "^Agent host session"           #   a pattern alone applies in every repository
//     - { pattern: "^reindex:", repos: [acme/knowledge] }  # or only in the repositories named (substrings)
//   generated: ["(^|/)\\.claude/skills/"]  # paths whose lines are a tool's output (added to the built-in ones)
//   pipeline_repos: [acme/knowledge]    # repositories whose lines are a pipeline's output: their commits keep
//                                       #   their time, their lines count apart (matched as places are)
//   day_starts: "04:00"                 # a working day's start: earlier actions belong to the day before
import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { UsageError } from '../common/cli.mjs';
import { config } from '../common/config.mjs';
import { installRoot, localPath } from '../common/paths.mjs';

/**
 * Where the settings are looked for when `--config` is not given.
 *
 * @returns {string|null} `.local/footprint/config.yaml` of the installation, or null outside one
 */
export const settingsFile = () => (installRoot() ? localPath('footprint', 'config.yaml') : null);

const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);

const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function regexps(values, what, file) {
  return list(values).map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch (e) {
      throw new UsageError(`${file}: ${what} ${source} is not a regular expression (${e.message})`);
    }
  });
}

/**
 * The `skip_commits` rules: a string is a pattern for every repository; a mapping `{ pattern, repos }`
 * limits it to the repositories whose `where` holds one of `repos` (case-insensitive substrings).
 *
 * @param {unknown} values what the file gave under skip_commits
 * @param {string|null} file the settings file, for the error
 * @returns {{ pattern: RegExp, repos: string[] }[]} `repos` lowercased; empty means every repository
 * @throws {UsageError} for a pattern that is not a regular expression, or a mapping without one
 */
function skipRules(values, file) {
  const given = values === undefined || values === null ? [] : Array.isArray(values) ? values : [values];
  return given.map((value) => {
    if (!isMap(value)) return regexps([value], 'skip_commits', file).map((pattern) => ({ pattern, repos: [] }))[0];
    if (typeof value.pattern !== 'string' || !value.pattern.trim()) {
      throw new UsageError(`${file}: skip_commits takes a pattern or { pattern: "<regex>", repos: [<substring>, …] }; got: ${JSON.stringify(value)}`);
    }
    return { pattern: regexps([value.pattern], 'skip_commits', file)[0], repos: list(value.repos).map((r) => r.toLowerCase()) };
  }).filter(Boolean);
}

/**
 * A `--place label=pattern,pattern` flag as a rule.
 *
 * @param {string} value what the flag gave
 * @returns {{ label: string, patterns: string[] }}
 * @throws {UsageError} when it is not `label=pattern[,pattern…]`
 */
export function placeFlag(value) {
  const m = String(value).match(/^([^=]+)=(.+)$/);
  const patterns = m ? list(m[2].split(',')) : [];
  if (!m || !m[1].trim() || !patterns.length) throw new UsageError(`--place takes label=pattern[,pattern…]; got: ${value}`);
  return { label: m[1].trim(), patterns };
}

/** `HH:MM` → minutes, or a usage error. */
function minutesOf(value, what) {
  const m = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new UsageError(`${what} takes HH:MM; got: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The settings file's mapping: {} when there is none; a usage error when it does not parse or is not a mapping. */
function readSettings(path) {
  if (!path || !existsSync(path)) return {};
  let raw;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`${path} does not parse (${e.message.split('\n')[0]})`);
  }
  if (raw === null || raw === undefined) return {};
  if (!isMap(raw)) throw new UsageError(`${path} must be a mapping (default_place, places, skip_commits, generated, pipeline_repos, day_starts)`);
  if (raw.places !== undefined && raw.places !== null && !isMap(raw.places)) throw new UsageError(`${path}: places must be a mapping of label → patterns`);
  return raw;
}

/**
 * The settings: the file (an explicit `file` must exist; the default one may be missing), then the
 * flags — a `--place` rule is tried before the file's, `--default-place` and `--day-starts` replace
 * the file's. A place pattern and a `pipeline_repos` pattern are case-insensitive substrings of an
 * event's `where` (so a short one matches more than meant); `skip_commits` and `generated` are
 * regular expressions (case-insensitive) of a commit's subject and of a file's path, and a
 * `skip_commits` rule may name the repositories it applies in (`skipRules`).
 *
 * @param {{ file?: string, places?: string[], defaultPlace?: string, dayStarts?: string }} [given]
 *   `file` --config; `places` the --place flags; `defaultPlace` --default-place; `dayStarts` --day-starts
 * @returns {{ file: string|null, defaultPlace: string, rules: { label: string, patterns: string[] }[],
 *   skipCommits: { pattern: RegExp, repos: string[] }[], generated: RegExp[], pipelineRepos: string[],
 *   dayStartsMin: number, placeOf: (where: string|null|undefined) => string }} `pipelineRepos` and a
 *   skip rule's `repos` lowercased substrings (a rule without `repos` applies in every repository)
 * @throws {UsageError} for a missing --config file, a file that does not parse, a bad pattern or time
 */
export function footprintSettings({ file, places = [], defaultPlace, dayStarts } = {}) {
  if (file && !existsSync(file)) throw new UsageError(`--config ${file}: no such file`);
  const path = file || settingsFile();
  const raw = readSettings(path);
  const fileRules = Object.entries(raw.places || {}).map(([label, patterns]) => ({ label, patterns: list(patterns) }));
  const rules = [...places.map(placeFlag), ...fileRules];
  const fallback = String(defaultPlace || raw.default_place || config().organization.name || 'organization');
  const lowered = rules.map((r) => ({ label: r.label, patterns: r.patterns.map((p) => p.toLowerCase()) }));
  const startsAt = dayStarts || raw.day_starts;
  return {
    file: path && existsSync(path) ? path : null,
    defaultPlace: fallback,
    rules,
    skipCommits: skipRules(raw.skip_commits, path),
    generated: regexps(raw.generated, 'generated', path),
    pipelineRepos: list(raw.pipeline_repos).map((p) => p.toLowerCase()),
    dayStartsMin: startsAt ? minutesOf(startsAt, dayStarts ? '--day-starts' : `${path}: day_starts`) : 0,
    // The first rule with a pattern inside `where` (case-insensitive) names the place.
    placeOf(where) {
      const text = String(where || '').toLowerCase();
      if (text) for (const r of lowered) if (r.patterns.some((p) => text.includes(p))) return r.label;
      return fallback;
    },
  };
}
