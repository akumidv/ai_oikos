// The footprint report: the events of every source laid on working days and weeks in one time zone,
// per place (where the work was done, by the user's rules) and for all places — the per-day
// measures, a calendar of first and last actions, the weeks, what changed — each source's totals
// and breakdown, and hours (worklogs, timesheets) next to the activity. Markdown for a person, the
// same object as JSON for another tool.
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { UsageError } from '../common/cli.mjs';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Above this many days the day table is left out unless `--by day` asks for it. */
const DAY_TABLE_MAX = 31;
const DAY_MINUTES = 1440;
/** The place of every event when the report has no settings; the column of all places. */
const ONE_PLACE = 'all';
const ALL_PLACES = 'all places';
/** The kinds of a Jira event; every one but `worklog` is a Jira action. Any other kind is shown as "other". */
const JIRA_KINDS = ['created', 'status', 'edit', 'comment', 'worklog'];
/**
 * The kinds of event on someone else's pull or merge request (`others: true`) that are a review of
 * it. A conversation comment, a commit, a push, a close or a reopen is not, whatever its PR.
 */
const REVIEW_KINDS = new Set(['review', 'review comment', 'merge', 'mr approved', 'mr merged']);
/**
 * The code-host events that are a commit git counts too: one in a repository git read is not an
 * action here (one commit is counted once), and stays in its source's totals (`isCommitCopy`).
 */
const COMMIT_COPIES = { github: 'commit', gitlab: 'push' };
/** The kinds of a commit's lines (generated and pipeline lines are not in an event). */
const LINE_KINDS = ['code', 'tests', 'docs'];
/** How much of a place's content each table shows. */
const LARGEST_COMMITS = 3;
const TOP_ISSUES = 10;
const SUMMARY_MAX = 90;
/** How much of a day's content its By day cell shows. */
const DAY_REPOSITORIES = 3;
const DAY_ISSUES = 5;

/** A local date's shape; `isoDate` also checks the day exists. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Hours as a number (`7`, `7.5`, `7,5`) or as `H:MM`. */
const HOURS = /^\d+([.,]\d+)?$/;
const HOURS_MINUTES = /^(\d+):([0-5]\d)$/;
/** UTC offsets lie within ±14 hours: a local midnight is within this of the same date's UTC midnight. */
const OFFSET_SPAN_MS = 15 * 3_600_000;

/**
 * A date the user gave, checked.
 *
 * @param {string} value what was given
 * @param {string} option the option's name, for the error
 * @returns {string} `value`, an existing day as `YYYY-MM-DD`
 * @throws {UsageError} when `value` is not one
 */
export function isoDate(value, option) {
  // Date.parse rolls an impossible day over (02-30 → 03-02), so the date must read back unchanged.
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!DATE.test(value || '') || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new UsageError(`--${option} must be a date YYYY-MM-DD, got: ${value}`);
  }
  return value;
}

/**
 * The date `n` days after `date`.
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {number} n days, negative for before
 * @returns {string} `YYYY-MM-DD`
 */
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Every date of a period.
 *
 * @param {string} since the first date, `YYYY-MM-DD`
 * @param {string} until the last date, included
 * @returns {string[]} the dates in order
 */
export function daysOf(since, until) {
  const days = [];
  for (let d = since; d <= until; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * The Monday of the week of `date`.
 *
 * @param {string} date `YYYY-MM-DD`
 * @returns {string} `YYYY-MM-DD`
 */
export function weekOf(date) {
  const wd = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -wd);
}

/** 0 for a Monday … 6 for a Sunday. */
const weekdayIndex = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const weekday = (date) => WEEKDAYS[weekdayIndex(date)];

/**
 * The time zone of the report.
 *
 * @param {string|undefined} tz what --tz gave; the system's zone when absent
 * @returns {string} an IANA name Intl knows
 * @throws {UsageError} when Intl does not know `tz`
 */
export function timeZone(tz) {
  const zone = tz || new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  } catch {
    throw new UsageError(`--tz is not a time zone: ${zone} (an IANA name such as Europe/Zurich)`);
  }
  return zone;
}

/**
 * The local date and time of an instant.
 *
 * @param {number|string|Date} instant ms, an ISO string or a Date
 * @param {string} tz an IANA time zone
 * @returns {{ date: string, time: string }} `YYYY-MM-DD` and `HH:MM` in `tz`
 * @throws {RangeError} when `instant` is not a valid time
 */
