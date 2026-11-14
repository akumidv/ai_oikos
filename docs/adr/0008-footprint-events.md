# ADR 0008 — footprint: one collector of digital traces — events, slices, sessions, meaning, releases

**Status: accepted by the owner** on 2026-11-14 (D-FP3-ACCEPT). The owner chose the shape in chat the
same day (D-FP3-SHAPE events and slices, D-FP3-SESSIONS-ACTIONS session messages are actions,
D-FP3-SCOPE the decision chain and team facts now, D-FP3-HOSTS Claude Code, Qwen Code and Codex) and
accepted the blocks below with the design's event schema, finals and delegations as facts.
Design, event schema and definitions: [docs/design/footprint.md](../design/footprint.md).
Implementation state: [`_aitna/TASKS.md`](../../_aitna/TASKS.md) F19. Builds on the existing
`tools/footprint` (sources git, github, gitlab, jira, confluence; places; the report).

## D01 — Events and slices: `collect` crawls into a store, `slice` reports windows
<a id="dec-0008-d01"></a>`Decision-ID: DEC-0008/D01`

- **Choice.** Every source returns normalized **events** (schema in the design § Event). `collect`
  runs the sources over `--since … --until`, **saves** their events in the installation's store
  `.local/footprint/events/<person>/<source>.jsonl` with a crawl record in `crawls.jsonl`, and prints
  the period's report as today (each source's own totals and breakdowns). A new command
  **`slice`** reads the store and prints one report per `--window` (a number of days ending at
  `--until`, or a start date), many windows from one crawl; its totals per source are counted
  from the events (by kind, lines by kind), and a window the crawls do not cover for a source says so
  in the Notes. `collect --no-save` keeps the store untouched. A re-crawl of a source **replaces**
  its stored events whose working day lies in the crawled period and those with the same `id`; a snapshot event
  (`snapshot: true` — uncommitted work, first activity) is replaced whole at each crawl of its source.
  **A re-crawl never erases what its source could not see** (D-FP3-PARTIAL-RECRAWL, owner 2026-11-14):
  `sessions` replaces only the events of the transcript files it read (a transcript the host has since
  deleted keeps its stored events); a crawl that is partial — a repository, host or request failed or
  was cut — is merged by `id` instead of replacing the period (snapshots too), and the Notes say so.
  A crawl records its repositories and identity; when a re-crawl's differ from the previous crawl's
  over an overlapping period, `collect` says so in a note — the earlier events of that period are
  replaced — and does not stop (D-FP3-RECRAWL-WARN, owner 2026-11-14). The store stays open text under
  `.local/` like the other stores of ADR 0002, not encrypted (D-FP3-STORE-OPEN, owner 2026-11-14).
- **Rationale.** The prototype measured three windows at once; a crawl of a year of transcripts
  and git history should not repeat per window. Keeping `collect`'s report as it is leaves every
  existing source and test intact; the store is the installation's, inside `.local/` (ADR 0002).

## D02 — Actions and facts
<a id="dec-0008-d02"></a>`Decision-ID: DEC-0008/D02`

- **Choice.** An event is an **action** of the person unless it says `action: false`, a **fact**.
  Facts stay out of the days, first and last action, calendar and weeks, and appear in their own
  sections: releases, team facts, decision documents, an agent's final summaries, delegations and
  choice dialogs, uncommitted work, first activity. **Owner messages to an agent are actions**
  (owner, 2026-11-14): they move active days and the first and last action like a commit does. An
  agent's output is not the person's action: it is counted in Sessions.
- **Rationale.** Typing to an agent is work done at that minute; what the agent wrote afterwards
  is not, and counting it would stretch the day past the person.

## D03 — Source `sessions`: agent transcripts of any host, one adapter per host
<a id="dec-0008-d03"></a>`Decision-ID: DEC-0008/D03`

