---
name: notes
description: Keep the user's notes from chats, calls and discussions as said, show how they split into tasks, comments and messages, and — after the user agrees the split and each text — create the tasks and drafts through task-tracking and messaging. Triggers on "take these notes", "remember this", "here is a list from the discussion — make tasks", "what do we have so far", "sum up the notes", "turn this into tasks", "what is on the desk", "compact the old notes", or a pasted block of chat, call notes or bullet ideas the user wants kept or acted on.
when_to_use: When free text arrives that is to be kept, grouped and later turned into tracker tasks or messages — one pasted line or a day of them; used by the `desk` agent and usable in any session without it.
metadata:
  owner: oikos
  group: ongoing
surface: .local/desk/ — notes, a plan of units, drafts and cards per topic; .local/private.yaml — the people file (names, aliases, accounts), read and extended through tools/people; through task-tracking and messaging, tasks and messages, only after the user's yes
refuses: creating a task, sending a message or moving a status without its own confirmation; drafting any text before the user has agreed the table of units; overwriting a note; a link or a key that no tool result or the user gave; guessing a person's account (it comes from the people file or the connector's own search); storing a secret in the people file; deleting anything (old material moves to the archive, the user removes it)
---

# notes

Notes are what the user says or pastes — a list from a discussion, a chat thread, an idea — kept
**as said**, grouped when the user asks, and turned into tasks and messages only when the user has
agreed what they are. The skill owns the know-how; the standing procedure around it (what to read
at the start of a day, how a topic is closed) is the [desk](../../agents/desk/README.md) agent's.

Everything lives under `.local/desk/` (open, git-ignored, never committed): one folder per topic,
`<date>/<topic>/`, made by the `desk` tool. No connector — the skill reaches a tracker or a
messenger only through [task-tracking](../task-tracking/SKILL.md) and [messaging](../messaging/SKILL.md),
with their gates.

```bash
node oikos/tools/desk/cli.mjs new api-review --title "API review follow-ups"   # a topic: today's folder, notes.md, plan.md
node oikos/tools/desk/cli.mjs list                                              # topics: status, age, keys
node oikos/tools/desk/cli.mjs find PROJ-123 [--archive]                         # a key or words, across the topics
node oikos/tools/desk/cli.mjs index                                             # rebuild INDEX.md after a topic changes
node oikos/tools/desk/cli.mjs compact [--yes]                                   # old topics: a plan, then applied
node oikos/tools/desk/cli.mjs reopen api-review [--yes]                         # a compacted topic back
node oikos/tools/people/cli.mjs find ada [--account jira]                       # who a name in a note is, and the id a tracker takes
node oikos/tools/people/cli.mjs find --by-account github=ada-l                  # whose account a login or an id in a result is
node oikos/tools/people/cli.mjs add "Ada Lovelace" --alias ada --account jira=<id> [--yes]   # a person into the people file
```

## Scenarios

| Scenario | When | Read |
|---|---|---|
| `capture` | free text arrives | [scenarios/capture.md](scenarios/capture.md) |
| `digest` | the user asks for the summary, or for "what do we have" | [scenarios/digest.md](scenarios/digest.md) |
| `draft-and-create` | the table of units is agreed | [scenarios/draft-and-create.md](scenarios/draft-and-create.md) |
| `compact` | a topic is older than the retention threshold, or on request | [scenarios/compact.md](scenarios/compact.md) |

## Rules for every scenario

- **Verbatim first.** A note is kept as said, with the time; the cleaned text sits beside it, a
  guess marked `(?)`. A file that exists is **never overwritten** — notes are appended, a new
  draft is a new file (`draft-<n>.md`).
- **A unit is what one task, comment or message will be.** The table of units comes before any
  text, and **no text is drafted until the user has agreed the table**. A split corrected after
  the texts exist costs every text; corrected in the table, it costs a line.
- **A link, a key or a person comes from a tool result or from the user**, else it carries `(?)`.
  A project key or a person the user typed is looked up before it is used (the connector's
  `search` or `user` command); a near miss is asked about, not fixed silently.
- **Resolving a person.** A person named by an alias is looked up in this order: (1) the people
  file `.local/private.yaml` — `node oikos/tools/people/cli.mjs find <alias>`, and `--account jira`
  (or the tracker the unit goes to) for the id the connector takes — the key and the value are in
  the connector's file, § People key; `find --by-account <key>=<value>` goes the other way, from a
  login or an id seen in a result to the person; (2) not found — the
  connector's own search (a Jira account search, the messenger's user search); (3) found there —
  offer `people add …` (a preview; `--yes` only after the user's yes, like every write). Several
  matches in the file are asked about, never picked. The file holds personal data on purpose and is
  git-ignored; it never holds a secret (those live in `.local/.env`).
- **Tracker texts are English** (task-tracking's rule) in the shape **Goal / What to do / Done when**.
  "Done when" is required: it is what a later review checks the result against. A task for which
  the user gives no checkable end gets a question, not an invented one.
- **A conditional follow-up** ("if gaps are found, file a task in project X") is a section of the
  task or of the message, not a skeleton kept aside.
- **Writes follow the gates that already exist**: dry run, shown, the user's yes, the same command
  ([OIKOS.md](../../OIKOS.md)); the content check of ADR 0003 runs in the dry run. Sending a
  message is a separate confirmation from creating the task it mentions. **A status move is
  proposed, never made by the skill**: it goes through `move-task` under the project's rule, and
  `confirm` is the most that skill may do.
- **Two stores of status — `plan.md` and the tracker.** When they disagree, the tracker wins: say so
  and correct `plan.md`.
- **Nothing is deleted.** Superseded drafts move to `_superseded/` in the topic, old topics to
  `_archive/` (by `compact`); the user removes what they no longer want.
- **Heavy steps are a worker's** where the host has workers: searches, tracker reads, drafting.
  A worker reads the paths and keys it is given, writes only into the topic's folder, returns a
  few lines. The output of a search must not land in the main context.

## The files of a topic

```
.local/desk/INDEX.md                  one line per topic — rebuilt by `desk index`, never edited by hand
.local/desk/2026-10-27/api-review/
  notes.md      append-only: time, the original, the cleaned text beside it
  plan.md       frontmatter (title, tags) and the table of units
  draft-1.md    the texts, one file each
  card.md       at most ten lines, written when the topic closes: outcome, keys, decisions, open items
  summary.md    written before compaction: outcome, keys with a one-line reason each, decisions, links
```

`plan.md`'s table has the columns `# · unit · kind · where · source · status · key`. A unit's
**kind** is task, comment, message, document or conditional task; **where** is the project and the
assignee, or the channel; **status** is `open`, `drafted`, `created`, `sent` or `dropped`; **key**
is the created task's key or the message's link, once it exists. The `desk` tool reads the
`status` and `key` columns; the rest is for the user and the agent.