export function localParts(instant, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * The working day of an instant and its minute in that day: a working day begins at `startMin`
 * past local midnight, so an action before it belongs to the day before, at a minute of 1440 or
 * more (shown `01:30+1`). With `startMin` 0 it is the local date and time.
 *
 * @param {number|string|Date} instant ms, an ISO string or a Date
 * @param {string} tz an IANA time zone
 * @param {number} [startMin] minutes past midnight at which a working day begins, 0–1439
 * @returns {{ date: string, minute: number }} `YYYY-MM-DD` and the minute since that date's midnight
 * @throws {RangeError} when `instant` is not a valid time
 */
export function workingDay(instant, tz, startMin = 0) {
  const { date, time } = localParts(instant, tz);
  const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return minute < startMin ? { date: addDays(date, -1), minute: minute + DAY_MINUTES } : { date, minute };
}

/** A minute of a working day as `HH:MM`, with `+1` past midnight; empty for none. */
function clock(minute) {
  if (minute === null || minute === undefined) return '';
  const m = Math.round(minute);
  const text = `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return m >= DAY_MINUTES ? `${text}+1` : text;
}

/**
 * The instant at which `date` begins in `tz`: the bound of a period for an API that takes
 * instants. That is local midnight, or where a daylight-saving change skips midnight (America/Santiago
 * in September) the instant the clocks jump to — the first instant whose local date is `date`,
 * found by bisection over the seconds of every possible UTC offset.
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {string} tz an IANA time zone
 * @returns {number} ms since the epoch
 */
export function zonedMidnight(date, tz) {
  const target = Date.parse(`${date}T00:00:00Z`);
  // The local date only grows with the instant: lo is always before `date`, hi always on or after it.
  let lo = (target - OFFSET_SPAN_MS) / 1000;
  let hi = (target + OFFSET_SPAN_MS) / 1000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localParts(mid * 1000, tz).date >= date) hi = mid;
    else lo = mid;
  }
  return hi * 1000;
}

/**
 * The fields of one timesheet line. The separator is a tab or `;` when the line has one, else `,`
 * — so `7,5` reads as a number after a tab or `;`, and after `,` only in double quotes, as a
 * spreadsheet exports it.
 */
function timesheetFields(line) {
  const separator = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
  const fields = [];
  let field = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === separator && !quoted) { fields.push(field.trim()); field = ''; }
    else field += ch;
  }
  fields.push(field.trim());
  return fields;
}

/** The hours of a timesheet field: `7`, `7.5`, `7,5` or `7:30`; NaN for anything else. */
function hoursOf(text) {
  const time = text.match(HOURS_MINUTES);
  if (time) return Number(time[1]) + Number(time[2]) / 60;
  return HOURS.test(text) ? Number(text.replace(',', '.')) : NaN;
}

/**
 * A timesheet: lines `date,hours` (`;` or a tab also separate; a header line, `#` comments and
 * blank lines are skipped; hours as `7.5`, `7,5` or `7:30`). Several lines of one date add up.
 * Only the first line that is not a comment, and whose first field is not a date, is a header;
 * a line with more fields than two is refused, since `2026-03-02,7,5` would otherwise read 7.
 *
 * @param {string} file the path the user gave
 * @returns {{ label: string, days: Map<string, number> }} the label is the file's name
 * @throws {UsageError} when the file is missing or a line is not `date,hours`
 */
export function readTimesheet(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`--hours ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
  }
  const days = new Map();
  let first = true;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = timesheetFields(line);
    const header = first && !DATE.test(fields[0]);
    first = false;
    if (header) continue;
    const bad = (why) => new UsageError(`--hours ${file}: line ${i + 1} ${why}: ${line}`);
    if (fields.length > 2) throw bad('has more fields than "YYYY-MM-DD,hours" — quote a decimal comma ("7,5") or separate with ;');
    const [date, hours = ''] = fields;
    if (!DATE.test(date)) throw bad('is not "YYYY-MM-DD,hours"');
    isoDate(date, `hours ${file}: line ${i + 1}`);
    const value = hoursOf(hours);
    if (!Number.isFinite(value)) throw bad(`has no hours (7.5, 7,5 or 7:30)${hours ? `, got ${hours}` : ''}`);
    days.set(date, (days.get(date) || 0) + value);
  }
  return { label: basename(file, extname(file)), days };
}

/**
 * The timesheets of `files`, each labelled by its file name, made unique where two share one: the
 * parent folder is put before the name, and a number after it when that is still not enough.
 *
 * @param {string[]} files the paths given as --hours
 * @returns {{ label: string, days: Map<string, number> }[]} in the order given
 * @throws {UsageError} as `readTimesheet`
 */
export function readTimesheets(files) {
  const sheets = files.map((file) => readTimesheet(file));
  const count = (labels, label) => labels.filter((l) => l === label).length;
  const named = sheets.map((s, i) => (count(sheets.map((x) => x.label), s.label) > 1 ? `${basename(dirname(resolve(files[i])))}/${s.label}` : s.label));
  const used = new Map();
  return sheets.map((s, i) => {
    const n = (used.get(named[i]) || 0) + 1;
    used.set(named[i], n);
    return { ...s, label: count(named, named[i]) > 1 ? `${named[i]} #${n}` : named[i] };
  });
}

const round = (h) => Math.round(h * 10) / 10;
const cell = (v) => (v === undefined || v === null || v === 0 ? '' : String(v));
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
];
const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const total = (values) => values.reduce((a, b) => a + b, 0);

/** The median of numbers; null for none. */
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The median and mean of numbers, each null for none. */
const spread = (values) => ({ median: median(values), mean: values.length ? total(values) / values.length : null });

/** An event's kind; a git event without one is a commit (git emits nothing else). */
const kindOf = (source, e) => e.kind || (source === 'git' ? 'commit' : null);

/** A commit's repository and subject, from its `what` ("repo: subject"). */
function commitOf(e) {
  const text = String(e.what || '');
  const at = text.indexOf(': ');
  if (at > 0) return { repository: text.slice(0, at), subject: text.slice(at + 2) };
  return { repository: text || e.where || 'unknown', subject: '' };
}

/** A Jira event's issue key, summary and project, from its `what` ("PROJ-1 summary") and `where`. */
function issueOf(e) {
  const [, key = '', summary = ''] = String(e.what || '').replace(/\s+/g, ' ').trim().match(/^(\S*)\s*(.*)$/);
  const issue = key || e.where || 'unknown';
  return { key: issue, summary, project: e.where || issue.split('-')[0] };
}

