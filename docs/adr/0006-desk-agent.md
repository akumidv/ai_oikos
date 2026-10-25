# ADR 0006 — The desk agent: a thin standing agent over a notes skill

**Status: accepted by the owner**, with two additions of theirs: akmon is the source of
the rules for developing agents and skills (D05), and the configuration part is `desk:` (D03).
D06 (the people file) was decided by the owner in chat on 2026-10-27, after acceptance.
Before acceptance the `k_auditor` pass of akmon's design-flow
has run twice and its findings are folded in. Design, alternatives and open points: [docs/design/desk.md](../design/desk.md).
Implementation state: [`_aitna/TASKS.md`](../../_aitna/TASKS.md) (A1–A7). The owner chose the
form, the akmon relation and the retention in chat; this ADR records them as blocks to
accept. Builds on [ADR 0002](0002-local-stores.md) D01, [ADR 0003](0003-outward-content.md),
[ADR 0004](0004-tracker-policy.md) and [ADR 0005](0005-work-package.md).

## D01 — A standing agent is a thin charter: `agents/<name>/README.md`
<a id="dec-0006-d01"></a>`Decision-ID: DEC-0006/D01`

- **Choice.** An oikos agent is a folder `agents/<name>/README.md` in the core with frontmatter
  `name`, `description`, `skills`, `owns`, `metadata.owner` and sections Mission, Skills, Owns,
  Never, Session start, Closing a topic, Workers. It has no permissions of its own (the guards
  stay on tools; a charter may only narrow), no runtime, and copies no rule of a skill — it links
  them. An installation switches an agent on with `agents:` in `oikos.yaml`; `sync` writes one
  pointer per listed agent into the skill-pointer folders of both hosts. `npm run check` fails on
  invalid frontmatter, a listed skill that does not exist, an `owns` that is a closed or legacy
  store name, an unknown agent in `oikos.yaml`, a pointer-name collision (core-side checks run in the core, installation-side ones only in an installation). Delivery needs `sync` changed: it removes any marked pointer not in its skills list, and its template is skills-only (A1).
- **Rationale.** Skills carry capability; the agent carries responsibility and state. Reusing
  skill delivery gives both hosts a standing agent with no new host machinery, and the folder stays
  compatible with akmon's roster line (which runs only in akmon-attached sessions — the core's, not an installation's; listing enabled agents in the installation's session-start hook is part of A1).

## D02 — The capability is the skill `notes`; the unit table precedes any text
<a id="dec-0006-d02"></a>`Decision-ID: DEC-0006/D02`

