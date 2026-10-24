# Design — parking a work package for another session

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
is accepted until the owner says so; accepted commitments then move to ADR blocks and the
implementation steps to [`_aitna/TASKS.md`](../../_aitna/TASKS.md).

**State:** accepted by the owner (2026-10-22); commitments in
[ADR 0005](../adr/0005-work-package.md), implementation in `_aitna/TASKS.md` (F18). O1–O4 are
decided (owner, 2026-10-22). The hook's advice and OIKOS.md § Context economy (ADR 0005 D04, D05)
were implemented ahead of the ADR (item 9, owner-approved). Depends on OIKOS.md agreeing with
[ADR 0002](../adr/0002-local-stores.md) (open `.local/` folders hold working material and drafts),
which is being reconciled separately. **How to resume:** read § Frame, § Design, then § Open points.

## Frame

- **Problem.** The session scratchpad is session-local: when the context fills up or the session
  ends, its files are gone for the next agent. Work had to be carried by hand — files copied to
  `.local/<task>/`, a `HANDOFF.md` written from memory, a line added to `.local/TASKS.md`, a resume
  prompt composed — each step easy to miss when the context is already near its limit.
- **Goal.** One command parks a task's working files where the next session finds them, leaves a
  hand-off skeleton the agent fills, records the task in the personal backlog and prints the one
  line that resumes it.
- **Constraints already decided.** `.local/` names that do not start with `.` are open working
  space; dot names are closed stores (ADR 0002 D01). Writes to live services need a confirmed dry
  run (write guard); every runCli command that takes `--dry-run` must be in
  `tools/hooks/writes.mjs` (the sync check).
- **Acceptance.** After `park`, a fresh session given only the printed prompt reads
  `.local/proj-123/HANDOFF.md`, finds every file it names, and continues from "Next steps".

## Survey — the current code and docs

- OIKOS.md § What lives where and § Documents (as reconciled): drafts the user keeps working on may
  live in a working folder in `.local/` (a name not starting with `.`); throwaway files go to the
  scratchpad.
- `tools/hooks/context-pressure.mjs` — warns once at 85% and at 95%; the advice (item 9) starts
  with parking the work package by hand (`.local/<task>/` + `HANDOFF.md` + its backlog line, OIKOS.md
  § Context economy), then /compact or a fresh session. It names no command yet.
