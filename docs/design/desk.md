# Design — the desk agent: notes to tasks in a standing session

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
becomes a commitment until it is moved into an ADR block the owner accepts; implementation steps
live in [`_aitna/TASKS.md`](../../_aitna/TASKS.md) (A1–A7).

**State:** the owner decided the form, the akmon relation and the retention in chat
(§ Decisions given). [ADR 0006](../adr/0006-desk-agent.md) accepted, with the owner's additions: config part `desk:`; akmon is the source of the rules for agents and skills. **How to
resume:** read § Frame and § Design, then § Open points.

## Frame

- **Problem.** A manager's work arrives as scattered material: ideas, pasted chats, meeting
  fragments. Turning it into tracker tasks, comments and messages was done in one long session
  that went wrong in four ways: (1) the list was split into units wrongly, and the owner corrected
  it twice *after* the texts were written (two tasks taken for one; items meant for a message put
  into a task); (2) raw tool output filled the context in about half an hour; (3) drafts were left
  in flat per-topic folders, superseded ones next to current ones; (4) a draft carried a link no
  tool had returned.
- **Goal.** A standing session that collects notes as they come, builds a digest on request,
  writes the texts, and creates the tasks only after approval — keeping its context small by
  keeping its state on disk. Later the same agent reviews the result of a task (a comment, a
  document, a pull request), reads the messages about it and proposes the move.
- **Constraints already decided.** Writes to a live service are a dry run, the text shown, the
  user's yes, then the same command ([ADR 0001](../adr/0001-tracker-transitions.md),
  [ADR 0004](../adr/0004-tracker-policy.md)); every text a tool writes passes the content check (a message gets the read-only `outgoing check` before it is shown)
  ([ADR 0003](../adr/0003-outward-content.md)); a first name under `.local/` that does not start
  with `.` is open working space ([ADR 0002](../adr/0002-local-stores.md) D01); a task's parked
  state is `HANDOFF.md` ([ADR 0005](../adr/0005-work-package.md)); the human decides, the agent
  prepares.
- **Acceptance.** Given a pasted list of five items, the agent shows the unit table first, the
  owner corrects it once, and no text is written before the table is agreed; after the tasks are
  created, a fresh session started from the index alone knows what was created and what is still
  open.

## Survey

- **Three things are called "agent".** A *worker* — a subagent with a whitelist of inputs and no
  dialogue (the `k_*` delegates of akmon; the `agents/*.md` files of a sibling assistant project).
  A *role charter* — akmon's agent: `_aitna/agents/<role>/README.md`, a role applied in a project,
  for development only. A *standing agent* — an open session with its own state: described
  nowhere. This document uses "agent" for the third and "worker" for the first.
- **akmon has one runtime-side hook for it and nothing more.** The session-start hook lists the
  subfolders of a root `agents/` that hold a `README.md` as "OPERATE (run/use from outside)"
  (`_aitna/akmon/hooks/hook_core.py` `agent_names`, `hook_core.json` `operate_line`). No format,
  scaffold or check for that root. But `akmon verify` already checks the *development* charters under `_aitna/agents` (`checkAgentCharters`: `charters.present`, `charters.readme`, `charters.role-link`; MODEL.md § inheritance contract), and the roster sees only `<project-root>/agents/`, not `<installation>/oikos/agents/` — a second `README.md` convention must not clash with the first. There is no way in akmon to author an agent or a skill except the learn loop,
  and the `platform` archetype says a runtime hosting OPERATE actors is out of its scope; its CONCEPT and ROADMAP put OPERATE as a whole ("an agent that acts in the world") out of scope.
- **A sibling assistant project shows the useful split.** The skill owns the dialogue and the
  confirmations and shows what will be written, waiting for a yes; the worker has an input
  whitelist, minimal tools and a result contract in prose; an existing file is never overwritten;
  free text is classified first (instruction, note, own task, question, unclear). It has no
  retention, no index and no context discipline — a hand-off note is all there is.
- **oikos today.** Ten skills, no agent concept. `task-tracking` has the move gate
  (`scenarios/move-task.md`) but no review of a result — it is named as not the scenario's job.
  `messaging` reads Slack and posts only after the exact channel and text are confirmed; there is
  no "what was said about this task" flow. `handoff park` and the `context-pressure` hook exist.
  Drafts live in the scratchpad or in an open folder of `.local/`.

