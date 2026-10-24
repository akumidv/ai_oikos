# Scenario: activity against recorded hours

The user wants to see a person's activity next to the hours they recorded — the Jira worklog, a
timesheet, the calendar — for a period. The result is the timeline with the hours beside it and a
reading of where they agree and where they do not, without accusing anyone.

## Steps

1. **Purpose, person, period** as in [period-report.md](period-report.md), steps 1–3. A comparison
   with hours is the kind of monitoring the law restricts: when the person is not the user, the
   purpose and the person's knowledge matter even more.
2. **The recorded hours.**
   - **Jira worklog** comes with the `jira` source: hours on the calendar date of the worklog's
     start (in the report's time zone, as a timesheet keeps them), for the person's account.
   - **A timesheet** is a CSV passed with `--hours` (repeatable; each file is a label, its file
     name — two files of one name are told apart by their folder). One row per day,
     `date,hours` and nothing more: the separator `,`, `;` or a tab, hours as `7.5`, `7,5` or
     `7:30` (after a `,` separator a decimal comma is quoted, `"7,5"` — an unquoted one is
     refused), a header row skipped when it is the first and does not start with a date.

     ```csv
     date;hours
     2026-10-13;7,5
     2026-10-14;8:15
     ```

   - **Calendar hours** — the accepted events per day, through the `workspace` skill — are added
     by hand as a section of their own, `## Meetings` (the skill, § Sources without code).
3. **Collect by day.**

   ```bash
   node oikos/tools/footprint/cli.mjs collect --since 2026-10-01 --until 2026-10-31 --me \
     --repos ~/src --hours ~/timesheets/2026-10.csv --by day --purpose "worklog against activity, October"
   ```

   The By day table puts, for each working day and place, the first and last action, the events
   per source, the hours per label and what the day's work was (repositories with their lines,
   issues with their actions) side by side; the Calendar shows the same first and last action week
   by week. The first and last action come from every timed source — commits, Jira actions
   (created, status changes, edits, comments, worklogs), GitHub pull requests, reviews, comments
   and merges, GitLab events — not from commits alone. When the person works past midnight, pass
   `--day-starts 04:00` (or `day_starts` in `.local/footprint/config.yaml`): an action at 01:30 then
   belongs to the day before and shows as `01:30+1`, while the hours stay on their calendar date.
4. **Read the gaps and overlaps.** Say what is seen, then the ordinary reasons it may be so —
   never that someone did not work or logged too much.
   - **Hours with no events**: meetings, reviews and pairing in conversation, reading, design and
     thinking, support, travel, work in systems not collected (mail, chat, documents, a customer's
     systems), a training day.
   - **Events with no hours**: hours logged on another day or in a bulk entry, a timesheet not
     filled yet, a short fix on a day off, commits made earlier and pushed or rebased later.
   - **The span of a day** (first to last action) is not working time: a commit at 08:00 and a
     review at 19:00 say nothing about the hours between.
   - **Dates that shift**: the report's time zone (`--tz`) against the person's; a day that runs
     past midnight (`day_starts`) against hours recorded on the calendar date; Jira reads dates
     in the account's time zone, so a worklog near midnight may sit on the neighbouring day; git
     keeps the author date, which a rebase or a cherry-pick carries over and which is not when the
     work was pushed; GitHub's and GitLab's events and Jira's actions carry their time and land on
     working days like git's.
   - **What the sources miss**: GitHub sees only the commits on pull requests, not those pushed
     straight to a branch (git counts them where the clone has them); repositories the token
     cannot read; clones not fetched.
5. **Report.** Totals of recorded hours per label next to the active days, the weeks where they
   diverge most, and the reasons above that may explain it; questions to ask the person rather
   than conclusions. Save as in [period-report.md](period-report.md), step 6.