- `tools/hooks/host.mjs` — `isStoreName`: a first name under `.local/` that starts with `.` or is a
  legacy store (`browser`, `google`, any case) is closed; `isLocalStore`, `isEnvFile` judge a path.
  `jira attach` (`localFile` in `tools/jira/cli.mjs`) limits a local file to the installation (or
  the markdown file's folder), outside closed stores and `.env*`, refusing `~` and network paths.
- `tools/hooks/writes.mjs` + `tools/sync/cli.mjs` (write-guard list check) — any runCli command whose
  `--help` shows `--dry-run` must be listed, and a listed command needs a confirmed dry run.
  `write-guard.mjs` describes its scope as tools that change a remote service.
- Precedents for local writes: `catalog add` writes `.local/catalog.yaml`, previews unless `--yes`,
  and is not guarded; `jira project-init` and `repos` write only `oikos.yaml` and are guarded
  (ADR 0001 D07), because they change the rules that govern remote writes.
- `.local/TASKS.md` has no format defined by the core; the user's own lines may follow any form.
- Name check: no `park`, `handoff` or `work-package` in `tools/` or `skills/`.

## Design

### Layout

```
.local/
  TASKS.md                       # one line per parked task, upserted by key
  proj-123/                      # the task key, lowercase; or a slug for work with no key
    HANDOFF.md                   # the hand-off: written as a skeleton, filled by the agent
    draft-review.md              # the copied working files, names kept
    notes/…
```

- The folder is the task key lowercased (`PROJ-123` → `proj-123`); work with no tracker task takes
  `--name <slug>` (`[a-z0-9][a-z0-9-]*`). The folder is never a closed or legacy store name
  (ADR 0002 D01, `isStoreName`): a name starting with `.` cannot pass the pattern, and `browser`
  or `google` (any case) is refused — the folder would be closed to the next session's file
  tools. The check calls `isStoreName`, so a store added to `LOCAL_STORES` later is refused too.
- The `.local/TASKS.md` line: `- PROJ-123 · <title> · parked · [handoff](proj-123/HANDOFF.md)`. A
  line that starts with `- PROJ-123 ` is replaced; otherwise the line is appended; other lines are
  never touched (O3).

### `HANDOFF.md` template

```markdown
# PROJ-123 — <title>

## Where things are
<the files in this folder, one line each: what it is; outside it: vault notes, branches,
pull requests, tracker comments, drafts — by link>

## Agreed rules
<what the user asked for and ruled out: language, tone, scope, what not to touch>

## Decisions
<each decision made, with why, and what was rejected>

## Next steps
1. <the next concrete action>

## How to start
<what to read first, what to check live before acting (statuses, open PRs), the resume prompt>
```

The tool writes the headings, the file list under "Where things are" (copied names and sizes) and
the resume prompt; the agent fills the rest before the session ends. An existing `HANDOFF.md` is
kept: the tool prints the newly copied files for the agent to add.

### The tool — `node oikos/tools/handoff/cli.mjs park`

```bash
node oikos/tools/handoff/cli.mjs park --task PROJ-123 --title "Review of the API draft" \
  --from /tmp/<scratchpad>/draft-review.md --from /tmp/<scratchpad>/notes
node oikos/tools/handoff/cli.mjs list          # parked packages: TASKS.md lines and folders
```

- Copies each `--from` (a file or a folder) into the task's folder, names kept; a name that already
  exists with other content is refused unless `--replace` (never a silent overwrite of a filled
  file).
- What `--from` may name is limited as `attach` limits its files, by the secret guard's rules: the
  real path (symlinks followed; each file of a folder judged) lies inside the installation or the
  session scratchpad; a home or network path (`~/.ssh`, `~/.aws`, `~/.config`, `\\host`), a closed
  store of `.local/`, an `.env*` file, or a dot-named entry outside an open `.local/` folder is
  refused. One refused entry refuses the park before anything is copied. The secret guard sees
  only the command's tokens, not what a folder holds, so the tool checks itself: a copy into
  `.local/` must not carry what the agent may not read.
- Writes the `HANDOFF.md` skeleton when there is none, upserts the `TASKS.md` line, and prints
  `Resume PROJ-123: read .local/proj-123/HANDOFF.md and continue from "Next steps".`
- Without `--yes` it prints what it would copy and write and changes nothing (O2).

### The context-pressure hook

Implemented ahead of the ADR (item 9, owner-approved): at 85% the advice starts with parking the
package by hand (`.local/<task>/` + `HANDOFF.md` + its backlog line, OIKOS.md § Context economy),
then /compact or a fresh session; at 95% the same, marked critical. Once `park` exists, the advice
names its command (`node oikos/tools/handoff/cli.mjs park --task KEY --from …`).

### OIKOS.md guidance (context economy)

Implemented ahead of the ADR (item 9, owner-approved): a subagent writes its findings to a file
and returns a short summary with the path; a large file is read in parts (search first, then a
range), not whole; long work parks its package by hand before the context runs out. The section is
self-contained: OIKOS.md is the usage doc installations import, so it does not point at the core's
design docs or proposed ADRs.

## Options considered

- **A — OIKOS.md convention only.** The agent copies by hand. Rejected as the only answer: the
  steps are mechanical and the moment is the worst for remembering them. Kept as the fallback the
  convention describes.
- **B — a small tool plus the convention in OIKOS.md, no skill.** Recommended: the trigger is the
  hook's message and the user's "park this"; OIKOS.md is always loaded, a skill loads only on its
  trigger words.
- **C — a tool plus a skill (`handoff`).** Viable; costs one more trigger in every listing for a
  step the hook already names. *Revisit-if* resuming grows its own flow (several packages, merging).
- **D — a command of an existing tool (`catalog`).** Rejected: the catalog maps counterparties'
  folders; a work package is not one.

## Open points

| # | Point | State |
|---|---|---|
| O1 | Tool form | decided (owner, 2026-10-22) — B: `tools/handoff/cli.mjs` (`park`, `list`) + OIKOS.md section, no skill |
| O2 | Is `park` a guarded write? | decided (owner, 2026-10-22) — not: it writes only local files, not an external service; preview by default, `--yes` writes (the `catalog add` precedent), so it takes no `--dry-run` and is not listed in `writes.mjs`. It writes only open, git-ignored `.local/` files on this machine and changes no rule that governs a remote write. The alternative — `--dry-run` and a `writes.mjs` entry — makes the user answer a prompt before each park, exactly when the context is short |
| O3 | The `.local/TASKS.md` line format | decided (owner, 2026-10-22) — the line above (akmon's index shape with the task key as id), upserted by key only |
| O4 | Work with no tracker key | decided (owner, 2026-10-22) — `--name <slug>` instead of `--task` |
| O5 | Resume from a package | decided by convention: the printed prompt; no `resume` command until a need shows |

## Rejected (candidates)

- **Keeping packages in the vault** — a vault is for knowledge and final documents (OIKOS.md);
  drafts the user keeps working on belong in `.local/`. Revisit-if: an installation has no `.local/`
  use at all.
- **Moving instead of copying from the scratchpad** — the current session may still need its files.
  Revisit-if: never.
- **The tool filling `HANDOFF.md` from the transcript** — the content is judgment (rules, decisions);
  the agent writes it. Revisit-if: never.

## Points for the implementation

- `tools/handoff/cli.mjs` on runCli; no connector; the installation from `installRoot()`.
- Copy with `cpSync` (recursive) after judging every source entry (the `--from` rule above, by the
  shared `isEnvFile` / `isLocalStore` and attach's path checks — moved to a common module, not
  copied); refuse a folder name that `isStoreName` closes or that is path-like; upsert one line;
  print the resume prompt.
- `context-pressure.mjs`: name the `park` command in the advice once it exists.
- OIKOS.md: the template's headings, the command beside the manual convention.
- Tests: key → folder, slug, refusal of dot and legacy store names (`browser`, `Google`), refusal of
  `~/.ssh`, a path outside the installation and scratchpad, an `.env*` inside a copied folder, a
  closed store, conflict without `--replace`, the line upsert
  (replace, append, create), an existing `HANDOFF.md` kept, preview changes nothing.
