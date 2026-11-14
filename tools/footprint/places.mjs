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
//   sessions: { claude: ~/.claude/projects, qwen: false }  # agent transcripts: a folder, or false = off
//   sessions_skip_prompts: ["^Run the nightly digest"]  # messages a tool sent in the owner's name (regular
//                                       #   expressions of the typed text): not the owner's, counted nowhere
//   decision_headings: ["Needed from you"]  # headings that open a decision request in an agent's final summary
//   decision_codes: "\\b[DQ]-[A-Z0-9]+\\b"  # what a decision code looks like (a regular expression)
//   reading_reference: { label: a long novel, words: 580000 }  # words read against a familiar length
//   decision_dirs: [docs/adr, docs/design]  # folders of decision documents in a repository
//   releases: { rule: merge-days, base: main, repos: [acme/app] }  # production releases by rule
//   team: { members: [ada@example.com], projects: [PROJ] }         # who counts as the team, and its Jira projects
// The new keys are described in docs/design/footprint.md § Settings.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { UsageError } from '../common/cli.mjs';
import { config } from '../common/config.mjs';
import { installRoot, localPath } from '../common/paths.mjs';
import { DEFAULT_DECISION_CODES, DEFAULT_DECISION_DIRS, headingPattern } from './meaning.mjs';

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

/** The agent hosts `sessions` may name, in the order they are returned. */
const SESSION_HOSTS = ['claude', 'qwen', 'codex'];

/** A folder the user wrote: `~` or `~/…` is the home folder. */
const expandHome = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/**
 * The `sessions` setting: per host a folder (home expanded), `false` for off, `null` for the host's default.
 *
 * @param {unknown} value what the file gave under sessions
 * @param {string|null} file the settings file, for the error
 * @returns {{ claude: string|false|null, qwen: string|false|null, codex: string|false|null }}
 * @throws {UsageError} for another key, or a value that is not a folder or `false`
 */
function sessionHosts(value, file) {
  if (value === undefined || value === null) return { claude: null, qwen: null, codex: null };
  if (!isMap(value)) throw new UsageError(`${file}: sessions must be a mapping of host (${SESSION_HOSTS.join(', ')}) → a folder or false`);
  const unknown = Object.keys(value).filter((k) => !SESSION_HOSTS.includes(k));
  if (unknown.length) throw new UsageError(`${file}: sessions takes ${SESSION_HOSTS.join(', ')}; got: ${unknown.join(', ')}`);
  return Object.fromEntries(SESSION_HOSTS.map((host) => {
    const v = value[host];
    if (v === undefined || v === null) return [host, null];
    if (v === false) return [host, false];
    if (typeof v !== 'string' || !v.trim()) throw new UsageError(`${file}: sessions.${host} takes a folder or false; got: ${JSON.stringify(v)}`);
    return [host, expandHome(v.trim())];
  }));
}

/** The `sessions_skip_prompts` setting: a RegExp per pattern, none by default; an invalid pattern is named. */
function skipPromptsOf(value, file) {
  return list(value).map((source) => {
    try {
      return new RegExp(source);
    } catch (e) {
      throw new UsageError(`${file}: sessions_skip_prompts pattern ${source} is not a regular expression (${e.message})`);
    }
  });
}

/** The `decision_headings` setting as the one pattern of a heading line (the defaults when absent). */
function headingsOf(value, file) {
  if (value === undefined || value === null) return headingPattern();
  const names = list(value);
  if (!names.length) throw new UsageError(`${file}: decision_headings must name at least one heading`);
  return headingPattern(names);
}