/** The repository of a pull or merge request a review-like event is on: its `where`, else `what` without `#12`/`!3`. */
const reviewRepositoryOf = (e) => e.where || String(e.what || e.pr || '').replace(/[#!]\d+.*$/, '') || 'unknown';

/** A commit's lines by kind, `[added, deleted]` each. */
const linesOf = (e) => Object.fromEntries(LINE_KINDS.map((k) => [k, [Number(e.lines?.[k]?.[0]) || 0, Number(e.lines?.[k]?.[1]) || 0]]));
const added = (lines) => total(LINE_KINDS.map((k) => lines[k][0]));
const deleted = (lines) => total(LINE_KINDS.map((k) => lines[k][1]));
const codeTestsAdded = (day) => day.lines.code[0] + day.lines.tests[0];
const jiraActions = (day) => total(Object.entries(day.jira).filter(([k]) => k !== 'worklog').map(([, n]) => n));

/**
 * The actions of one place (or of all places) on the working days of the period: per day the first
 * and last timed action, the actions per source, commits and their lines, Jira actions by kind,
 * reviews of others' pull or merge requests; and over the period the repositories, issues and
 * reviewed repositories, and the GitLab pushes. A review (an event with `reviewed`, or one of
 * REVIEW_KINDS with `others`) counts once per pull or merge request and day, with the lines of the
 * first one that carries them.
 */
class PlaceLedger {
  #days = new Map();
  #repositories = new Map();
  #issues = new Map();
  #projects = new Map();
  #reviewed = new Map();
  #reviewSeen = new Map();
  #kinds = new Map();
  #pushes = 0;

  /** @param {string} place the place's label */
  constructor(place) {
    this.place = place;
  }

  /**
   * Add one event.
   *
   * @param {object} e the event
   * @param {{ source: string, date: string, minute: number|null }} at its source, working day and minute (null when only its day is known)
   */
  record(e, { source, date, minute }) {
    const day = this.#day(date);
    const n = e.count ?? 1;
    const kind = kindOf(source, e);
    day.actions += n;
    day.bySource[source] = (day.bySource[source] || 0) + n;
    if (minute !== null) {
      day.timed += n;
      if (day.first === null || minute < day.first) day.first = minute;
      if (day.last === null || minute > day.last) day.last = minute;
    }
    if (kind) {
      const k = this.#kinds.get(`${source} ${kind}`) || { source, kind, actions: 0 };
      k.actions += n;
      this.#kinds.set(`${source} ${kind}`, k);
    }
    if (source === 'git' && kind === 'commit') this.#commit(day, e, n);
    if (source === 'jira') this.#jira(day, e, kind || 'action', n);
    if (e.reviewed || (e.others === true && REVIEW_KINDS.has(kind))) this.#review(day, e);
    if (source === 'gitlab' && kind === 'push') this.#pushes += n;
  }

  /**
   * Count an event that is no action here — a code host's copy of a commit in a repository git read
   * (`isCommitCopy`) — only where it stays visible: the GitLab pushes.
   *
   * @param {object} e the event
   * @param {{ source: string }} at its source
   */
  aside(e, { source }) {
    if (source === 'gitlab' && kindOf(source, e) === 'push') this.#pushes += e.count ?? 1;
  }

  #day(date) {
    if (!this.#days.has(date)) {
      this.#days.set(date, {
        date, first: null, last: null, actions: 0, timed: 0, bySource: {}, commits: 0,
        lines: Object.fromEntries(LINE_KINDS.map((k) => [k, [0, 0]])), jira: {}, reviews: 0, reviewed: [0, 0],
        repositories: new Map(), issues: new Map(),
      });
    }
    return this.#days.get(date);
  }

  #commit(day, e, n) {
    const { repository, subject } = commitOf(e);
    const lines = linesOf(e);
    day.commits += n;
    for (const k of LINE_KINDS) { day.lines[k][0] += lines[k][0]; day.lines[k][1] += lines[k][1]; }
    const r = this.#repositories.get(repository) || { repository, commits: 0, days: new Set(), codeTests: [0, 0], docs: [0, 0], subjects: [] };
    r.commits += n;
    r.days.add(day.date);
    r.codeTests[0] += lines.code[0] + lines.tests[0];
    r.codeTests[1] += lines.code[1] + lines.tests[1];
    r.docs[0] += lines.docs[0];
    r.docs[1] += lines.docs[1];
    // A commit without lines (a pipeline repository's, a binary file's) is no largest commit.
    if (subject && added(lines) + deleted(lines) > 0) r.subjects.push({ subject, added: added(lines) });
    this.#repositories.set(repository, r);
    const [a, d] = day.repositories.get(repository) || [0, 0];
    day.repositories.set(repository, [a + added(lines), d + deleted(lines)]);
  }

  #jira(day, e, kind, n) {
    day.jira[kind] = (day.jira[kind] || 0) + n;
    if (kind === 'worklog') return;
    const { key, summary, project } = issueOf(e);
    bump(this.#projects, project, n);
    const issue = this.#issues.get(key) || { key, actions: 0, kinds: {}, summary: '' };
    issue.actions += n;
    issue.kinds[kind] = (issue.kinds[kind] || 0) + n;
    if (!issue.summary && summary) issue.summary = summary;
    this.#issues.set(key, issue);
    bump(day.issues, key, n);
  }

  #review(day, e) {
    const id = e.pr ?? e.what ?? null;
    const key = id === null ? null : `${day.date}\n${id}`;
    const repository = reviewRepositoryOf(e);
    const r = this.#reviewed.get(repository) || { repository, reviews: 0, lines: [0, 0] };
    this.#reviewed.set(repository, r);
    let seen = key === null ? null : this.#reviewSeen.get(key);
    if (!seen) {
      seen = { lines: false };
      if (key !== null) this.#reviewSeen.set(key, seen);
      day.reviews += 1;
      r.reviews += 1;
    }
    if (Array.isArray(e.reviewed) && !seen.lines) {
      seen.lines = true;
      const [a, d] = e.reviewed.map((x) => Number(x) || 0);
      day.reviewed[0] += a;
      day.reviewed[1] += d;
      r.lines[0] += a;
      r.lines[1] += d;
    }
  }

  /**
   * The place's summary as plain data (no Map or Set): its active days, the per-day measures, the
   * weeks and what changed.
   *
   * @param {{ weeks: string[], workdays: number }} period the Mondays of the period's weeks and its Mon–Fri days
   * @returns {object} { place, actions, activeDays, measures, days, weeks, changed }
   */
  summary({ weeks, workdays }) {
    const days = [...this.#days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(finalDay);
    const byDate = new Map(days.map((d) => [d.date, d]));
    const measures = measuresOf(days, workdays);
    measures.totals.pushes = this.#pushes;
    return {
      place: this.place,
      actions: total(days.map((d) => d.actions)),
      activeDays: days.length,
      measures,
      days,
      weeks: weeks.map((week) => weekOfDays(week, daysOf(week, addDays(week, 6)).map((d) => byDate.get(d)).filter(Boolean))),
      changed: this.#changed(),
    };
  }

  #changed() {
    const desc = (f) => (a, b) => f(b) - f(a);
    return {
      repositories: [...this.#repositories.values()].map((r) => ({
        repository: r.repository, commits: r.commits, days: r.days.size, codeTests: r.codeTests, docs: r.docs,
        largest: [...r.subjects].sort(desc((s) => s.added)).slice(0, LARGEST_COMMITS).map((s) => s.subject),
      })).sort(desc((r) => r.codeTests[0] + r.docs[0])),
      jiraProjects: [...this.#projects].map(([project, actions]) => ({ project, actions })).sort(desc((p) => p.actions)),
      issues: [...this.#issues.values()].sort(desc((i) => i.actions)),
      reviewed: [...this.#reviewed.values()].sort(desc((r) => r.reviews)),
      kinds: [...this.#kinds.values()].sort(desc((k) => k.actions)),
    };
  }
}

/** A day of a ledger as plain data: times as `HH:MM` (and their minutes), the day's content as arrays. */
function finalDay(day) {
  const { repositories, issues, first, last, ...rest } = day;
  return {
    ...rest,
    first: first === null ? null : clock(first),
    last: last === null ? null : clock(last),
    firstMinute: first,
    lastMinute: last,
    content: {
      repositories: [...repositories].map(([repository, [a, d]]) => ({ repository, added: a, deleted: d }))
        .sort((x, y) => y.added + y.deleted - (x.added + x.deleted)),
      issues: [...issues].map(([key, actions]) => ({ key, actions })).sort((x, y) => y.actions - x.actions),
    },
  };
}

/** The span from the first to the last action of each day with two timed actions or more, in hours. */
const spansOf = (days) => days.filter((d) => d.timed >= 2).map((d) => (d.lastMinute - d.firstMinute) / 60);

/** The per-day measures of a place over its active days, per Mon–Fri day of the period, and its totals. */
function measuresOf(days, workdays) {
  const sum = (f) => total(days.map(f));
  const per = (f) => spread(days.map(f));
  const timed = days.filter((d) => d.firstMinute !== null);
  const jira = {};
  for (const d of days) for (const [k, n] of Object.entries(d.jira)) jira[k] = (jira[k] || 0) + n;
  return {
    activeDays: days.length,
    weekendDays: days.filter((d) => weekdayIndex(d.date) >= 5).length,
    firstMedian: median(timed.map((d) => d.firstMinute)),
    lastMedian: median(timed.map((d) => d.lastMinute)),
    spanHours: spread(spansOf(days)),
    perActiveDay: {
      actions: per((d) => d.actions), commits: per((d) => d.commits), codeTestsAdded: per(codeTestsAdded),
      docsAdded: per((d) => d.lines.docs[0]), jiraActions: per(jiraActions), reviews: per((d) => d.reviews),
    },
    perWorkday: workdays ? {
      actions: sum((d) => d.actions) / workdays, commits: sum((d) => d.commits) / workdays, codeTestsAdded: sum(codeTestsAdded) / workdays,
    } : null,
    totals: {
      actions: sum((d) => d.actions),
      commits: sum((d) => d.commits),
      lines: Object.fromEntries(LINE_KINDS.map((k) => [k, [sum((d) => d.lines[k][0]), sum((d) => d.lines[k][1])]])),
      jira,
      jiraActions: sum(jiraActions),
      reviews: sum((d) => d.reviews),
      reviewed: [sum((d) => d.reviewed[0]), sum((d) => d.reviewed[1])],
    },
  };
}

/** One week of a place from its active days in it. */
function weekOfDays(week, days) {
  const sum = (f) => total(days.map(f));
  const spans = spansOf(days);
  return {
    week,
    activeDays: days.length,
    spanMean: spans.length ? total(spans) / spans.length : null,
    actions: sum((d) => d.actions),
    commits: sum((d) => d.commits),
    codeTestsAdded: sum(codeTestsAdded),
    docsAdded: sum((d) => d.lines.docs[0]),
    jiraActions: sum(jiraActions),
    reviews: sum((d) => d.reviews),
    reviewed: [sum((d) => d.reviewed[0]), sum((d) => d.reviewed[1])],
  };
}

/** A source's breakdown as the report keeps it: its rows' `wheres` replaced by their places. */
function breakdownShown(breakdown, placeOf) {
  const { wheres, ...shown } = breakdown;
  return wheres ? { ...shown, places: wheres.map(placeOf) } : shown;
}

/** The report's own notes on its period: a last day that is today, or still to come. */
function periodNotes(until, today) {
  if (until === today) return [`the period ends today (${today}): the day is still running, its actions are those up to the collection`];
  if (until > today) return [`the period ends after today (${today}): the days from today on are still to come`];
  return [];
}

/**
 * A code host's site as a remote identity's prefix: host (no port) and the path it is served
 * under, lowercased, without scheme or trailing `/` (`https://GitHub.com/` → `github.com`); null for
 * none.
 */
function siteOf(url) {
  const m = String(url || '').match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/]+)(\/.*)?$/i);
  return m ? `${m[1].replace(/:\d*$/, '')}${(m[2] || '').replace(/\/+$/, '')}`.toLowerCase() : null;
}