- **Choice.** A source `sessions` reads local transcripts through adapters — **Claude Code, Qwen
  Code, Codex** now; another host (Cursor, Gemini) only when a user has it — into one session-event
  form. Each host's folder has a default (from the host's own home variable, else under the user's
  home) that `sessions: { claude|qwen|codex: <dir> | false }` in `.local/footprint/config.yaml`
  overrides. The **repository comes from the record's working directory**, matched to the clones of
  `--repos` (else the directory itself is the `where`, which places match) — never from a folder
  name; **with `--repos` given, only the sessions whose working directory lies inside those clones or
  their worktrees count** (D-FP3-SESSIONS-REPOS, owner 2026-11-14), without it every session does.
  Identity is the machine's user: the source runs with `--me` only. **A message a tool sent in the
  owner's name is not an owner message**: the installation lists such prompts as patterns
  (`sessions_skip_prompts`), the core names none, and a skipped message counts nowhere
  (D-FP3-MACHINE-PROMPTS, owner 2026-11-14); the owner's answer to a choice dialog stays an owner
  message. A note from another agent that the owner forwards (a host's wrapper around it) is an owner
  message — the decision to send it is the owner's — but only the owner's own words around it count as
  owner words; the note's words count as read, like a final summary (D-FP3-SIDE-NOTE, owner 2026-11-14). Definitions — owner
  message, final summary, decision request (headings configurable, `decision_headings`), declared
  none, answered, delegation, choice dialog, words, reading reference — are the design's § Sessions.
  **No text is stored**: events carry counts, codes and flags only.
- **Rationale.** Agent work can be a large part of a person's footprint and none of it is in the other
  sources; transcripts differ per host, the questions asked of them do not.

## D04 — Meaning of changes in the git source
<a id="dec-0008-d04"></a>`Decision-ID: DEC-0008/D04`

- **Choice.** Lines get a fourth kind, **other** (config and data), apart from code, tests and
  docs. A commit event carries the **test functions it added** (per language), the **decision codes**
  and **task keys** its message names, and the decision directories it touched. **Decision
  documents** (`decision_dirs`, default `docs/adr`, `docs/design`, `docs/measurements`,
  `docs/reviews`) are read across every ref: a path counts once, only if it exists at the newest
  commit that touched it; its first add gives date and author; an ADR's `Status` line — the first
  line that *starts* with the word "status" after markdown markers, so a title naming "status" is not
  it (D-FP-STATUS-LINE, owner 2026-11-14) — gives its status and decided date. **Every ADR that appeared or was decided in the period counts, any status
  (Proposed too), from every ref; one path once** (owner, 2026-11-14). Deletions against additions
  per repository are shown as a ratio.
- **Rationale.** Lines alone say how much, not what; decisions, tests and config are the meaning the
  first CV pass had to count by hand.

## D05 — Releases are repository facts
<a id="dec-0008-d05"></a>`Decision-ID: DEC-0008/D05`

- **Choice.** Releases are facts, never the person's actions: git **tags** created in the period
  over all refs; **CHANGELOG** entries of the period, marked breaking; **GitHub Releases** of the
  organization's repositories; **production releases by rule** —
  `releases: { rule: merge-days, base: main, repos: [owner/a, …] }`: distinct UTC dates of pull
  requests merged into `base` across the named repositories (one date in any of them is one
  release). A release branch merged back counts once (by tag and by path, D04).
- **Rationale.** A release is a team's result; reporting it apart keeps a person's footprint honest.

## D06 — Small additions
<a id="dec-0008-d06"></a>`Decision-ID: DEC-0008/D06`

- **Choice.** `collect --uncommitted`: the clones' uncommitted and untracked lines by kind, dated by
  file modification, as a snapshot fact flagged "not yet committed". **First activity**: the person's
  first commit (git) and first pull request (GitHub) as snapshot facts. **Issues closed** by the
  person on GitHub, with their cycle time; GitLab's events already carry issues. A GitHub or GitLab
  wiki and a vault are git repositories: passed as `--repos`, their pages count as docs.
- **Rationale.** Each answers a question the CV pass asked of an ad-hoc script.

## D07 — Team facts: the source `team`, the user's counting rule, no ranking
<a id="dec-0008-d07"></a>`Decision-ID: DEC-0008/D07`

- **Choice.** A source **`team`**, not run by default (`--source team`): Jira projects with their
  lead, versions released in the period, people assigned per project; git authors per repository in
  the period. All are facts. **Who counts as a team member is the user's rule**
  (`team: { members: […], projects: […] }`), the report prints it; without members the people are
  "seen", not a team. People are listed by name and **never ranked by a count**: a team's size and
  composition are shown, people are not compared with each other (D-FP3-TEAM-COUNTS, owner
  2026-11-14). Team events have no store of their own: they are saved under `--person <team>`
  (D-FP3-TEAMSTORE, owner 2026-11-14). A skill scenario `team-facts`
  states the purpose first, as every footprint scenario does.
- **Rationale.** Team size and composition are asked for a lead's CV and a review, but they are
  about a team, not a person, and must not become a ranking.

## D08 — The decision chain
<a id="dec-0008-d08"></a>`Decision-ID: DEC-0008/D08`

- **Choice.** A `slice` and `collect` section **Decision chain**: each decision code asked in the
  window (pattern `decision_codes`, default `D-…`/`Q-…`) → answered (an owner message after it) →
  the decision documents whose text names it → the commits whose message names it or that touched
  those documents, from the day the code was first asked (a commit event carries the decision
  document paths it touched) → the release: the first tag that holds every linked commit, where the
  decision shipped whole (read as the latest of each commit's first tag, exact when tags lie along one
  line of history) → the task keys those commits name, with the tracker's status changes on
  them where Jira ran (D-FP3-CHAIN-CODES, owner 2026-11-14). Links are searched over every stored event, so a
  question asked in the window links to an ADR written after it.
- **Rationale.** Decided work runs question → decision → code → release; the chain shows
  it end to end instead of four disconnected counts.

## D09 — CV assembly stays in the installation
<a id="dec-0008-d09"></a>`Decision-ID: DEC-0008/D09`

- **Choice.** The core keeps the footprint (tool and skill); assembling a CV from it is the
  installation's own skill (owner, 2026-11-14, superseding the concept's core `cv-from-footprint`).
  The core `cv` skill stays the reviewer of CV text; its `own-cv` scenario points at footprint.
- **Rationale.** A CV's form is a person's, not the organization toolkit's.