## Design

### The agent, in oikos: a thin charter

An agent in oikos is a folder `agents/<name>/README.md` in the core, and nothing more:

```
---
name: desk
description: <what it does, and when to start it, with example phrases>
skills: [notes, task-tracking, messaging, wiki, code-hosting]   # every one must exist in skills/
owns: desk                                  # its folder under .local/
metadata: { owner: oikos }
---
```

then sections: **Mission**; **Skills and how it uses them** (links to the skills, no copy of their
rules); **Owns** (the folder, what lives in it, how long); **Never** (what it does not do and who
does); **Session start**; **Closing a topic**; **Workers** (the briefs it may delegate to).

- **No permissions of its own.** The guards stay on tools; an agent cannot widen them and its
  charter says so. It may only narrow, by naming what it never does.
- **The installation switches it on** the way it switches on connectors: `agents: [desk]` in
  `oikos.yaml`. An agent not listed is not started and not offered.
- **Delivery reuses skill delivery.** `sync` writes a pointer per listed agent, in the same
  `.claude/skills/` and `.qwen/skills/` folders and with the same marker, saying "start this
  agent: read `oikos/agents/<name>/README.md` and follow it". Both hosts work with no new host
  machinery — but today `sync` removes any marked pointer that is not in its skills list and its
  template is skills-only (`tools/sync/cli.mjs`), so A1 changes that loop and the `sync --check`
  drift report. The roster line sees only `<project-root>/agents/`, not `oikos/agents/`, so
  listing enabled agents in the installation's session-start hook is also A1.
- **Checks (`npm run check`):** frontmatter valid; every listed skill exists; `owns` is not a
  closed or legacy store name (`isStoreName`); an installation lists only agents that exist;
  `skills/` and `agents/` pointer names do not collide. The installation-side checks cannot fire on a bare core checkout (the core is no installation) — as with connectors; A1 splits core-side from installation-side checks.
- **What the charter is not:** a runtime, a permission model, a place for rules that belong to a
  skill. Anything a skill knows, the agent links.

### The skill `notes` — the capability

`skills/notes/` (the group is open — `collaboration` means messenger, wiki, mail, calendar; the frontmatter needs `when_to_use`, `surface`, `refuses`, `metadata.owner` and `metadata.group`): usable in any session, without the agent. It owns the
know-how; the agent owns the standing procedure.

| Scenario | When | Does |
|---|---|---|
| `capture` | free text arrives | classify each piece (instruction, note, own task, question, unclear — unclear gets one question); append verbatim with a time to the topic's `notes.md`; answer in one line. No tracker or messenger call |
| `digest` | the owner asks for the summary | group into **units** and show the table: unit · kind (task, comment, message, document, conditional task) · where (project, assignee) · source · open question. Nothing is drafted until the owner has agreed the table |
| `draft-and-create` | the table is agreed | per unit: facts from the systems (a worker, written to the topic folder), the text in the project's shape, dry run, show, yes, the same command; at creation, per unit, record the key and a one-line reason in `plan.md` and mark the draft redundant (compression does not wait for the topic to close); put keys into the message drafts; sending a message is a separate confirmation |
| `compact` | a topic is older than the threshold | see § Retention |

Rules that hold in every scenario:

- **Verbatim first.** A note is kept as said; the cleaned text sits beside it, with guesses marked
  `(?)`. An existing file is never overwritten.
- **A link comes from a tool result or from the owner**, else it carries `(?)`. A project key or a
  person typed by the owner is looked up before it is used; a near miss is asked about, not fixed
  silently.
- **Tracker texts are English** (task-tracking rule) in the shape *Goal / What to do / Done when*.
  **"Done when" is required**: it is what a later review checks the result against.
- **A conditional follow-up** ("if gaps are found, file a task in project X") is a section of the
  task or of the message, not a skeleton file kept on the side.

### The desk agent

Mission: the standing session for a manager's incoming material. Skills: `notes`, `task-tracking`,
`messaging`; `wiki` and `code-hosting` read-only. Owns `.local/desk/`. Mail and calendar (`workspace`) are not in the v1 skill set — material arrives
by the owner's paste and from the messenger; deferred on purpose.