/**
 * Whether `e` of source result `r` is a code host's copy of a commit git counts: a GitHub commit or a
 * GitLab push (COMMIT_COPIES) whose repository — `<site>/<where>` — is one git read (`gitRemotes`,
 * the git result's `remotes`). One in a repository git did not read is an action, as without git.
 *
 * @param {object} e the event
 * @param {{ source: string, site?: string|null }} r its source's result
 * @param {Set<string>} gitRemotes the remote identities git read (empty when git did not run)
 * @returns {boolean}
 */
function isCommitCopy(e, r, gitRemotes) {
  if (!COMMIT_COPIES[r.source] || kindOf(r.source, e) !== COMMIT_COPIES[r.source]) return false;
  const site = siteOf(r.site);
  return Boolean(site && e.where) && gitRemotes.has(`${site}/${e.where}`.toLowerCase().replace(/\/+$/, ''));
}

/** The settings as the report shows them: plain data, without `placeOf`. */
const settingsShown = (settings, startMin) => ({
  file: settings.file ?? null,
  defaultPlace: settings.defaultPlace,
  rules: (settings.rules || []).map((r) => ({ label: r.label, patterns: [...r.patterns] })),
  dayStarts: clock(startMin),
});

/**
 * Lay the sources' events on the working days of the period, per place and for all places. An
 * event whose time cannot be read, or that has neither a time nor a date, is left out and counted in
 * its source's notes; an event with a `date` but no `at` counts for its day's actions, not for its
 * first and last action. A code host's copy of a commit (a GitHub commit, a GitLab push:
 * COMMIT_COPIES) in a repository git read (`isCommitCopy`) is no action — one commit is counted
 * once — and stays in its source's totals. Every place the settings name has its ledger, events or
 * not. Hours (worklogs, timesheets) stay on their calendar dates.
 *
 * @param {object[]} results what each source returned: { source, label, totals, events, hours?,
 *   breakdown?, notes, remotes? (git), site? (a code host) } or { source, skipped }
 * @param {{ since: string, until: string, tz: string, timesheets?: object[], settings?: object|null, today?: string }} period
 *   `settings` from `footprintSettings` (places.mjs): `placeOf(where)`, `dayStartsMin`, `rules`,
 *   `defaultPlace`, `file`; without it every event is in one place and a day begins at midnight;
 *   `today` the date in `tz` the report is made on (default now), for the note on a day still running
 * @returns {object} the report object, plain data: per day and per week by source with the hours
 *   (`days`, `weeks`), per place (`places`) and for all places (`all`) the measures, days, weeks
 *   and what changed, the report's own `notes`; a breakdown carries its rows' `places`, not the text
 *   they were matched on
 */
