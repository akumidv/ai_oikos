# Design — footprint: events, slices, sessions, meaning of changes, releases, team facts

Decisions: [ADR 0008](../adr/0008-footprint-events.md). This file owns the contract the code follows:
the event schema, the store, the commands, each new source's definitions and each new section. The
skill ([skills/footprint/SKILL.md](../../skills/footprint/SKILL.md)) owns how a user runs it.

## Shared definitions

`tools/footprint/meaning.mjs` holds the default decision headings, decision codes, decision dirs, the task-key
pattern, the line kinds and `wordsOf`; every source and section imports them from there.

## Event

Every source returns `{ source, label, totals, events, breakdown?, notes, hours?, remotes?, site?, partial?,
partialReasons?, filesRead? }` as before (`remotes` git, `site` GitHub and GitLab, `filesRead` sessions — the
transcripts it read, § Store); `partial: true` with `partialReasons` (text) when a repository, host, request, file
or folder failed or was cut, so the store merges that crawl instead of replacing the period (§ Store). An event is
a plain object:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | unique within the source and stable across crawls (a commit hash, `host:session:record`, `tag:<repo>:<name>`); the store derives one from the event's content when a source gives none |
| `at` / `date` | ISO instant / `YYYY-MM-DD` | when; one of them (a date alone counts for its day, not the first and last action) |
| `kind` | string | what happened (`commit`, `message`, `final`, `tag`, …) |
| `what`, `where` | string, string\|null | as today: the text shown, the text places match (a path, a remote, `owner/repo`, a key) |
| `action` | `false` or absent | absent: an action of the person; `false`: a fact (ADR 0008 D02) |
| `snapshot` | `true` or absent | replaced whole at each crawl of its source (uncommitted work, first activity, project leads) |
| `lines` | `{ code, tests, docs, other }` each `[added, deleted]` | a commit's, or uncommitted work's |
| `detail` | object | the kind's own fields (tables below) |

Existing fields (`count`, `pr`, `reviewed`, …) stay as the sources emit them.

Facts dated by a day alone carry `date` and no `at`: `changelog entry`, `production release`, `repository author`,
`version released`. A commit's `id` is its full hash, so the same commit in two clones is one event. A
commit's `detail.decisionPaths` and a session's `detail.file` are defined in § Meaning of changes and § Sessions.

## Store

`.local/footprint/events/<person>/` — `<person>` the slug of `--person`, else `me` with `--me`, else
the first of `--name`, `--github`, `--gitlab`, `--atlassian`, `--email`, else `unknown`. The store is open
text under `.local/` like the other stores of ADR 0002 (no secret in it; the events hold none). One
`<source>.jsonl` per source (one event per line, `source` added) and `crawls.jsonl` (one line per source per
crawl: `{ at, source, since, until, tz, dayStarts, events, skipped?, partial?, partialReasons?, repos?, identity?,
remotes?, site? }`; `partial` and `partialReasons` only for a partial crawl; `repos` the repositories the source
read (sorted, `null` for a source that reads none) and `identity` who its events are of, both only when the run
gives them; `remotes` (git) and `site` (GitHub, GitLab) are what the
report matches code-host copies of commits by — `slice` takes their union over the source's crawls, so a
pushed commit counts once as in `collect`; over a crawl saved without them a pushed commit still counts twice
until its window is crawled again).

**Replace rule** (`replaceCrawled`, D-FP3-PARTIAL-RECRAWL, ADR 0008 D01). Saving a source's crawl reads its
file and keeps the stored events, except:

- a complete crawl without `filesRead` drops the stored events whose `id` is among the new ones, those whose working day lies in
  the crawled period (`inWorkingPeriod`, the rule the sources keep actions by; a date-only event by its date),
  and every `snapshot` event;
- a **partial** crawl drops only the stored events whose `id` is among the new ones (merge by id: same-id events
  replaced, nothing else dropped), snapshots included, and the Notes say the crawl was partial;