/** The `decision_codes` setting: a global RegExp (the default pattern when absent). */
function codesOf(value, file) {
  if (value === undefined || value === null) return new RegExp(DEFAULT_DECISION_CODES, 'g');
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${file}: decision_codes takes one regular expression; got: ${JSON.stringify(value)}`);
  try {
    return new RegExp(value, 'g');
  } catch (e) {
    throw new UsageError(`${file}: decision_codes ${value} is not a regular expression (${e.message})`);
  }
}

/** The `reading_reference` setting: `{ label, words }` or null. */
function readingOf(value, file) {
  if (value === undefined || value === null) return null;
  const given = isMap(value) ? value : {};
  if (typeof given.label !== 'string' || !given.label.trim() || typeof given.words !== 'number' || !(given.words > 0)) {
    throw new UsageError(`${file}: reading_reference takes { label: <text>, words: <a positive number> }; got: ${JSON.stringify(value)}`);
  }
  return { label: given.label.trim(), words: given.words };
}

/** The `releases` setting: `{ rule, base, repos }` or null. */
function releasesOf(value, file) {
  if (value === undefined || value === null) return null;
  const given = isMap(value) ? value : {};
  const repos = list(given.repos);
  if (given.rule !== 'merge-days' || !repos.length) {
    throw new UsageError(`${file}: releases takes { rule: merge-days, base: <branch, default main>, repos: [<owner/repo>, …] }; got: ${JSON.stringify(value)}`);
  }
  if (given.base !== undefined && given.base !== null && (typeof given.base !== 'string' || !given.base.trim())) {
    throw new UsageError(`${file}: releases.base takes a branch name; got: ${JSON.stringify(given.base)}`);
  }
  return { rule: 'merge-days', base: given.base ? given.base.trim() : 'main', repos };
}

/** The `team` setting: `{ members, projects }`. */
function teamOf(value, file) {
  if (value === undefined || value === null) return { members: [], projects: [] };
  if (!isMap(value)) throw new UsageError(`${file}: team takes { members: [<email or name>, …], projects: [<Jira project key>, …] }; got: ${JSON.stringify(value)}`);
  return { members: list(value.members), projects: list(value.projects) };
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
  if (!isMap(raw)) throw new UsageError(`${path} must be a mapping (default_place, places, skip_commits, generated, pipeline_repos, day_starts, sessions, sessions_skip_prompts, decision_headings, decision_codes, reading_reference, decision_dirs, releases, team)`);
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
 *   dayStartsMin: number, sessions: { claude: string|false|null, qwen: string|false|null, codex: string|false|null },
 *   sessionsSkipPrompts: RegExp[], decisionHeadings: RegExp, decisionCodes: RegExp, readingReference: { label: string, words: number }|null,
 *   decisionDirs: string[], releases: { rule: 'merge-days', base: string, repos: string[] }|null,
 *   team: { members: string[], projects: string[] }, placeOf: (where: string|null|undefined) => string }}
 *   `pipelineRepos` and a skip rule's `repos` lowercased substrings (a rule without `repos` applies in
 *   every repository); `sessions` per host a folder (`~` expanded), `null` the host's default, `false` off;
 *   `decisionHeadings` matches a heading line's prefix, `decisionCodes` is global
 * @throws {UsageError} for a missing --config file, a file that does not parse, a bad pattern, time or other setting
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
    sessions: sessionHosts(raw.sessions, path),
    sessionsSkipPrompts: skipPromptsOf(raw.sessions_skip_prompts, path),
    decisionHeadings: headingsOf(raw.decision_headings, path),
    decisionCodes: codesOf(raw.decision_codes, path),
    readingReference: readingOf(raw.reading_reference, path),
    decisionDirs: raw.decision_dirs === undefined || raw.decision_dirs === null
      ? [...DEFAULT_DECISION_DIRS] : list(raw.decision_dirs).map((d) => d.replace(/\/+$/, '')),
    releases: releasesOf(raw.releases, path),
    team: teamOf(raw.team, path),
    // The first rule with a pattern inside `where` (case-insensitive) names the place.
    placeOf(where) {
      const text = String(where || '').toLowerCase();
      if (text) for (const r of lowered) if (r.patterns.some((p) => text.includes(p))) return r.label;
      return fallback;
    },
  };
}