export function buildReport(results, { since, until, tz, timesheets = [], settings = null, today = localParts(Date.now(), tz).date }) {
  const ran = results.filter((r) => !r.skipped);
  const gitRemotes = new Set(ran.filter((r) => r.source === 'git').flatMap((r) => r.remotes || []));
  const placeOf = settings?.placeOf ? (where) => settings.placeOf(where) : () => ONE_PLACE;
  const startMin = settings?.dayStartsMin ?? 0;
  const hourLabels = [...ran.filter((r) => r.hours?.size).map((r) => `${r.source} logged`), ...timesheets.map((t) => t.label)];
  const dates = daysOf(since, until);
  const days = new Map(dates.map((d) => [d, { date: d, first: null, last: null, bySource: {}, hours: {} }]));
  // A place the settings name gets its ledger, and so its line in each section, with no event in it.
  const named = settings ? [...(settings.rules || []).map((r) => r.label), settings.defaultPlace].filter(Boolean) : [];
  const ledgers = new Map(named.map((place) => [place, new PlaceLedger(place)]));
  const all = new PlaceLedger(ALL_PLACES);
  const unreadable = new Map();
  const undated = new Map();
  const copies = new Map();
  for (const r of ran) {
    for (const e of r.events) {
      const at = e.at ? Date.parse(e.at) : null;
      if (Number.isNaN(at) || (at === null && !e.date)) { bump(unreadable, r.source); continue; }
      const { date, minute } = at === null ? { date: e.date, minute: null } : workingDay(at, tz, startMin);
      if (!days.has(date)) continue;
      const place = placeOf(e.where);
      if (!ledgers.has(place)) ledgers.set(place, new PlaceLedger(place));
      if (isCommitCopy(e, r, gitRemotes)) {
        bump(copies, r.source, e.count ?? 1);
        for (const ledger of [ledgers.get(place), all]) ledger.aside(e, { source: r.source });
        continue;
      }
      if (minute === null) bump(undated, r.source);
      for (const ledger of [ledgers.get(place), all]) ledger.record(e, { source: r.source, date, minute });
    }
    for (const [date, h] of r.hours || []) if (days.has(date)) days.get(date).hours[`${r.source} logged`] = round(h);
  }
  for (const t of timesheets) for (const [date, h] of t.days) if (days.has(date)) days.get(date).hours[t.label] = round(h);
  const period = { weeks: [...new Set(dates.map(weekOf))], workdays: dates.filter((d) => weekdayIndex(d) < 5).length };
  const allPlaces = all.summary(period);
  for (const d of allPlaces.days) Object.assign(days.get(d.date), { first: d.first, last: d.last, bySource: { ...d.bySource } });
  const places = [...ledgers.values()].map((l) => l.summary(period))
    .sort((a, b) => b.actions - a.actions || a.place.localeCompare(b.place));
  const notesOf = (r) => [
    ...r.notes,
    ...(unreadable.has(r.source) ? [`${unreadable.get(r.source)} event(s) with no time or date that can be read left out of the days`] : []),
    ...(undated.has(r.source) ? [`${undated.get(r.source)} event(s) with a date but no time: counted on their day, not in the first and last action`] : []),
    ...(copies.has(r.source) ? [`${copies.get(r.source)} ${COMMIT_COPIES[r.source]} event(s) left out of the actions and of the first and last action: `
      + 'they are in repositories git read, and one commit is counted once (they stay in the totals here)'] : []),
  ];
  const weeks = new Map();
  for (const day of days.values()) {
    const key = weekOf(day.date);
    const w = weeks.get(key) || { week: key, activeDays: 0, bySource: {}, hours: {} };
    if (Object.keys(day.bySource).length) w.activeDays += 1;
    for (const [s, n] of Object.entries(day.bySource)) w.bySource[s] = (w.bySource[s] || 0) + n;
    for (const [l, h] of Object.entries(day.hours)) w.hours[l] = round((w.hours[l] || 0) + h);
    weeks.set(key, w);
  }
  return {
    since, until, tz,
    settings: settings ? settingsShown(settings, startMin) : null,
    sources: ran.map((r) => ({
      source: r.source, label: r.label, totals: r.totals, notes: notesOf(r),
      // A breakdown whose rows carry `wheres` gets the place of each row instead: the text matched
      // (a path, a remote) stays out of the report.
      breakdown: r.breakdown ? breakdownShown(r.breakdown, placeOf) : null,
    })),
    notes: periodNotes(until, today),
    skipped: results.filter((r) => r.skipped).map((r) => ({ source: r.source, reason: r.skipped })),
    hourLabels,
    days: [...days.values()],
    weeks: [...weeks.values()],
    activeDays: [...days.values()].filter((d) => Object.keys(d.bySource).length).length,
    workdays: period.workdays,
    places,
    all: allPlaces,
  };
}