- a result with `filesRead` (`sessions`) drops in-period events only of the transcripts it read
  (`detail.file` among them): a transcript read that gave no event in the period still clears its old ones;
  a transcript the host has since deleted, or one it could not read, keeps its events. A stored event with no
  `detail.file` (saved before that field existed) names no transcript, so the old period rule decides it and
  the crawl's Notes say how many such legacy events it replaced.

Then the new events are appended (with `source` and `id`; `hours` as their own events); the file is written to a
temporary file and renamed. `periodBounds` is only the
API's bound and never decides what is stored. A decision document lies in the period when its add
instant, its `detail.added` or its `detail.decided` does, so an ADR added earlier and decided in the
period is replaced by that crawl. A crawl row also records the repositories and the identity it ran with;
when a re-crawl's `repos` or `identity` differ from the latest earlier crawl of that source over an
overlapping period (`recrawlNotes`), `collect` prints a note on stderr and in the source's Notes, saying the
earlier crawl's events of the overlap are replaced, and does not stop (D-FP3-RECRAWL-WARN, ADR 0008 D01).
A crawl row without a recorded scope (an older store) is not compared. `hours` of a source
(Jira worklogs) are saved as events `{ kind: 'hours', date, action: false, detail: { hours } }`, id
`hours:<date>`, and turned back into `hours` when sliced. Nothing in an event holds message text:
counts, codes, flags, subjects of commits and titles as the report shows them.

## Commands

- `collect` — as before, plus: saves into the store (`--no-save` skips it), new sources `sessions` and
  `team` (`team` only when `--source` names it), `--uncommitted`, and the new sections in its report.
- `slice --window <days|YYYY-MM-DD> … [--until] [--tz] [--person] [--by] [--hours] [--purpose] [--config]
  [--place …] [--default-place] [--day-starts] [--out <dir>] [--json]` — one report per window from the
  store; `--person` defaults to the only person in the store, else `me`; an empty store exits 1. A window `14` is the 14 days
  ending at `--until` (default today); a date is that day to `--until`. Places and the working day
  come from the settings at slice time. Totals per source are counted from the events: events by
  kind, git lines by kind and tests added (only for commits that carry lines — a code host's commits in
  pull requests carry none, so GitHub and GitLab slices show no such rows), the lines reviewed (a code host's
  review events carry `reviewed`; counted per pull request and day), session words. A window or part of one no crawl of a source
  covered is named in the Notes. `--out` writes `<dir>/<store folder>-<since>-<until>.md` per window
  (`.json` with `--json`) instead of stdout. With `collect --no-save` the run's events are laid over the
  store in memory for the chain and the store is not written.

## Settings (`.local/footprint/config.yaml`, read by `places.mjs`)

```yaml
sessions: { claude: ~/.claude/projects, qwen: false }   # a folder, or false = off; absent = the host's default
sessions_skip_prompts: ["^Run the nightly digest"]       # regexes of typed text a tool sent in the owner's name; none in the core
decision_headings: ["Needed from you", "Нужно от вас", "Нужно от тебя", "Требуется от"]
decision_codes: "\\b[DQ]-[A-Z0-9]+(?:-[A-Z0-9]+)*\\b"
reading_reference: { label: "a long novel", words: 100000 }   # optional; none by default
decision_dirs: [docs/adr, docs/design, docs/measurements, docs/reviews]
releases: { rule: merge-days, base: main, repos: [acme/app, acme/api] }
team: { members: [ada@example.com, "Sam Example"], projects: [PROJ] }
```