- **Session start:** read `INDEX.md` and the `plan.md` of open topics only (a card exists only for a closed topic); offer the compaction
  of topics past the threshold (never run it unasked); say what is open.
- **Closing a topic:** write `card.md`, update the index line, offer to move superseded drafts
  to `_superseded/`; from then on refer to the topic by its card.
- **Never:** move a task's status by itself, send a message unasked, delete a file, read a topic's
  raw notes again once it is closed unless asked.

### Storage

```
.local/desk/
  INDEX.md                     # one line per topic: date · topic · keys · tags · status
  2026-10-27/                  # the day the topic was started
    api-review/           # the topic slug
      notes.md                 # append-only: original / cleaned (?) / time
      plan.md                  # the unit table: kind, where, source, status, key
      draft-1.md …             # the texts
      card.md                  # ≤ 10 lines: outcome, keys, decisions, open items, paths
  _archive/                    # raw material of compacted topics, by month
```

- A topic that runs for several days stays in the folder of the day it started; the index finds
  it. Unit status: `open` · `drafted` · `created` · `sent` · `dropped`.
- `card.md` is the topic's own short state, not a `HANDOFF.md`. A desk is not a project task:
  `handoff park` ([ADR 0005](../adr/0005-work-package.md)) does not carry it, and moving the whole
  desk to another machine or session is copying `.local/desk/` (O3).
- The folder name is not a closed store, so the next session's file tools can read it.
- **Two status stores:** when `plan.md` and the tracker disagree, the tracker wins; the agent
  says so and corrects `plan.md`.
- **Slugs and the index:** a slug taken on the same day gets `-2`; `INDEX.md` is rebuilt by the
  tool from the topic folders, never edited by hand, so two sessions cannot corrupt it.
- **Reopening:** `desk find --archive` searches the archived summaries and raw notes; `desk reopen
  <topic>` moves a topic back from `_archive/`, so "unless asked" in the Never-list has a route.

### The cycle and the context

1. **Capture** — cheap, many times a day. 2. **Digest** — the table; the owner corrects the
split. 3. **Facts and texts** — by workers. 4. **Dry run, yes, create.** 5. **Close** — card,
index line.

The agent cannot clear its own context; three mechanisms carry the load:

- **Disk is memory, context is a cache.** A closed topic is referred to by its card line only.
- **Workers take the heavy steps** (searches in the knowledge base, tracker reads, drafting): they
  write to the topic folder and return a short summary, so the output never reaches the main
  context. In the observed session that output is what filled it.
- **A named moment to compact.** After a topic closes, the agent offers `/compact` with a ready
  instruction ("keep the index and the cards, drop raw output") or a fresh session started from
  the index. The `context-pressure` hook may add this to its advice; it cannot run `/compact`.

### Retention

| Age (from the last activity: last note or draft) | Kept | Done by |
|---|---|---|
| up to 30 days | the whole folder | — |
| over 30 days | `card.md` and `summary.md` (outcome, keys, decisions, links); raw notes and drafts move to `_archive/<YYYY-MM>/` | `desk compact` |
| over 90 days | one line in the index; card and summary move into `_archive/` (`find` searches the index, then the archived summaries) | `desk compact` |

- **Only a topic whose every unit is `created`, `sent` or `dropped` is compacted.** A topic with
  an `open` or `drafted` unit stays hot and shows in the index as open — an idea not yet turned
  into a task must not compress to nothing.
- **A draft equal to a created task is redundant** (the tracker holds the text): the summary keeps
  the key and the reason for the decision, not the text.
