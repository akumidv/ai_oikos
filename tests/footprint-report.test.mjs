// The footprint report (npm test), offline and in-process: hand-built source results laid on
// working days per place — a day that starts at 04:00 moves a 01:30 action to the day before as
// 01:30+1; the calendar cells and the per-day medians and means of a fixed week; the place of each
// event and of each breakdown row from the user's rules (the matched text kept out of the report);
// reviews and their lines once per pull request and day, and which kinds are a review; a GitHub
// commit or a GitLab push in a repository git read is no action (one commit counted once), one
// elsewhere is, and a place with none says so — a place the settings name with no event too; zeros
// in By week and What changed, the largest commits with lines, an unknown Jira kind as "other",
// an event with no time or date in the notes, a period ending today; what changed per place (the
// largest commits, issues, reviewed repositories); the By day content; the JSON object holds no Map
// or Set; a report without settings still renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderMarkdown, workingDay } from '../tools/footprint/report.mjs';

const PERIOD = { since: '2026-03-02', until: '2026-03-08', tz: 'UTC' };

/** Settings as footprintSettings returns them: one rule, a default place, a working day from 04:00. */
const SETTINGS = {
  file: '/work/.local/footprint/config.yaml',
  defaultPlace: 'ACME Corp',
  rules: [{ label: 'personal', patterns: ['ada-tools'] }],
  dayStartsMin: 240,
  placeOf(where) {
    const text = String(where || '').toLowerCase();
    return this.rules.find((r) => r.patterns.some((p) => text.includes(p)))?.label ?? this.defaultPlace;
  },
};

const lines = (code, tests, docs) => ({ code, tests, docs });
const PR12 = { what: 'acme/web#12', where: 'acme/web', pr: 'https://github.com/acme/web/pull/12', others: true, reviewed: [300, 40] };

function results() {
  return [
    {
      source: 'git', label: 'git (3 local repositories)', totals: [['commits', 6]], notes: [],
      events: [
        { at: '2026-03-02T02:00:00Z', kind: 'commit', what: 'app: Before the period', where: '/src/app', lines: lines([1, 0], [0, 0], [0, 0]) },
        { at: '2026-03-02T09:00:00Z', kind: 'commit', what: 'app: Add login', where: '/src/app git@example.com:acme/app.git', lines: lines([100, 10], [50, 0], [5, 0]) },
        { at: '2026-03-02T17:30:00Z', kind: 'commit', what: 'app: Fix login', where: '/src/app git@example.com:acme/app.git', lines: lines([10, 2], [0, 0], [0, 0]) },
        { at: '2026-03-03T01:30:00Z', kind: 'commit', what: 'ada-tools: Night fix', where: '/src/ada-tools', lines: lines([20, 5], [0, 0], [0, 0]) },
        { at: '2026-03-04T10:00:00Z', kind: 'commit', what: 'lib: Docs', where: '/src/lib', lines: lines([0, 0], [0, 0], [200, 0]) },
        { at: '2026-03-07T20:00:00Z', kind: 'commit', what: 'ada-tools: Weekend', where: '/src/ada-tools', lines: lines([30, 0], [0, 0], [0, 0]) },
      ],
    },
    {
      source: 'jira', label: 'Jira', totals: [['actions', 5]], notes: [],
      events: [
        { at: '2026-03-02T10:00:00Z', kind: 'created', what: 'PROJ-1 Login page', where: 'PROJ' },
        { at: '2026-03-02T11:00:00Z', kind: 'status', what: 'PROJ-1 Login page', where: 'PROJ' },
        { at: '2026-03-02T12:00:00Z', kind: 'comment', what: 'PROJ-2 Search', where: 'PROJ' },
        { at: '2026-03-04T15:00:00Z', kind: 'worklog', what: 'PROJ-1 Login page', where: 'PROJ' },
        { date: '2026-03-05', kind: 'edit', what: 'PROJ-3 Reports', where: 'PROJ' },
      ],
    },
    {
      source: 'github', label: 'GitHub', totals: [['pull requests opened', 1]], notes: [],
      events: [
        { at: '2026-03-02T14:00:00Z', kind: 'review', ...PR12 },
        { at: '2026-03-02T15:00:00Z', kind: 'review comment', ...PR12 },
        { at: '2026-03-03T08:00:00Z', kind: 'pr opened', what: 'acme/web#13', where: 'acme/web', pr: 'https://github.com/acme/web/pull/13' },
        { at: '2026-03-04T09:30:00Z', kind: 'merge', ...PR12 },
      ],
      breakdown: { title: 'per repository', header: ['Repository', 'PRs'], rows: [['acme/web', 2], ['ada/ada-tools', 1]], wheres: ['acme/web', 'ada/ada-tools'] },
    },
    { source: 'gitlab', skipped: 'connector gitlab is not listed' },
  ];
}