`footprintSettings` returns them parsed: `sessions` as `{ claude, qwen, codex }` each a path, `null`
(default) or `false`; `sessionsSkipPrompts` one RegExp per listed string (none by default; the patterns are
the installation's — the core names none; an invalid pattern is a usage error naming it); `decisionHeadings` one case-insensitive RegExp matching a heading line
(after `#`, `*`, `>`, `-`, `_` and spaces); `decisionCodes` a global RegExp; `readingReference`
`{ label, words }|null`; `decisionDirs` strings; `releases` `{ rule, base, repos }|null`; `team`
`{ members, projects }`. A bad value is a usage error naming the key.

## Sessions (source `sessions`)

**Hosts.** Default folders — Claude Code: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`;
Qwen Code: `~/.qwen/projects`; Codex: `$CODEX_HOME/sessions` and `archived_sessions`, else under `~/.codex/` (§ Host formats).
A host whose folder does not exist is noted, not an error. `collect` reads the sessions source after
the other sources finish, not beside them: git's synchronous child processes and the transcript reader's
growing memory in one process slowed both several times over. A transcript file last modified before the
period's start is not read. Sub-agent records are skipped. **`--repos` filter** (D-FP3-SESSIONS-REPOS, ADR 0008
D03): with `--repos` given, only the sessions whose working folder lies inside one of those clones or inside a
linked worktree of one (matched by the git common directory) count; the others are skipped and named in a note
(`N session(s) outside --repos skipped`). Without `--repos` every session counts. A file or folder that cannot be
read makes the crawl `partial` with a reason. Each adapter turns a file into records
`{ role: 'owner'|'assistant'|'other', at, session, recordId, cwd, text?, finalCandidate?, tools }`, and the shared
part applies the definitions.

**Definitions.**

- *Owner message* — a main-thread user record whose content is typed text: not a tool result, not
  meta, not a compaction summary, not an injected wrapper (`<command-name>`, `<local-command-stdout>`,
  a `<system-reminder>`-only text, a task notification, a hook's output, an interruption marker).
  Wrapper tags are removed before deciding; what remains must be non-empty. A typed text matching a
  `sessions_skip_prompts` pattern is a tool's message sent in the owner's name (D-FP3-MACHINE-PROMPTS, ADR 0008
  D03): it is not an owner message, is no action and no fact, counts nowhere, and the Notes give the number
  skipped (`N message(s) matching sessions_skip_prompts skipped`). A session left with **no owner message**
  after that was started by a tool: it counts nowhere (not in sessions, finals, delegations, dialogs or
  codes) and the Notes say `N session(s) started by a tool skipped`; the rule reads no host signal. The
  owner's answer to a choice dialog stays an owner message (ADR 0008 D03), counted at the record's time with
  the words of the chosen answers only, no text stored: Codex writes it as a `UserMessage` item; Claude Code
  as the `tool_result` of an `AskUserQuestion` call (the chosen answers are `toolUseResult.answers`, else the
  `"question"="answer"` pairs of the result text; a declined call, an error result, is no answer); Qwen as
  the `tool_result` of `ask_user_question` whose `toolCallResult.resultDisplay.answers` lists the answers
  (status `success`).
  A note from another agent that the owner forwards is an owner message too (D-FP3-SIDE-NOTE, ADR 0008 D03):
  the decision to send it is the owner's, so it counts even with no comment, but only the owner's own words
  outside the note are *owner words* (0 with no comment; `sessions_skip_prompts` is matched against those
  words only); the note's words are *words read*, like a final summary, in `detail.noteWords`. Claude Code writes
  it as a human-origin user record whose text has the line `Here is a note offered by a side agent:`, then the note
  as `>`-quoted lines; the owner's comment is the text before that line and after the quote. A peer record
  (`origin.kind: peer`, an agent message or hand-back) is not the owner's.
- *Final summary* — the last text block of an assistant message when the next main-thread record is
  not the assistant continuing (the end of a run). Narration between tool calls is not a final.
- *Decision request* — a final with a heading line matching `decision_headings`. Its items: the rest
  of the heading line when it has text, every bullet below it, every line opening with a code; with
  none, the first prose line. Items that all say nothing (`nothing`, `none`, `no questions`, `нет`,
  `ничего`, `—`) make the request *declared none*. *Questions* = the other items.
- *Codes* — `decision_codes` matches in the first 80 characters of each question item.
- *Answered* — an owner message follows the final in the same session.
- *Delegation* — a tool call that starts a sub-agent (`Agent`, `Task`, the host's equivalent);
  *choice dialog* — a structured question to the user (`AskUserQuestion`, the host's equivalent).
- *Words* — runs of letters, digits, marks and underscores (`wordsOf` in `tools/footprint/meaning.mjs`, the prototype's `\w+`).

**Events.** `message` (action) `detail { host, session, words, noteWords? }` (`noteWords` only for a forwarded note); `final` (fact) `detail { host,
session, words, request, questions, none, codes, answered }`; `delegation`, `choice dialog` (facts)
`detail { host, session }`. Every session event carries `detail.file` = `<host>:<path of the transcript under the
host's folder>` (the transcript's key; `filesRead` lists the keys read, § Store). `where`: the clone of `--repos`
that holds `cwd` or a worktree of it (`<path> <remote>`, as git's events), else `cwd`. `what`: `<repository label
or folder name>: <host> session`.

**Section Sessions** (per place, then per repository): sessions, active days, owner messages ·
words, finals · words, decision requests (with questions · declared none · answered), distinct
codes (and of them in answered requests), delegations, choice dialogs; a by-week table; the words
read (final summaries and forwarded notes) against `reading_reference` when set.

## Meaning of changes (git)

- *Kinds* (`fileKind`, first match wins): **generated** (left out: lock files, `*.min.js`/`*.min.css`,
  `*.map`, `*.snap`, paths under `node_modules/ vendor/ dist/ build/ .venv/`, and the settings'
  `generated` paths); **tests** (test or spec folders, `*_test.*`, `*.test.*`, `*.spec.*`, `test_*`);
  **other** — config and data: `.json .jsonc .yaml .yml .toml .ini .cfg .conf .csv .tsv .xml .properties`,
  `.env.example`; **docs** (`.md .mdx .rst .txt .adoc .org .tex`, wherever the file lies, so
  `skills/data/SKILL.md` is docs); **code** (a known code extension, wherever the file lies, so a `data/`
  package of code is code); else **other** — a file with no known code or doc extension (`.gitignore`,
  `*.rules`, a dotfile, a file in a `data/` or `fixtures/` folder that is neither code nor docs; ADR 0008 D04).
  Binary files count as files, with no lines.
- *Tests added* on a commit: added lines matching `^\+\s*(async\s+)?def test_`, `^\+\s*(it|test)\s*\(`,
  `^\+\s*#\[test\]`, `^\+\s*func Test[A-Z_]`, `^\+\s*@Test\b`, counted only in tests-kind files. Read with
  one `git log --stdin -p -U0` over the hashes of the person's commits that touch a tests-kind file (the
  patch is then filtered to those files). A pipeline repository's commits add no tests (`testsAdded` 0).
- *Commit event* (`id` the full hash, `kind: commit`, action): `detail { repo, testsAdded, codes, keys,
  decisionDirs, decisionPaths, releasedIn? }` and `lines { code, tests, docs, other }`; a pipeline repository's
  commit has no `lines` (its lines go to the pipeline total alone).
- *Codes and keys* of a commit: `decision_codes` and task keys (`\b[A-Z][A-Z0-9]+-\d+\b`) in its
  subject and body. `decisionDirs` of a commit: the configured dirs it touched. `decisionPaths`: the decision
  documents it touched, as `decisionPathsOf` reads them — the `.md` files under a configured dir, a path once,
  in an `adr` folder only `NNNN-*.md`, each in the order of the commit's files. A commit that touched a document
  under its old name carries the old path, which no longer matches the document's path (the newest name).
- *Decision documents*: for each repository and dir, the `.md` paths ever under it on any ref
  (`git log --branches --tags --remotes --no-merges --name-status`, oldest first, a rename followed to
  its new name); kept only when it exists at the newest commit that touched it. `added` and
  `firstAuthor` (`{ name, email }`) come from the oldest commit that added or renamed it in. In
  `docs/adr`, files named `NNNN-*.md` only. ADR status from the first line that **starts with** `status`
  after markdown markers (`#`, `*`, `_`, `>`, `-`, spaces), not the first line that merely contains it
  (D-FP-STATUS-LINE, ADR 0008 D04): accepted, superseded, proposed or draft (→ proposed), else other;
  `decided` = the first date on that line, else `added`. An event `decision document` (fact) per path whose `added` or `decided`
  is in the period: `id doc:<repo>:<path>`, `at` the add instant, `detail { repo, path, dir, status,
  added, decided, firstAuthor, byPerson, codes, words }`.
- *Releases from git*: `tag` facts (`for-each-ref refs/tags`, creator date in the period, `detail
  { repo, tag }`); `changelog entry` facts from `CHANGELOG.md` at HEAD (`## [x.y.z] … YYYY-MM-DD`,
  `breaking` when a `### Breaking`/`### ⚠` follows), `kind: changelog entry`, `date` in the period and no
  `at`, `detail { repo, version, breaking }`. A commit whose message names a code or a key, or touches a
  decision dir, gets `detail.releasedIn { tag, at }`, the oldest tag that contains it.
- *Uncommitted* (`--uncommitted`, snapshot facts, not limited to the period): `git diff --numstat HEAD`
  (tracked changes, binary as 0 lines) and untracked files not ignored, at most 2000 per repository
  (the rest are named in the Notes), each read for its lines unless binary or over 5 MB (0 lines);
  generated files left out. Per file `{ id uncommitted:<repo>:<path>, at mtime, lines, detail { repo,
  path, untracked } }`; a deleted tracked file is dated now.
- *First commit* (snapshot fact `first commit`) per repository: the person's oldest non-merge commit over
  any ref, `detail { repo, hash }`.

**Section Meaning of changes** (per place): per repository code/tests/docs/other lines, tests added,
deleted ÷ added. **Section Decisions**: the decision documents of the window by dir; ADRs with status,
added, decided, first author, by the person; counts by status and by person; the person's distinct
commits that touched an ADR dir (amendments).

## Releases (git, github)

GitHub (with `GITHUB_ORG`): `github release` facts — releases published in the period per
repository (`detail { repo, tag, prerelease }`); with `releases.rule: merge-days` a `production
release` fact per distinct UTC date of a pull request merged into `base` in any named repository
(`id prod:<date>`, `date`, `detail { repos, pulls }`). **Issues closed** by the person: `issue
closed` actions with `detail { repo, number, cycleDays }`. **First pull request**: snapshot fact.
**Section Releases** ("team and repository facts, not the person's actions"): tags per repository,
changelog entries (breaking marked), GitHub releases per repository, production release dates and their count.

## Team facts (source `team`)

Jira (where listed): for `team.projects` (else the projects of the issues updated in the period that
the account can see; at most 1000 issues scanned, a cut is named in the Notes): `project lead` snapshot
facts; `version released` facts (release
date in the period); `assigned issue` facts (issues updated in the period: `detail { project,
person, member }`). Git: `repository author` facts per repository, author and day. **Section Team
facts**: the counting rule as the user wrote it; per project the lead, versions released, people
assigned (members marked, by name — never by count); per repository the authors. Without
`team.members` the people are "seen in the period", not a team.

**No ranking** (D-FP3-TEAM-COUNTS, ADR 0008 D07): people are listed by name, sorted by name, never ordered or
ranked by a count of issues, commits or lines; the members' number is the rule's count, shown beside the rule.

**Storage** (D-FP3-TEAMSTORE, ADR 0008 D07): team events have no store of their own. `collect --source team`
saves them under `--person <team>`; without `--person` they are saved under the person of the other flags
(`me` with `--me`, else the first identity flag, else `unknown`), beside that person's events, and the team's
Notes say so and suggest `--person <team>`.

## Decision chain

Over the window's `final` events with codes (D-FP3-CHAIN-CODES, ADR 0008 D08), linked through every stored
event (`history`, when `collect` or `slice` has the store; else the window's events):

1. the code → first asked: the earliest `final` with a request naming it, over the whole history (date);
2. → answered: the date of the owner's next message in the same session, else `Y` when the request was
   answered in its transcript, else `N`;
3. → decision documents: the documents whose `detail.codes` name the code (one per repository and path); the table
   gives a **Repository** column beside **Documents**, one repository per document in the same order, since one
   path can exist in two repositories;
4. → commits: those whose `detail.codes` name the code, **or** whose `detail.decisionPaths` touch one of those
   documents, on or after the day the code was first asked (the date is compared; a commit that merely
   touches a decision dir is not linked);
5. → release: the first tag that holds every linked commit, where the decision shipped whole. Each commit's
   `releasedIn` is the oldest tag containing it; the release is the latest of those (ties by tag name), and
   `—` when any linked commit is unreleased or none is linked. This is exact when the tags lie along one line
   of history; across diverging release lines it can name a tag that does not contain every commit;
6. → task keys of the linked commits, and the tracker's status changes on those keys where Jira ran.

One row per code; an empty link is shown as `—`.

**Limits.** A commit that touched a document under its old name carries the old path, which is not the document's
newest path, so it links only through its codes. A deleted document is not kept as a document (it must exist at
the newest commit that touched it, § Meaning of changes), so it links nothing.

## Host formats

Checked on real files on 2026-11-14 (structure only). All three hosts write injected context as
user-role text, so an adapter separates the owner by the host's provenance fields, not by the text.

| | Claude Code | Qwen Code | Codex |
|---|---|---|---|
| Files | `<projects>/<slug>/<sessionId>.jsonl` | `~/.qwen/projects/<slug>/chats/<sessionId>.jsonl` (not `*.ledger.jsonl`) | `<sessions>/YYYY/MM/DD/rollout-*.jsonl`, and `archived_sessions/rollout-*.jsonl` beside `sessions` |
| Sub-agents | separate files under `<sessionId>/subagents/` — not read; a record with `isSidechain: true` skipped | separate files under `<slug>/subagents/` — not read; `isSidechain: true` skipped | a separate rollout whose `session_meta.payload.thread_source` is not `user` (sub-agent, guardian review) — skipped whole |
| Record | `type` user / assistant (others ignored), `message.content` string or blocks (`text`, `tool_use`, `tool_result`, `thinking`) | `type` user / assistant / tool_result / system, `message.parts[]` (`text`, `text`+`thought`, `functionCall`, `functionResponse`) | `{ type, timestamp, payload }`: `session_meta`, `turn_context`, `response_item`, `event_msg`, … |
| Owner message | `type: user`, not `isMeta`, not `isCompactSummary`, `origin.kind` absent or `human` (not `peer`), no `tool_result` block, typed text left after wrappers; or the `tool_result` of an `AskUserQuestion` call (the answers) | `type: user`, `provenance: real_user`, text parts; or the `tool_result` record of `ask_user_question` (its `answers`) | `event_msg` with `payload.type: item_completed` and `payload.item.type: UserMessage` (its `content[].text`); the twin `response_item` user message is not counted again |
| Assistant text | `type: assistant`, `text` blocks; the final rule above | `type: assistant`, non-thought `text` parts; a record with a `functionCall` is not a final | `response_item` `message`, `role: assistant`, `phase: final_answer` is a final; `commentary` is narration |
| Delegation | `tool_use` named `Agent` or `Task` | `functionCall` named `agent` or `create_sub_session` | `function_call` named `spawn_agent` (namespace `collaboration`) |
| Choice dialog | `tool_use` named `AskUserQuestion` | `functionCall` named `ask_user_question` | `function_call` named `request_user_input_async` (by its name; unverified) |
| cwd | the record's `cwd` | the record's `cwd` | the latest `turn_context.payload.cwd`, else `session_meta.payload.cwd` |
| Session | `sessionId` | `sessionId` | `session_meta.payload.id` |
| Time | `timestamp` | `timestamp` | `timestamp` |

Default folders: Claude `$CLAUDE_CONFIG_DIR/projects` else `~/.claude/projects`; Qwen
`~/.qwen/projects`; Codex `$CODEX_HOME/sessions` (and `archived_sessions`) else `~/.codex/…`.

## Tests

Synthetic fixtures only: Claude, Qwen and Codex transcripts (an owner message, a wrapper, a
sidechain, a final with an English and a Russian heading, a declared none, a question code, a
delegation, a choice dialog); a git fixture with decision documents on two branches, a rename, a
deletion, a proposed and an accepted ADR, tags, a CHANGELOG, a test function, a config file; the
store's replace rule and a slice over two windows; team facts against canned Jira answers.

## Acceptance (in the installation, numbers stay there)

From the installation, `collect` over the period the prototype measured: sessions and ADR counts
equal the prototype's, or the difference is explained by a definition change the owner agreed.