- **Nothing is deleted by the agent.** Raw material moves to `_archive/`; the owner removes it.
- **The tool does the mechanics, a worker the prose.** `tools/desk/cli.mjs`: `new <slug>` (the
  topic's folder, `-2` on a taken slug, writes at once), `index` (rebuilds `INDEX.md`, writes at once),
  `reopen`, `list` (topics with
  state and age), `find <text|key>` (index first, then summaries), `compact [--warm-days N
  --cold-days N] [--yes]` — a plan by default, applied with `--yes`, writes only under
  `.local/desk/`, so it is a local write like `handoff park` and not in `writes.mjs`. The worker
  writes `summary.md`; the tool moves files and rebuilds the index. Thresholds: a `desk:` part (`settings` holds flat env-style values, so a structured part follows the `task-tracking:` precedent; the owner chose it)
  in `oikos.yaml` (`warm_days: 30`, `cold_days: 90`).

### Working with current tasks (phase 2)

- **`review-result`**, a scenario of `task-tracking`: input a key; read the "Done when", the
  comments, the attachments, the links and the pull requests; the result is a **document**
  (a page or file), a **comment**, or **code**. Judge against "Done when"; write the verdict to
  a topic folder (a task the desk did not create gets a new topic); produce either a draft comment to the assignee or a proposal to move. The
  move goes through `move-task` with the mode of the project's rule — Review → Done stays
  `confirm`; a batch is one confirmation. No autonomous transitions; a rule of mode `person` or a `person_only` policy refuses the move as it refuses anyone.
- **`thread-of-task`**, a scenario of `messaging`: search the key, read the thread. Read only; no
  inbox polling; posting stays confirm-only.
- **Phase 2 amends what refuses today:** `task-tracking` refused a move whose result is not clear
  and `move-task` disclaimed checking the result; both now point to `review-result` (A4, written).
  Reading attachments uses each connector's `attachment` command; F12 only adds uploads.
- **A task with no "Done when"** (older tasks) is reviewed against the description; the verdict
  says so.

### Outside systems (phase 3)

Depends on the mounts design (a folder of an outside project mounted into an installation as a
source of skills and wiki, never of rules — a handoff exists, the core backlog has no line yet).
Review of a pull request: oikos finds it by key (`code-hosting`), runs the mount's review skill
on the reference, takes the report into the topic folder, compares it with "Done when", drafts
the comment and the proposal. Read and review skills run from the installation's root; anything
that writes into the mounted project runs in a session opened there, because its own guards
fire only in its own sessions.

## Decisions given

Owner, chat:

- **Form:** a thin agent — charter, skill list, owned folder, session procedure — not a runtime.
- **akmon:** the format is defined in oikos now; the generalisation to a standard goes to akmon
  after two or three agents exist; meanwhile a prompt asks akmon to define how agents are
  developed and delivered, as it does for skills (Appendix).
- **Layout:** `.local/desk/<date>/<topic>/`, with an index; **retention** 30 days → summary,
  90 days → one line, no deletion by the agent.
- **Phases** (accepted by recommendation): v1 capture, digest, drafts, creation; phase 2 review and read-by-key; phase 3 outside
  review. Status moves stay `confirm`. The outside project folder of the first installation and the
  mount of the mounts handoff are the same folder; the core calls it a *mount*, never by name.

**Not decided, drafted by the assistant:** `agents:` as the switch-on key and the skill-pointer
delivery; the five checks; `card.md` ≤ 10 lines; the unit statuses; `_superseded/`; `owns:`; the
`desk:` config part; the tool's command names; the retention's activity rule. The owner sees the
delta here before accepting the ADR blocks.

## Open points

- **O1.** Names: akmon's roster already calls the root `agents/` roster `desk` and its ROADMAP uses
  `desk/` for the OPERATE folder, so the name collides. Decided by the owner: this agent keeps `desk`; akmon renames its internal term (A7 prompt, item 6).
  Also the roster runs only in akmon-attached sessions (the core's), not in an installation, whose
  session-start hook has no roster: listing enabled agents there is part of A1. Pointer names: an agent's pointer shares the folder with skill pointers; the collision
  check is cheap, the naming convention (`desk` vs `agent-desk`) is not decided.
- **O2.** A standing session on Qwen: the pointer works on both hosts; the behaviour of a long
  Qwen session under `context-pressure` is unchecked.
- **O3 — decided by the owner: separate.** `desk` is its own tool and its own index;
  it is not a project task, so its state is not carried by `handoff park`, and moving the whole
  desk is copying `.local/desk/`. `handoff list` will show `desk` as a folder of `.local/`; A3 makes
  it skip it. The context-pressure advice gets a desk line (A8).
- **O4.** Where the agent's own experience goes (what it learned about this owner's habits): the
  installation's `AGENTS.md`, that file says where (OIKOS.md § Session start leaves personal memory to it).
- **O5.** Whether warm summaries of company-relevant topics belong in a knowledge base mount
  instead of `.local/` — only after mounts exist.

## Implementation steps

See `_aitna/TASKS.md` A1–A7. Order: A1 and A2 together (an agent with no skill is empty), A3
after them, A6 any time, A4 after A2, A5 after the mounts task, A7 as soon as the owner runs the
prompt below in an akmon session.

## Appendix — prompt for an akmon session

Run in a session opened in the akmon repository. Replace `<oikos>` with the location of this
repository.

> 🧭 Act as the architect. Read `MODEL.md`, `ARCHETYPES.md`, `roles/README.md`,
> `docs/adr/0017-skill-discovery-and-delivery.md`, the session-start hook's roster code
> (`hooks/hook_core.py`, `agent_names`; `hooks/hook_core.json`, `operate_line`), `js/bin/verify.mjs`
> `checkAgentCharters` (the `charters.*` checks), MODEL.md § inheritance contract,
> `meta/CONCEPT.md` § Scope and `meta/ROADMAP.md` (OPERATE). Then read
> `<oikos>/docs/design/desk.md` and `<oikos>/docs/adr/0006-desk-agent.md` — the first case.
>
> **Goal.** akmon gives projects a model for *skills* and their delivery. Projects now also need
> *standing agents* — an agent that lives in a long-open session with its own state (a folder it
> owns, an index, retention), uses a set of skills, and is switched on per installation. akmon's
> "agent" today is only the development charter of a role. Draft how akmon should let a project
> **develop such agents and deliver them**, as it does for skills. In oikos, ADR 0006 is accepted
> and states that akmon is the source of the rules for developing and delivering agents and
> skills; oikos's own charter format (design § The agent) is interim until akmon has a standard.
>
> **Deliver, as decision requests with stable D-AGENT-* codes, owner decides (D5):**
> 1. **Concepts.** akmon already has an OPERATE roster (it sees only `<project-root>/agents/`) and
>    checks development charters; the question is a contract for the OPERATE side that does not
>    clash with `charters.*`. The relation between role, development charter, standing agent, skill and
>    worker (`k_*` delegates); names that do not collide with each other or with a host's own
>    "agent" (Claude Code subagents). Which of them akmon owns.
> 2. **How agents are authored** (a shared skill like `release` or `stats-digest` is one possible form): when something
>    should be an agent and not a skill; the charter's shape (frontmatter, mission, skills,
>    owned state, never-list, session start and close, workers); retention of owned state; how the
>    charter refers to skills instead of copying their rules; the guardrails an agent cannot
>    widen; its tests and checks; its review through review-flow.
> 3. **Delivery** across hosts (Claude Code, Qwen Code, Codex): reuse skill pointers or not; the
>    roster line of the session-start hook (validation of charters, a name for the OPERATE side
>    that matches the standard); a check in `akmon verify` for charters; how a project declares
>    which agents are on.
> 4. **Fit with the archetypes.** `platform` excludes a runtime that hosts OPERATE actors; this is
>    the thin case — a charter, no runtime. Say whether it needs its own archetype statement.
> 5. **Learn loop.** Whether a repeated procedure in a long session is promoted to an agent by
>    the same route as a skill, and what memory-distill must say about retiring and compacting
>    old notes (it is silent on both now).
> 6. **Rename the internal OPERATE term.** The roster code calls the root `agents/` list `desk` and
>    the ROADMAP uses `desk/` for the OPERATE folder, while the user-facing line says OPERATE. The
>    owner has decided to rename it in akmon; the oikos agent keeps the name `desk`. Propose the
>    new name (`operate` is the owner's first thought; offer alternatives), the impact (code in both
>    hook twins, docs, ADRs, generated files) and a migration that leaves every attached project's
>    generated files consistent; the owner confirms the name.
>
> **Constraints.** Items 2 and 3 are open questions: presuppose neither a shared skill nor a
> rename (item 6 is the one place a rename is asked about). Drafts stay *proposed* until two or
> three agents exist. Propose is not execute: akmon's ROADMAP draws that line for OPERATE; the
> oikos agent meets it through confirmation gates. Do not generalise from the one case: separate what the oikos desk agent shows
> to be general from what is specific to it, and mark the rest "needs a second case". Draft an
> ADR block and the pipeline or skill changes; do not edit anything accepted, do not commit, do
> not move a pin. No organization, person, host or project names in what you write. Artifacts in
> English; answer me in the language I write in.
