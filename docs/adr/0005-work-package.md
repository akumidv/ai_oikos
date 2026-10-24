# ADR 0005 — Parking a work package for another session

Accepted commitments only. Design, alternatives and open points:
[docs/design/work-package.md](../design/work-package.md). Implementation state:
[`_aitna/TASKS.md`](../../_aitna/TASKS.md) (F18). Accepted by the owner, 2026-10-22, with the
design's open points O1–O4 decided as D01–D03 record. Builds on
[ADR 0002](0002-local-stores.md) D01 (open `.local/` names are working space).

## D01 — A work package is `.local/<task-key-lowercase>/` with a `HANDOFF.md`
<a id="dec-0005-d01"></a>`Decision-ID: DEC-0005/D01`

- **Choice.** A task's working files outlive the session in `.local/<key>/` (`PROJ-123` →
  `proj-123`; a slug for work with no key). The folder name is never a closed or legacy store name
  of `.local/` (ADR 0002 D01; the secret guard's `isStoreName` in `tools/hooks/host.mjs`): no name
  starting with `.`, and none of the legacy stores (`browser`, `google`, in any case). `park`
  refuses such a slug; a task key cannot produce one. Its `HANDOFF.md` has
  five headings: Where things are, Agreed rules, Decisions, Next steps, How to start. The task has
  one line in `.local/TASKS.md`: `- PROJ-123 · <title> · parked · [handoff](proj-123/HANDOFF.md)`.
- **Rationale.** The scratchpad is session-local; a fixed place and a fixed shape let a cold
  session resume from one prompt.

## D02 — `handoff park` copies, writes the skeleton, records the line, prints the prompt
<a id="dec-0005-d02"></a>`Decision-ID: DEC-0005/D02`

- **Choice.** `node oikos/tools/handoff/cli.mjs park --task KEY | --name SLUG [--title T]
  --from PATH…` copies each file or folder (names kept; a differing existing file refused unless
  `--replace`), writes the `HANDOFF.md` skeleton
  when there is none (headings, the copied files, the resume prompt), upserts the `TASKS.md` line by
  key and prints the resume prompt. `list` shows the parked packages. The agent fills the rest of
  `HANDOFF.md`. No skill: the convention is in OIKOS.md.
- **What `--from` may name** — limited as `attach` limits its files, by the same rules (the secret
  guard's `isEnvFile` / `isLocalStore` and `jira attach`'s `localFile` checks, shared, not copied):
  a real path (symlinks followed, every file of a folder judged) inside the installation or the
  session scratchpad only; never a home or network path (`~/.ssh`, `~/.aws`, `~/.config`, `\\host`),
  a closed store of `.local/`, an `.env*` file, or a dot-named entry outside an open `.local/`
  folder. One refused entry refuses the whole park, before anything is copied.
- **Rationale.** The steps are mechanical and come when the context is shortest; the content is
  judgment and stays the agent's. A copy into `.local/` must not become a way round the secret
  guard: what the agent may not read, `park` may not carry.

## D03 — `park` is a local write, previewed, not guarded
<a id="dec-0005-d03"></a>`Decision-ID: DEC-0005/D03`

- **Choice.** `park` writes only local files and is not an external write (owner, 2026-10-22).
  Without `--yes` it prints what it would copy and write and changes nothing; with `--yes` it
  writes. It takes no `--dry-run` and is not listed in `tools/hooks/writes.mjs`.
- **Rationale.** `tools/hooks/writes.mjs` lists the verbs that write to an external service; local
  writers like `catalog add` are not listed (`project-init` and `repos` are, as the writers of the
  rules that govern those writes, ADR 0001 D07). `park` writes only open, git-ignored files on this
  machine, as `catalog add` does. A guarded `park` would cost the user a prompt exactly when the
  context is short.
- **Reconsider if** `park` ever writes outside `.local/` or to a shared place.

## D04 — The context-pressure hook suggests parking first
<a id="dec-0005-d04"></a>`Decision-ID: DEC-0005/D04`

- **Choice.** Implemented ahead of the ADR (item 9, owner-approved). The 85% and 95% warnings of `tools/hooks/context-pressure.mjs` start with "park the
  work package (`.local/<task>/` + `HANDOFF.md` + its backlog line, see OIKOS.md § Context
  economy)", then /compact or a fresh session. Once `park` (D02) exists, the advice names its
  command.
- **Rationale.** The warning is the moment the package must be saved; naming the step makes it
  hard to miss.

## D05 — OIKOS.md: context economy
<a id="dec-0005-d05"></a>`Decision-ID: DEC-0005/D05`

- **Choice.** Implemented ahead of the ADR (item 9, owner-approved). OIKOS.md § Context economy: a subagent writes its findings to a file and returns
  a short summary with the path; a large file is read in parts (search first, then a range); long
  work parks its package before the context runs out.
- **Rationale.** Less of the context goes to raw material, so parking is needed less often and
  succeeds when it is.