- **Choice.** `skills/notes/` has scenarios `capture`, `digest`, `draft-and-create`, `compact`.
  Notes are kept verbatim and never overwritten; a digest shows the unit table (kind, where, source,
  open question) and **no text is drafted before the owner has agreed it**; a link in a draft comes
  from a tool result or the owner, else it is marked `(?)`; tracker texts have *Goal / What to do /
  Done when*, "Done when" required. Writes follow the existing gates (the agent narrows, never widens, what the installation's rules allow): dry run, text shown,
  yes, the same command; a message is sent only after its own confirmation; status moves are
  proposed and run only through `move-task` under the project's rule — `confirm` is the most the
  agent may do; a `person` mode or a `person_only` policy refuses the move — and are never made by
  the agent on its own.
- **Rationale.** The observed run was corrected twice on the split into units *after* the texts
  existed; the table first makes the correction cheap. The gates are ADR 0001/0003/0004 and are not
  reopened here.

## D03 — State lives on disk under `.local/desk/`, in three retention tiers
<a id="dec-0006-d03"></a>`Decision-ID: DEC-0006/D03`

- **Choice.** `.local/desk/<YYYY-MM-DD>/<topic>/` holds `notes.md`, `plan.md`, drafts and a
  `card.md` (≤ 10 lines; not a `HANDOFF.md` — the owner decided that a desk is not a project task: `handoff park` does not carry it, and moving the whole desk is copying `.local/desk/`); `.local/desk/INDEX.md` has one line
  per topic. Up to 30 days the folder is whole; over 30 days `card.md` and `summary.md` stay and
  raw notes and drafts move to `_archive/<YYYY-MM>/`; over 90 days one index line stays. Only a
  topic whose units are all `created`, `sent` or `dropped` is compacted. The agent deletes nothing.
  `node oikos/tools/desk/cli.mjs` has `list`, `find`, `compact` and `reopen` — a plan by default,
  applied with `--yes` — and the mechanics the agent needs, `new` (the topic's folder: the date, a
  unique slug) and `index` (rebuilds `INDEX.md`), which write at once; it writes only under `.local/desk/`. Thresholds: a `desk:` part of `oikos.yaml` (as `task-tracking:` is; `settings` holds flat env-style values; the owner chose the `desk:` part).
- **Rationale.** The context cannot be cleared by the agent; disk as memory and workers for heavy
  steps keep it small. An open idea must not compress to nothing, hence the compaction condition.

## D04 — Review of results and outside systems follow in phases, on the same gates
<a id="dec-0006-d04"></a>`Decision-ID: DEC-0006/D04`

- **Choice** (the phases were accepted by recommendation). Phase 2: `review-result` (`task-tracking`) judges a task's result — a document, a
  comment or code — against its "Done when" and yields a draft comment or a move proposal through
  `move-task`; `thread-of-task` (`messaging`) reads by key, read-only. Phase 3, after the mounts
  task: review of code through a mounted outside project's review skill, run from the
  installation's root; anything that writes into that project runs in a session opened there.
- **Rationale.** Review needs a checkable "Done when" (D02) and the mounts design; neither is in
  place yet.

## D05 — The format is defined here first; akmon is asked for the standard
<a id="dec-0006-d05"></a>`Decision-ID: DEC-0006/D05`

- **Choice.** oikos defines the charter now. A prompt (design appendix) asks an akmon session to
  draft how agents are developed and delivered, as skills are (D-AGENT-* requests to the owner).
  Generalisation into an akmon standard waits for two or three agents; until then the format is
  oikos's and marked so.
- **Source of rules.** The rules for developing and delivering agents and skills are akmon's.
  Where akmon defines them they bind oikos's `agents/` charters and `DEVELOPMENT.md` § Writing a
  skill; the format of D01 is oikos's interim one until akmon has a standard.
- **Rationale.** akmon has no agent-authoring model, its CONCEPT and ROADMAP put OPERATE as a whole out of scope (and already use the name `desk`) and excludes a runtime that hosts OPERATE
  actors; a standard drawn from one case is likely wrong, and the owner owns akmon.

## D06 — People: `.local/private.yaml`, looked up first, grown by what the tracker finds
<a id="dec-0006-d06"></a>`Decision-ID: DEC-0006/D06`

- **Choice** (owner, 2026-10-27). The desk — and any skill that meets a person named by an alias in a note
  or a chat — resolves the person through the installation's `.local/private.yaml`: (1) the file;
  (2) not found there → the connector's own search (the tracker's or messenger's user search);
  (3) found there → the person is **added** to the file, after the owner's yes like any write. The
  file is open (no leading dot, ADR 0002 D01), one per machine and person. Shape: `version: 1` and
  `people:` — each `name`, optional `aliases`, `email`, `accounts` (system → the id its connector
  takes: `jira`, `github`, `slack`, …) and `note`. The mechanics are `tools/people/cli.mjs`
  (`find`, `add` with a preview and `--yes`, `check`); no connector reads the file, the agent
  passes the found account to the connector's own option.
- **Keys are the connectors' business** (owner, 2026-10-27). Which key a system uses, and what its
  value is, is written in the connector's own file, in a `## People key` section; the file holds only
  the values. The keys: `jira` (Atlassian account id; Confluence reuses it), `github` (login; issues,
  code hosting and wiki), `gitlab` (username; the same), `slack` (member ID); Google uses the person's
  `email`. A connector that needs a person names its key there, so no key is guessed.
- **One system per kind.** An installation has one Jira, one Slack workspace and so on, so a key is
  the system's name with no instance part. Two instances of one system are not supported here; if an
  organization needs them, the key shape is revisited (reconsider below).
- **Reverse lookup.** `people find --by-account <system>=<value>` answers whose account it is (a login
  seen in a pull request, a member ID in a message); exit 1 when no one holds it.
- **Personal data is allowed in this file, deliberately.** Names, aliases, emails and accounts are
  its content, so the usual caution against personal data does not apply to it. Secrets still do not
  belong: `add` refuses a value the content check (ADR 0003 D02, `secret`) flags, and credentials stay in
  `.local/.env`.
- **Forced out of git.** `setup init` writes `.local/private.yaml` into the installation's
  `.gitignore` explicitly, and `sync` appends the line to an existing `.gitignore` that lacks it,
  so the file stays ignored even if `.local/` ever stops being ignored as a whole.
- **Rationale.** Aliases ("the backend lead", a first name) are local knowledge no tracker has; the
  tracker's search fails or is ambiguous on them (it refuses on zero or several matches). A file that
  grows from what searches found makes the second lookup free and the same for every connector.
- **Consequences.** The core still names no one: only the format is here. The file is not shared;
  another person on the same installation keeps their own. An alias claimed by two people is refused at
  `add` and reported by `check`.
- **Reconsider if** an installation reaches two instances of one system (then the key gains an
  instance part), or an organization needs one shared people list — then it is a resource of the
  installation (`resources/`), not this file.
