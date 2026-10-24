# Scenario: a person's footprint over a period

The user names a person — themselves or someone else — and a period ("last quarter", "this
week", "since March") and wants to know what that person did across the organization's
resources. The result is one markdown report, read for the user and saved to the installation's
`.local/`.

## Steps

1. **Purpose and person.** Ask what the report is for, unless the user said it — it goes into the
   report as `--purpose` — and turn the period into dates (`--since`, `--until`; a quarter is its
   first to its last day). When the
   person is not the user: ask whether they know, say that employee monitoring is restricted by
   law (the skill, § Rules), and go on only on the user's yes.
2. **Identity.** For the user, `--me` is enough in every source with credentials;
   `identify --me [--repos ~/src]` shows who that is in each one. For someone else:

   ```bash
   node oikos/tools/footprint/cli.mjs identify --name "Ada Lovelace" --repos ~/src
   ```

   It lists candidates per source: git authors (name and email), GitLab users, Jira and
   Confluence accounts, GitHub users (public names only: a login with no public name is not found
   — ask the user). Confluence finds no one by email: an email given as `--atlassian` is
   resolved through Jira when the `jira` connector is listed with its credentials; otherwise pass
   an account id or a name.
   Show the candidates and let the user pick; a person often has several git emails (work,
   personal, an old domain) — take every one that is theirs.
3. **Sources.** `node oikos/tools/footprint/cli.mjs sources` shows which sources are listed and
   have credentials. Say which will be collected and which will not, and why. Before git: the
   clones under `--repos` should be fetched, or the report misses what was pushed elsewhere.
   **Places:** read `.local/footprint/config.yaml` (the skill, § Places and settings) and, when it
   names no places or the purpose needs the split, ask the user which repositories, projects and
   spaces are not the organization's — never infer it from a name; what no rule names is the
   default place. Ask too when the person's day runs past midnight (`day_starts`).
4. **Collect.**

   ```bash
   node oikos/tools/footprint/cli.mjs collect --since 2026-07-01 --until 2026-09-30 \
     --email ada@example.com --email ada@old.example.com --name "Ada Lovelace" \
     --github ada --gitlab ada --atlassian "Ada Lovelace" \
     --repos ~/src --repos ~/notes --person "Ada Lovelace" --purpose "quarterly review"
   ```

   Add the sources without code (the skill, § Sources without code) as their own sections, when
   the purpose needs them and their connectors are available.
5. **Read it for the user.** Not a recital of the tables:
   - **the calendar** — the usual start and end of a working day (the median first and last
     action), the weekends with work, how the work splits by place (the organization's against a
     personal project or another client) and how that changed over the weeks. A span from the
     first to the last action is not hours worked: say so whenever a span is quoted;
   - **what stands out** — the busiest weeks and the quiet ones, where the work went (What
     changed: which repositories and their largest commits, projects and issues, spaces), the mix
     of kinds (code, tests, docs, reviews, issues, pages);
   - **what the numbers leave out** — every source under Notes as not collected or cut at a cap,
     GitHub work outside pull requests (commits pushed straight to a branch) or in repositories
     the token cannot read (and without `GITHUB_ORG`, whatever GitHub search left out: a lower
     bound), Jira actions on issues outside those the person had to do with (a comment there is
     missed) — and which issues are read depends on their state now, so a later run can find
     more actions on older days — Confluence edits (the person's versions saved in the period,
     version 1, the creation, not counted as an edit, on the pages they ever contributed to that
     changed since the period began — at most 500 pages looked into), a period that ends today
     (the day is still running), and the work no system records: meetings, reviews in
     conversation, design, support, mentoring;
   - for the purpose: what of this goes into the weekly report, the review or the CV, and what to
     ask the person about rather than conclude.
6. **Save.** Write the report to `.local/footprint/<person>-<since>-<until>.md` (e.g.
   `.local/footprint/ada-2026-07-01-2026-09-30.md`), with the reading from step 5 at the end. An
   earlier report for the same period is kept beside it, not overwritten, unless the user says so:
   first rename it to `<person>-<since>-<until>-collected-<YYYY-MM-DD>.md`, the date of its own
   `Collected` line (e.g. `ada-2026-07-01-2026-09-30-collected-2026-10-02.md`), so the plain name
   is always the latest. Sending it anywhere is a separate step through `messaging` or
   `workspace`, with confirmation.