const TIMESHEETS = [{ label: 'sheet', days: new Map([['2026-03-02', 8]]) }];
const report = () => buildReport(results(), { ...PERIOD, timesheets: TIMESHEETS, settings: SETTINGS });
const markdown = (r, by) => renderMarkdown(r, { person: 'Ada', by, collectedAt: '2026-03-09 10:00' });
const placeOf = (r, place) => r.places.find((p) => p.place === place);
const dayOf = (p, date) => p.days.find((d) => d.date === date);
/** The lines of a markdown section, from its heading to the next of the same level. */
const section = (md, heading) => md.split(`\n${heading}\n`)[1].split(/\n## /)[0];

test('workingDay: an action before the day start belongs to the day before, past 1440 minutes', () => {
  assert.deepEqual(workingDay('2026-03-03T01:30:00Z', 'UTC', 240), { date: '2026-03-02', minute: 1530 });
  assert.deepEqual(workingDay('2026-03-03T04:00:00Z', 'UTC', 240), { date: '2026-03-03', minute: 240 });
  assert.deepEqual(workingDay('2026-03-03T01:30:00Z', 'UTC'), { date: '2026-03-03', minute: 90 });
  assert.deepEqual(workingDay('2026-03-02T23:30:00Z', 'Europe/Zurich', 0), { date: '2026-03-03', minute: 30 });
});

test('buildReport: day_starts moves 01:30 to the day before as 01:30+1; one before the period is left out', () => {
  const r = report();
  const personal = placeOf(r, 'personal');
  assert.deepEqual(personal.days.map((d) => [d.date, d.first, d.last]), [['2026-03-02', '01:30+1', '01:30+1'], ['2026-03-07', '20:00', '20:00']]);
  assert.deepEqual([r.days[0].first, r.days[0].last, r.days[0].bySource], ['09:00', '01:30+1', { git: 3, jira: 3, github: 2 }]);
  assert.equal(r.days[1].bySource.git, undefined); // 03-03 01:30 is the 2nd's
  assert.equal(r.all.measures.totals.commits, 5); // the 02:00 commit of the 2nd is the 1st's: outside
  const md = markdown(r);
  assert.match(md, /A working day starts at 04:00: an action before it belongs to the day before, its time shown with \+1 \(01:30\+1\)\.$/m);
});

test('renderMarkdown: the calendar cell first–last · actions, — outside the period, the Active column, per place and for all', () => {
  const md = markdown(report());
  const calendar = section(md, '## Calendar');
  assert.match(calendar, /^### ACME Corp\n\n\| Week of \| Mon \| Tue \| Wed \| Thu \| Fri \| Sat \| Sun \| Active \|$/m);
  assert.match(calendar, /^\| 2026-03-02 \| 09:00–17:30 · 7 \| 08:00–08:00 · 1 \| 09:30–15:00 · 3 \| 1 \| {2}\| {2}\| {2}\| 4 \|$/m);
  assert.match(calendar, /^\| 2026-03-02 \| 01:30\+1–01:30\+1 · 1 \| {2}\| {2}\| {2}\| {2}\| 20:00–20:00 · 1 \| {2}\| 2 \|$/m);
  assert.match(calendar, /^### all places\n\n.*\n.*\n\| 2026-03-02 \| 09:00–01:30\+1 · 8 \| 08:00–08:00 · 1 \| 09:30–15:00 · 3 \| 1 \| {2}\| 20:00–20:00 · 1 \| {2}\| 5 \|$/m);
  const across = renderMarkdown(buildReport(results(), { ...PERIOD, since: '2026-03-04', until: '2026-03-10', settings: SETTINGS }), { person: 'Ada', collectedAt: 'now' });
  assert.match(section(across, '## Calendar'), /^\| 2026-03-02 \| — \| — \| 09:30–15:00 · 3 \| 1 \| {2}\| {2}\| {2}\| 2 \|$/m);
  assert.match(section(across, '## Calendar'), /^\| 2026-03-09 \| {2}\| {2}\| — \| — \| — \| — \| — \| 0 \|$/m);
});

test('buildReport: the per-day medians and means of a place over its active days; spans over days with two timed actions', () => {
  const m = placeOf(report(), 'ACME Corp').measures;
  assert.deepEqual([m.activeDays, m.weekendDays, m.firstMedian, m.lastMedian], [4, 0, 540, 900]);
  assert.deepEqual(m.spanHours, { median: 7, mean: 7 });
  assert.deepEqual(m.perActiveDay.actions, { median: 2, mean: 3 });
  assert.deepEqual(m.perActiveDay.commits, { median: 0.5, mean: 0.75 });
  assert.deepEqual(m.perActiveDay.codeTestsAdded, { median: 0, mean: 40 });
  assert.deepEqual(m.perActiveDay.jiraActions, { median: 0.5, mean: 1 });
  assert.deepEqual(m.totals.jira, { created: 1, status: 1, comment: 1, worklog: 1, edit: 1 });
  assert.equal(m.totals.jiraActions, 4);
  assert.deepEqual(m.perWorkday, { actions: 12 / 5, commits: 3 / 5, codeTestsAdded: 160 / 5 });
  const p = placeOf(report(), 'personal').measures;
  assert.deepEqual([p.activeDays, p.weekendDays], [2, 1]);
  const perDay = section(markdown(report()), '## Per day, by place');
  assert.match(perDay, /^\| Measure \| ACME Corp \| personal \| all places \|$/m);
  assert.match(perDay, /^\| Active days \(weekend days among them\) \| 4 \(0\) \| 2 \(1\) \| 5 \(1\) \|$/m);
  assert.match(perDay, /^\| First action, median \| 09:00 \| 22:45 \| 09:15 \|$/m);
  assert.match(perDay, /^\| First–last span, h, median · mean \(days with ≥ 2 timed actions\) \| 7 · 7 \| {2}\| 11 · 11 \|$/m);
  assert.match(perDay, /^\| Actions per active day, median · mean \| 2 · 3 \| 1 · 1 \| 1 · 2.8 \|$/m);
  assert.match(perDay, /^\| Docs lines \+\/− \| \+205 \/ −0 \| \+0 \/ −0 \| \+205 \/ −0 \|$/m);
  assert.match(perDay, /^\| Jira: created · status changes · edits · comments · worklogs \| 1 · 1 · 1 · 1 · 1 \| 0 · 0 · 0 · 0 · 0 \| 1 · 1 · 1 · 1 · 1 \|$/m);
  assert.match(perDay, /^\| Others' PRs\/MRs reviewed \(PR × day\) · their lines \+\/− \| 2 · \+600 \/ −80 \| 0 · \+0 \/ −0 \| 2 · \+600 \/ −80 \|$/m);
  assert.match(perDay, /divides the period's total by its 5 Mon–Fri days/);
});

test('buildReport: an event with a date and no time counts for active days and actions, not for first and last; a note says so', () => {
  const r = report();
  const day = dayOf(placeOf(r, 'ACME Corp'), '2026-03-05');
  assert.deepEqual([day.actions, day.timed, day.first, day.last], [1, 0, null, null]);
  assert.match(r.sources.find((s) => s.source === 'jira').notes.join('\n'), /^1 event\(s\) with a date but no time: counted on their day, not in the first and last action$/m);
});

test('buildReport: the place of each event from the rules, unmatched → the default; the breakdown gets a Place column', () => {
  const r = report();
  assert.deepEqual(r.places.map((p) => [p.place, p.actions]), [['ACME Corp', 12], ['personal', 2]]);
  assert.deepEqual(r.sources.find((s) => s.source === 'github').breakdown.places, ['ACME Corp', 'personal']);
  assert.deepEqual(r.settings, { file: SETTINGS.file, defaultPlace: 'ACME Corp', rules: [{ label: 'personal', patterns: ['ada-tools'] }], dayStarts: '04:00' });
  const md = markdown(r);
  assert.match(md, /^## github — per repository\n\n\| Place \| Repository \| PRs \|\n\|---\|---\|---\|\n\| ACME Corp \| acme\/web \| 2 \|\n\| personal \| ada\/ada-tools \| 1 \|$/m);
  assert.match(md, /^Places \(settings: \/work\/\.local\/footprint\/config\.yaml; the first rule that matches decides\): \*\*personal\*\* = `ada-tools`; \*\*ACME Corp\*\* = what no rule names\. Places come from the user: the tool never guesses/m);
  assert.match(md, /^- gitlab: not collected — connector gitlab is not listed$/m);
});

test('buildReport: a review counts once per pull request and day, with its lines once', () => {
  const r = report();
  const acme = placeOf(r, 'ACME Corp');
  assert.deepEqual([dayOf(acme, '2026-03-02').reviews, dayOf(acme, '2026-03-02').reviewed], [1, [300, 40]]);
  assert.deepEqual([dayOf(acme, '2026-03-04').reviews, dayOf(acme, '2026-03-04').reviewed], [1, [300, 40]]);
  assert.equal(dayOf(acme, '2026-03-03').reviews, 0); // own PR opened: not a review
  assert.deepEqual([r.all.measures.totals.reviews, r.all.measures.totals.reviewed], [2, [600, 80]]);
  assert.deepEqual(acme.changed.reviewed, [{ repository: 'acme/web', reviews: 2, lines: [600, 80] }]);
});

test('renderMarkdown: By week per place, the hours beside all places', () => {
  const week = section(markdown(report()), '## By week');
  assert.match(week, /^### ACME Corp\n\n\| Week of \| Active days \| Span h, mean \| Actions \| Commits \| Code\+tests \+ \| Docs \+ \| Jira actions \| Reviews \| Reviewed lines \|$/m);
  assert.match(week, /^\| 2026-03-02 \| 4 \| 7 \| 12 \| 3 \| \+160 \| \+205 \| 4 \| 2 \| \+600 −80 \|$/m);
  assert.match(week, /^### all places\n\n\| Week of .* \| Reviewed lines \| sheet h \|$/m);
  assert.match(week, /^\| 2026-03-02 \| 5 \| 11 \| 14 \| 5 \| \+210 \| \+205 \| 4 \| 2 \| \+600 −80 \| 8 \|$/m);
});

test('renderMarkdown: What changed per place — repositories with their three largest commits, Jira by project, issues, reviewed', () => {
  const r = report();
  assert.deepEqual(placeOf(r, 'ACME Corp').changed.repositories.map((x) => [x.repository, x.commits, x.days, x.largest]),
    [['lib', 1, 1, ['Docs']], ['app', 2, 1, ['Add login', 'Fix login']]]);
  const changed = section(markdown(r), '## What changed');
  assert.match(changed, /^### ACME Corp\n\n\| Repository \| Commits \| Days \| Code\+tests \| Docs \| Largest commits \|\n\|---\|---\|---\|---\|---\|---\|\n\| lib \| 1 \| 1 \| \+0 −0 \| \+200 −0 \| Docs \|\n\| app \| 2 \| 1 \| \+160 −12 \| \+5 −0 \| Add login; Fix login \|$/m);
  assert.match(changed, /^Jira actions by project: PROJ 4\.$/m);
  assert.match(changed, /^\| PROJ-1 \| 2 \| created 1, status 1 \| Login page \|$/m);
  assert.match(changed, /^\| acme\/web \| 2 \| \+600 −80 \|$/m);
  assert.match(changed, /^### personal\n\n\| Repository .*\n.*\n\| ada-tools \| 2 \| 2 \| \+50 −5 \| \+0 −0 \| Weekend; Night fix \|$/m);
  const big = buildReport([{
    source: 'git', label: 'git', totals: [], notes: [],
    events: [10, 40, 20, 30].map((n, i) => ({ at: `2026-03-02T1${i}:00:00Z`, kind: 'commit', what: `app: Change ${n}`, lines: lines([n, 0], [0, 0], [0, 0]) })),
  }], PERIOD);
  assert.deepEqual(big.all.changed.repositories[0].largest, ['Change 40', 'Change 30', 'Change 20']);
});

test('renderMarkdown: By day — a row per day and place, the hours on the date\'s first row, the Content column', () => {
  const day = section(markdown(report()), '## By day');
  assert.match(day, /^\| Date \| Day \| Place \| First \| Last \| git \| jira \| github \| sheet h \| Content \|$/m);
  assert.match(day, /^\| 2026-03-02 \| Mon \| ACME Corp \| 09:00 \| 17:30 \| 2 \| 3 \| 2 \| 8 \| app \+165 −12; PROJ-1 ×2, PROJ-2 ×1 \|$/m);
  assert.match(day, /^\| 2026-03-02 \| Mon \| personal \| 01:30\+1 \| 01:30\+1 \| 1 \| {2}\| {2}\| {2}\| ada-tools \+20 −5 \|$/m);
  assert.match(day, /^\| 2026-03-06 \| Fri \| {2}\| {2}\| {2}\| {2}\| {2}\| {2}\| {2}\| {2}\|$/m);
  assert.match(day, /^\| 2026-03-05 \| Thu \| ACME Corp \| {2}\| {2}\| {2}\| 1 \| {2}\| {2}\| PROJ-3 ×1 \|$/m);
});

test('buildReport: the JSON object holds no Map or Set, and reads back the same', () => {
  const r = report();
  const walk = (v, path) => {
    assert.ok(!(v instanceof Map) && !(v instanceof Set), `a ${v?.constructor?.name} at ${path}`);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(r, 'report');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('buildReport: on others\' PRs a review, review comment, merge, approval or MR merge is a review; a commit, a comment, a close is not', () => {
  const pr = (n) => ({ what: `acme/web#${n}`, where: 'acme/web', pr: `https://github.com/acme/web/pull/${n}`, others: true });
  const r = buildReport([{
    source: 'github', label: 'GitHub', totals: [], notes: [],
    events: [
      { at: '2026-03-02T09:00:00Z', kind: 'commit', ...pr(1) },
      { at: '2026-03-02T10:00:00Z', kind: 'comment', ...pr(2) },
      { at: '2026-03-02T11:00:00Z', kind: 'issue closed', ...pr(3) },
      { at: '2026-03-03T09:00:00Z', kind: 'review comment', ...pr(4) },
      { at: '2026-03-03T10:00:00Z', kind: 'merge', ...pr(5) },
      { at: '2026-03-03T11:00:00Z', kind: 'mr approved', ...pr(6) },
      { at: '2026-03-03T12:00:00Z', kind: 'mr merged', ...pr(7) },
      { at: '2026-03-03T13:00:00Z', kind: 'review', ...pr(8), others: undefined }, // on the person's own PR
    ],
  }], { ...PERIOD, settings: SETTINGS });
  assert.deepEqual(r.all.days.map((d) => [d.date, d.reviews]), [['2026-03-02', 0], ['2026-03-03', 4]]);
  assert.equal(r.all.measures.totals.reviews, 4);
  assert.match(section(renderMarkdown(r, { person: 'Ada', collectedAt: 'now' }), '## Per day, by place'),
    /^Reviewed lines are counted once per pull or merge request and day here; the sources' totals count them once per pull or merge request\.$/m);
});

/**
 * git and the code hosts in one week: one commit in git, its copies on GitHub (a commit) and GitLab
 * (pushes) in the repositories git read; a GitHub commit in a repository git did not read and a
 * GitLab push to a project with no local clone, on the 3rd.
 */
function withCopies(sources = ['git', 'github', 'gitlab']) {
  const all = {
    git: {
      source: 'git', label: 'git', totals: [], notes: [],
      events: [{ at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'app: Add', where: '/src/app', lines: lines([5, 0], [0, 0], [0, 0]) }],
      remotes: ['github.com/acme/app', 'gitlab.example.com/acme/api', 'gitlab.example.com/ada/ada-tools'],
    },
    github: { source: 'github', label: 'GitHub', site: 'https://github.com', totals: [], notes: [], events: [
      { at: '2026-03-02T07:00:00Z', kind: 'commit', what: 'acme/app#1', where: 'Acme/App', pr: 'u1' },
      { at: '2026-03-02T11:00:00Z', kind: 'pr opened', what: 'acme/app#1', where: 'acme/app', pr: 'u1' },
      { at: '2026-03-03T06:00:00Z', kind: 'commit', what: 'acme/other#2', where: 'acme/other', pr: 'u2' },
    ] },
    gitlab: { source: 'gitlab', label: 'GitLab', site: 'https://GitLab.example.com/', totals: [], notes: [], events: [
      { at: '2026-03-02T20:00:00Z', kind: 'push', what: 'acme/api', where: 'acme/api' },
      { at: '2026-03-04T09:00:00Z', kind: 'push', what: 'ada/ada-tools', where: 'ada/ada-tools' },
      { at: '2026-03-03T21:00:00Z', kind: 'push', what: 'acme/no-clone', where: 'acme/no-clone' },
    ] },
  };
  return buildReport(sources.map((s) => all[s]), { ...PERIOD, settings: SETTINGS });
}

test('buildReport: a GitHub commit or GitLab push in a repository git read is no action nor first or last action — one commit counted once; elsewhere, or without git, it is', () => {
  const r = withCopies();
  const day = dayOf(r.all, '2026-03-02');
  assert.deepEqual([day.actions, day.first, day.last, day.bySource], [2, '10:00', '11:00', { git: 1, github: 1 }]);
  // The GitHub commit in a repository git did not read and the push to a project with no local clone are actions.
  const other = dayOf(r.all, '2026-03-03');
  assert.deepEqual([other.actions, other.first, other.last, other.bySource], [2, '06:00', '21:00', { github: 1, gitlab: 1 }]);
  assert.equal(r.all.measures.totals.pushes, 3);
  // The personal place has a push in a repository git read only: a place with no action.
  assert.deepEqual(placeOf(r, 'personal'), { ...placeOf(r, 'personal'), actions: 0, activeDays: 0 });
  assert.match(r.sources.find((s) => s.source === 'github').notes.join('\n'),
    /^1 commit event\(s\) left out of the actions and of the first and last action: they are in repositories git read, and one commit is counted once/m);
  assert.match(r.sources.find((s) => s.source === 'gitlab').notes.join('\n'), /^2 push event\(s\) left out of the actions/m);
  const md = markdown(r);
  assert.match(md, /^One commit is counted once: with git collected, its commits are the actions, and GitHub commits and GitLab pushes in the repositories git read are not/m);
  assert.match(section(md, '## Per day, by place'), /^\| GitLab pushes \(those in repositories git read are not actions: git counts the commits\) \| 2 \| 1 \| 3 \|$/m);
  assert.match(section(md, '## Calendar'), /^### personal\n\nNo action of personal in the period\.$/m);
  assert.match(section(md, '## By week'), /^### personal\n\nNo action of personal in the period\.$/m);
  assert.match(section(md, '## What changed'), /^### personal\n\nNo action of personal in the period\.$/m);
  const without = withCopies(['github', 'gitlab']);
  const alone = dayOf(without.all, '2026-03-02');
  assert.deepEqual([alone.actions, alone.first, alone.last], [3, '07:00', '20:00']);
  assert.equal(without.all.measures.totals.pushes, 3);
  assert.match(section(markdown(without), '## Per day, by place'), /^\| GitLab pushes \| 2 \| 1 \| 3 \|$/m);
  assert.doesNotMatch(markdown(without), /One commit is counted once/);
});

test('buildReport: a code host\'s commit is matched by its site — an Enterprise host, not github.com; a source with no site has no copies', () => {
  const git = { source: 'git', label: 'git', totals: [], notes: [], events: [], remotes: ['ghe.example.com/acme/app'] };
  const commit = { at: '2026-03-02T09:00:00Z', kind: 'commit', what: 'acme/app#1', where: 'acme/app' };
  const actions = (site) => buildReport([git, { source: 'github', label: 'GitHub', site, totals: [], notes: [], events: [commit] }], PERIOD).all.measures.totals.actions;
  assert.equal(actions('https://ghe.example.com'), 0);
  assert.equal(actions('https://github.com'), 1);
  assert.equal(actions(undefined), 1);
});

test('renderMarkdown: a place the settings name with no event at all says it has no action, as one with events but no action', () => {
  const settings = { ...SETTINGS, rules: [...SETTINGS.rules, { label: 'client', patterns: ['client-x'] }] };
  const r = buildReport([{
    source: 'git', label: 'git', totals: [], notes: [], remotes: [],
    events: [{ at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'app: Add', where: '/src/app', lines: lines([5, 0], [0, 0], [0, 0]) }],
  }], { ...PERIOD, settings });
  assert.deepEqual(r.places.map((p) => [p.place, p.actions, p.activeDays]), [['ACME Corp', 1, 1], ['client', 0, 0], ['personal', 0, 0]]);
  const md = markdown(r);
  assert.match(section(md, '## Per day, by place'), /^\| Measure \| ACME Corp \| client \| personal \| all places \|$/m);
  for (const heading of ['## Calendar', '## By week', '## What changed']) {
    for (const place of ['client', 'personal']) assert.match(section(md, heading), new RegExp(`^### ${place}\n\nNo action of ${place} in the period\\.$`, 'm'), `${heading} ${place}`);
  }
});

test('renderMarkdown: the header says 1 day for a one-day period, days for more', () => {
  const one = renderMarkdown(buildReport([], { ...PERIOD, until: PERIOD.since }), { person: 'Ada', collectedAt: 'now' });
  assert.match(one, /^1 day, 1 of them Mon–Fri \(holidays not known\)\.$/m);
  assert.match(markdown(report()), /^7 days, 5 of them Mon–Fri/m);
});

test('renderMarkdown: By week shows 0 and +0 for a week with nothing of a kind; the largest commits have lines', () => {
  const r = buildReport([{
    source: 'git', label: 'git', totals: [], notes: [],
    events: [
      { at: '2026-03-02T10:00:00Z', kind: 'commit', what: 'app: Pipeline run', where: '/src/app' }, // no lines
      { at: '2026-03-02T11:00:00Z', kind: 'commit', what: 'app: Real work', where: '/src/app', lines: lines([5, 1], [0, 0], [0, 0]) },
    ],
  }, { source: 'jira', label: 'Jira', totals: [], notes: [], events: [] }], { ...PERIOD, since: '2026-03-02', until: '2026-03-15' });
  const week = section(renderMarkdown(r, { person: 'Ada', collectedAt: 'now' }), '## By week');
  assert.match(week, /^\| 2026-03-02 \| 1 \| 1 \| 2 \| 2 \| \+5 \| \+0 \| 0 \|$/m);
  assert.match(week, /^\| 2026-03-09 \| 0 \| {2}\| 0 \| 0 \| \+0 \| \+0 \| 0 \|$/m);
  assert.deepEqual(r.all.changed.repositories[0].largest, ['Real work']);
});

test('buildReport: an event with neither a time nor a date is counted in the notes; an unknown Jira kind is "other" in the per-kind row', () => {
  const r = buildReport([{
    source: 'jira', label: 'Jira', totals: [], notes: [],
    events: [{ kind: 'comment', what: 'PROJ-1 x', where: 'PROJ' }, { at: '2026-03-02T10:00:00Z', kind: 'vote', what: 'PROJ-1 x', where: 'PROJ' },
      { at: '2026-03-02T11:00:00Z', kind: 'status', what: 'PROJ-1 x', where: 'PROJ' }],
  }], PERIOD);
  assert.match(r.sources[0].notes.join('\n'), /^1 event\(s\) with no time or date that can be read left out of the days$/m);
  const perDay = section(renderMarkdown(r, { person: 'Ada', collectedAt: 'now' }), '## Per day, by place');
  assert.match(perDay, /^\| Jira: created · status changes · edits · comments · worklogs · other \| 0 · 1 · 0 · 0 · 0 · 1 \|$/m);
  assert.doesNotMatch(markdown(report()), /worklogs · other/);
});

test('buildReport: the breakdown keeps its rows\' places, not the text they were matched on; a period ending today says the day is still running', () => {
  const where = '/src/app https://git.example.com/acme/app.git';
  const r = buildReport([{
    source: 'git', label: 'git', totals: [], notes: [], events: [],
    breakdown: { title: 'per repository', header: ['Repository'], rows: [['acme/app']], wheres: [where] },
  }], { ...PERIOD, settings: SETTINGS, today: PERIOD.until });
  assert.deepEqual(r.sources[0].breakdown, { title: 'per repository', header: ['Repository'], rows: [['acme/app']], places: ['ACME Corp'] });
  assert.ok(!JSON.stringify(r).includes('/src/app'), 'no path or remote in the report');
  assert.deepEqual(r.notes, ['the period ends today (2026-03-08): the day is still running, its actions are those up to the collection']);
  assert.match(markdown(r), /^- the period ends today \(2026-03-08\): the day is still running/m);
  assert.deepEqual(buildReport([], { ...PERIOD, today: '2026-03-09' }).notes, []);
});

test('renderMarkdown: without settings every event is in one place, a day begins at midnight, and the report renders', () => {
  const r = buildReport(results(), PERIOD);
  assert.equal(r.settings, null);
  assert.deepEqual(r.places.map((p) => p.place), ['all']);
  assert.equal(r.days[1].first, '01:30');
  const md = markdown(r);
  assert.doesNotMatch(md, /^Places /m);
  assert.doesNotMatch(md, /working day starts/);
  assert.doesNotMatch(md, /^### /m);
  assert.match(md, /^\| Measure \| all \|$/m);
  assert.match(md, /^\| Date \| Day \| First \| Last \| git \| jira \| github \| Content \|$/m);
  assert.match(md, /^\| Place \| Repository \| PRs \|\n.*\n\| all \| acme\/web \| 2 \|$/m);
  for (const heading of ['## Per day, by place', '## Calendar', '## By week', '## What changed', '## By day', '## Totals', '## Notes']) assert.match(md, new RegExp(`^${heading}$`, 'm'));
  const empty = renderMarkdown(buildReport([{ source: 'x', label: 'X', totals: [], events: [], notes: [] }], PERIOD), { person: 'Ada', collectedAt: 'now' });
  assert.match(empty, /^No action in the period\.$/m);
});