const r1 = (x) => (x === null || x === undefined ? '' : String(Math.round(x * 10) / 10));
const r0 = (x) => (x === null || x === undefined ? '' : String(Math.round(x)));
/** A count of lines, short: 950, 1.2k, 15k. */
const short = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pair = (s) => (s.median === null ? '' : `${r1(s.median)} · ${r1(s.mean)}`);
const plusMinus = ([a, d]) => `+${short(a)} / −${short(d)}`;
/** Lines added and deleted, a zero shown as `+0` / `−0` (an empty cell would read as not known). */
const plusMinusTight = ([a, d]) => `+${short(a)} −${short(d)}`;

/** The places a table has a column or a section for: each place, and all places when there are two or more. */
function placesShown(report) {
  if (report.places.length > 1) return [...report.places, report.all];
  return report.places.length ? report.places : [report.all];
}

/** Which measures the sources that ran can give: commits and lines (git), Jira actions, reviews (a code host), GitLab pushes. */
const measuresRan = (report) => {
  const ran = new Set(report.sources.map((s) => s.source));
  return { git: ran.has('git'), jira: ran.has('jira'), reviews: ran.has('github') || ran.has('gitlab'), gitlab: ran.has('gitlab') };
};

/** A Jira event kind outside JIRA_KINDS (a source may give one): counted as "other". */
const otherJira = (jira) => total(Object.entries(jira).filter(([k]) => !JIRA_KINDS.includes(k)).map(([, n]) => n));

function headerLines(report, { person, collectedAt, purpose }) {
  const startsAt = report.settings && report.settings.dayStarts !== '00:00'
    ? ` A working day starts at ${report.settings.dayStarts}: an action before it belongs to the day before, its time shown with +1 (01:30+1).` : '';
  const out = [
    `# Footprint — ${person} — ${report.since} … ${report.until}`,
    '',
    ...(purpose ? [`Purpose: ${purpose}`, ''] : []),
    `Collected ${collectedAt} by oikos footprint; days in ${report.tz}. Sources: ${report.sources.map((s) => s.label).join('; ') || 'none'}.`,
    `${report.days.length} day${report.days.length === 1 ? '' : 's'}, ${report.workdays} of them Mon–Fri (holidays not known).${startsAt}`,
    'These are traces of work in the organization\'s systems, not a measure of its value: read them with the person\'s role and what the numbers leave out. The span from the first to the last action is not hours worked.',
  ];
  const ran = new Set(report.sources.map((s) => s.source));
  if (ran.has('git') && (ran.has('github') || ran.has('gitlab'))) {
    out.push('One commit is counted once: with git collected, its commits are the actions, and GitHub commits and GitLab pushes '
      + 'in the repositories git read are not (they stay in their source\'s totals); those elsewhere are actions.');
  }
  if (report.settings) {
    const { file, defaultPlace, rules } = report.settings;
    const named = rules.map((r) => `**${r.label}** = ${r.patterns.map((p) => `\`${p}\``).join(', ')}`);
    out.push('', `Places (settings: ${file || 'no file read'}; the first rule that matches decides): ${[...named, `**${defaultPlace}** = what no rule names`].join('; ')}. `
      + 'Places come from the user: the tool never guesses where a repository, project or space belongs — what no rule names is the default place.');
  }
  return out;
}

function perDayLines(report, shown) {
  const ran = measuresRan(report);
  const withOther = shown.some((p) => otherJira(p.measures.totals.jira) > 0);
  const jiraRow = (m) => [...JIRA_KINDS.map((k) => m.totals.jira[k] || 0), ...(withOther ? [otherJira(m.totals.jira)] : [])].join(' · ');
  const rows = [
    ['Active days (weekend days among them)', (m) => `${m.activeDays} (${m.weekendDays})`],
    ['First action, median', (m) => clock(m.firstMedian)],
    ['Last action, median', (m) => clock(m.lastMedian)],
    ['First–last span, h, median · mean (days with ≥ 2 timed actions)', (m) => pair(m.spanHours)],
    ['Actions per active day, median · mean', (m) => pair(m.perActiveDay.actions)],
    ...(ran.git ? [
      ['Commits per active day, median · mean', (m) => pair(m.perActiveDay.commits)],
      ['Code + tests lines added per active day, median · mean', (m) => pair(m.perActiveDay.codeTestsAdded)],
      ['Docs lines added per active day, median · mean', (m) => pair(m.perActiveDay.docsAdded)],
    ] : []),
    ...(ran.jira ? [['Jira actions per active day, median · mean', (m) => pair(m.perActiveDay.jiraActions)]] : []),
    ...(ran.reviews ? [['Others\' PRs/MRs reviewed per active day, median · mean', (m) => pair(m.perActiveDay.reviews)]] : []),
    ['Actions per Mon–Fri day of the period', (m) => r1(m.perWorkday?.actions)],
    ...(ran.git ? [['Commits · code + tests lines added per Mon–Fri day of the period', (m) => (m.perWorkday ? `${r1(m.perWorkday.commits)} · ${r0(m.perWorkday.codeTestsAdded)}` : '')]] : []),
    ['Actions in the period', (m) => m.totals.actions],
    ...(ran.git ? [
      ['Commits in the period', (m) => m.totals.commits],
      ['Code lines +/−', (m) => plusMinus(m.totals.lines.code)],
      ['Test lines +/−', (m) => plusMinus(m.totals.lines.tests)],
      ['Docs lines +/−', (m) => plusMinus(m.totals.lines.docs)],
    ] : []),
    ...(ran.jira ? [[`Jira: created · status changes · edits · comments · worklogs${withOther ? ' · other' : ''}`, jiraRow]] : []),
    ...(ran.gitlab ? [[`GitLab pushes${ran.git ? ' (those in repositories git read are not actions: git counts the commits)' : ''}`, (m) => m.totals.pushes]] : []),
    ...(ran.reviews ? [['Others\' PRs/MRs reviewed (PR × day) · their lines +/−', (m) => `${m.totals.reviews} · ${plusMinus(m.totals.reviewed)}`]] : []),
  ];
  return [
    '', '## Per day, by place', '',
    ...table(['Measure', ...shown.map((p) => p.place)], rows.map(([label, f]) => [label, ...shown.map((p) => f(p.measures))])),
    '',
    `Medians and means are over the active days of the place; "per Mon–Fri day" divides the period's total by its ${report.workdays} Mon–Fri days.`,
    ...(ran.reviews ? ['Reviewed lines are counted once per pull or merge request and day here; the sources\' totals count them once per pull or merge request.'] : []),
  ];
}

/** The line for a place with no action in the period, in place of its tables. */
const noActionLine = (p) => `No action of ${p.place} in the period.`;

function calendarLines(report, shown) {
  const out = ['', '## Calendar', '', 'Each cell: first–last action · actions that working day; `—` is outside the period.'];
  for (const p of shown) {
    if (shown.length > 1) out.push('', `### ${p.place}`);
    if (!p.activeDays) { out.push('', noActionLine(p)); continue; }
    const byDate = new Map(p.days.map((d) => [d.date, d]));
    const rows = report.weeks.map(({ week }) => {
      const dates = WEEKDAYS.map((_, i) => addDays(week, i));
      const cells = dates.map((d) => {
        if (d < report.since || d > report.until) return '—';
        const day = byDate.get(d);
        if (!day) return '';
        return day.first ? `${day.first}–${day.last} · ${day.actions}` : String(day.actions);
      });
      return [week, ...cells, dates.filter((d) => byDate.has(d)).length];
    });
    out.push('', ...table(['Week of', ...WEEKDAYS, 'Active'], rows));
  }
  return out;
}

function byWeekLines(report, shown) {
  const ran = measuresRan(report);
  // A count of zero is shown as 0 (+0 for lines), as an empty cell would read as not known.
  const columns = [
    ['Active days', (w) => w.activeDays],
    ['Span h, mean', (w) => r1(w.spanMean)],
    ['Actions', (w) => w.actions],
    ...(ran.git ? [['Commits', (w) => w.commits], ['Code+tests +', (w) => `+${short(w.codeTestsAdded)}`], ['Docs +', (w) => `+${short(w.docsAdded)}`]] : []),
    ...(ran.jira ? [['Jira actions', (w) => w.jiraActions]] : []),
    ...(ran.reviews ? [['Reviews', (w) => w.reviews], ['Reviewed lines', (w) => `+${short(w.reviewed[0])} −${short(w.reviewed[1])}`]] : []),
  ];
  const hoursOfWeek = new Map(report.weeks.map((w) => [w.week, w.hours]));
  const out = ['', '## By week'];
  for (const p of shown) {
    // Hours are not per place: they stand beside all places (the last table).
    const hours = p === shown.at(-1) ? report.hourLabels : [];
    if (shown.length > 1) out.push('', `### ${p.place}`);
    if (!p.activeDays && !hours.length) { out.push('', noActionLine(p)); continue; }
    out.push('', ...table(['Week of', ...columns.map(([h]) => h), ...hours.map((l) => `${l} h`)],
      p.weeks.map((w) => [w.week, ...columns.map(([, f]) => f(w)), ...hours.map((l) => cell(hoursOfWeek.get(w.week)?.[l]))])));
  }
  return out;
}

function whatChangedLines(report) {
  const out = ['', '## What changed'];
  if (!report.places.length) return [...out, '', 'No action in the period.'];
  for (const p of report.places) {
    const c = p.changed;
    if (report.places.length > 1) out.push('', `### ${p.place}`);
    if (!p.activeDays) { out.push('', noActionLine(p)); continue; }
    if (c.repositories.length) {
      out.push('', ...table(['Repository', 'Commits', 'Days', 'Code+tests', 'Docs', 'Largest commits'],
        c.repositories.map((r) => [r.repository, r.commits, r.days, plusMinusTight(r.codeTests), plusMinusTight(r.docs), r.largest.join('; ')])));
    }
    if (c.jiraProjects.length) out.push('', `Jira actions by project: ${c.jiraProjects.map((j) => `${j.project} ${j.actions}`).join(', ')}.`);
    if (c.issues.length) {
      out.push('', 'Issues with the most actions:', '', ...table(['Issue', 'Actions', 'Kinds', 'Summary'],
        c.issues.slice(0, TOP_ISSUES).map((i) => [i.key, i.actions, Object.entries(i.kinds).map(([k, n]) => `${k} ${n}`).join(', '),
          i.summary.length > SUMMARY_MAX ? `${i.summary.slice(0, SUMMARY_MAX - 1)}…` : i.summary])));
    }
    if (c.reviewed.length) {
      out.push('', 'Others\' PRs/MRs reviewed, approved or merged (once per PR and day):', '',
        ...table(['Repository', 'Reviews', 'Their lines'], c.reviewed.map((r) => [r.repository, r.reviews, plusMinusTight(r.lines)])));
    }
    if (c.kinds.length) out.push('', `Actions by kind: ${c.kinds.map((k) => `${k.source} ${k.kind} ${k.actions}`).join(', ')}.`);
  }
  return out;
}

/** A day's content for By day: its repositories with their lines, its issues with their actions. */
function contentOf(day) {
  const { repositories, issues } = day.content;
  const more = (list, n) => (list.length > n ? ', …' : '');
  return [
    repositories.length ? `${repositories.slice(0, DAY_REPOSITORIES).map((r) => `${r.repository} +${short(r.added)} −${short(r.deleted)}`).join(', ')}${more(repositories, DAY_REPOSITORIES)}` : '',
    issues.length ? `${issues.slice(0, DAY_ISSUES).map((i) => `${i.key} ×${i.actions}`).join(', ')}${more(issues, DAY_ISSUES)}` : '',
  ].filter(Boolean).join('; ');
}

function byDayLines(report) {
  const names = report.sources.map((s) => s.source);
  const withPlace = Boolean(report.settings);
  const placeDays = report.places.map((p) => [p.place, new Map(p.days.map((d) => [d.date, d]))]);
  const rows = [];
  for (const date of report.days) {
    const active = placeDays.map(([place, byDate]) => [place, byDate.get(date.date)]).filter(([, d]) => d);
    // A row per place active that day; a day with none still has its row, for its hours.
    for (const [i, [place, day]] of (active.length ? active : [['', null]]).entries()) rows.push({ date, place, day, first: i === 0 });
  }
  const contents = rows.map((r) => (r.day ? contentOf(r.day) : ''));
  const withContent = contents.some(Boolean);
  const header = ['Date', 'Day', ...(withPlace ? ['Place'] : []), 'First', 'Last', ...names, ...report.hourLabels.map((l) => `${l} h`), ...(withContent ? ['Content'] : [])];
  return ['', '## By day', '', ...table(header, rows.map((r, i) => [
    r.date.date, weekday(r.date.date), ...(withPlace ? [r.place] : []), r.day?.first || '', r.day?.last || '',
    ...names.map((n) => cell(r.day?.bySource[n])),
    ...report.hourLabels.map((l) => (r.first ? cell(r.date.hours[l]) : '')),
    ...(withContent ? [contents[i]] : []),
  ]))];
}

/**
 * The report as markdown: the header (with the purpose when given, the settings, the place rules
 * and the working day's start), the per-day measures by place, the calendar, the weeks, what
 * changed, the days (a period of up to DAY_TABLE_MAX days unless `by: 'week'`, or `by: 'day'`), the
 * totals and each source's breakdown, and what was skipped or cut. With two places or more each
 * section shows every place and all places; with one, that place only.
 *
 * @param {object} report from `buildReport`
 * @param {{ person: string, by?: string, collectedAt: string, purpose?: string|null }} options
 *   `by` 'day' or 'week'; `purpose` what the report is for
 * @returns {string} the markdown, ending in a newline
 */
export function renderMarkdown(report, { person, by, collectedAt, purpose = null }) {
  const showDays = by === 'day' || (by !== 'week' && report.days.length <= DAY_TABLE_MAX);
  const shown = placesShown(report);
  const out = [
    ...headerLines(report, { person, collectedAt, purpose }),
    ...perDayLines(report, shown),
    ...calendarLines(report, shown),
    ...byWeekLines(report, shown),
    ...whatChangedLines(report),
    ...(showDays ? byDayLines(report) : []),
    '',
    '## Totals',
    '',
    ...table(['Source', 'Measure', 'Value'], report.sources.flatMap((s) => s.totals.map(([m, v]) => [s.source, m, v]))),
    '',
    `Active days: ${report.activeDays} of ${report.days.length}.`,
  ];
  for (const s of report.sources.filter((x) => x.breakdown?.rows.length)) {
    const { title, header, rows, places } = s.breakdown;
    out.push('', `## ${s.source} — ${title}`, '', ...(places
      ? table(['Place', ...header], rows.map((row, i) => [places[i], ...row]))
      : table(header, rows)));
  }
  const notes = [
    ...report.notes,
    ...report.skipped.map((s) => `${s.source}: not collected — ${s.reason}`),
    ...report.sources.flatMap((s) => s.notes.map((n) => `${s.source}: ${n}`)),
  ];
  if (!showDays) {
    notes.push(by === 'week' ? 'the day table is left out with --by week; --by day adds it'
      : `the day table is left out for ${report.days.length} days (above ${DAY_TABLE_MAX}); --by day adds it`);
  }
  if (notes.length) out.push('', '## Notes', '', ...notes.map((n) => `- ${n}`));
  return `${out.join('\n')}\n`;
}
