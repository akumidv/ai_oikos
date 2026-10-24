# ADR 0002 — `.local/`: dot-named stores are closed, the rest is working space

Accepted commitments only. Alternatives and the rejected register:
[docs/design/local-stores.md](../design/local-stores.md). Implementation state:
[`_aitna/TASKS.md`](../../_aitna/TASKS.md) (L1).

## D01 — A dot-named entry under `.local/` is closed; everything else is open
<a id="dec-0002-d01"></a>`Decision-ID: DEC-0002/D01`

- **Choice.** The secret guard decides by the first name under an installation's `.local/`: a
  name that starts with `.` (`.env`, `.secrets/`, `.browser/`, any later one) is closed to every
  file tool and every shell argument; any other name — a file or a folder (`catalog.yaml`,
  `TASKS.md`, `cv/`, `extension/`) — is open for reading and writing. A scope that covers
  `.local/` as a whole (`.local`, `.local/`, `.local/**`, a glob naming `.local` without a
  folder below it) stays closed, since it reaches the closed entries. `ls`/`stat` stay open.
  A `.env*` file stays closed at any depth, as now.
- **Rationale.** `.local/` is git-ignored so that personal and draft material — the backlog,
  notes, a CV under work — stays out of the repository; that purpose needs the folder open.
  Secrets and stores are few, each created by a known tool, and the dot marks them in the tree
  itself: a new store is closed by its name, with no list in the guard to keep in step.
- **Consequences.** The `OPEN_LOCAL_FOLDERS` allowlist (`resources`) goes; nothing used it.
  The closed check no longer depends on whether a folder exists. A glob whose first name under
  `.local/` holds a wildcard (`.local/*.md`, `.local/{cv,notes}/**`) is closed, since it may
  match a dot name: a search names the folder (`.local/cv/**`). A path is judged as written, with
  `.`/`..` resolved, and against every folder a `cd`/`pushd` earlier in the same shell command
  may have entered, so `cd .local/cv && grep -r x ..` reaches `.local` itself and is closed.
- **Reconsider if** a tool must keep a secret whose location it cannot choose.

## D02 — Layout: `.env`, `.secrets/`, `.browser/`
<a id="dec-0002-d02"></a>`Decision-ID: DEC-0002/D02`

- **Choice.** Tokens stay in `.local/.env`. Credentials files go under `.local/.secrets/` (the
  Google OAuth client and token: `.local/.secrets/google/`). The shared browser's state — Chrome
  profiles and `launch.json` — goes to `.local/.browser/`. A new secret or store a tool keeps is
  placed under a dot name; DEVELOPMENT.md says so.
- **Rationale.** The browser profile is a store (cookies, sessions, cache), not a credential
  file: it is large, written by Chrome, and kept apart from `.secrets/`.

## D03 — Old names stay closed; migration is lazy
<a id="dec-0002-d03"></a>`Decision-ID: DEC-0002/D03`

- **Choice.** `.local/browser/` and `.local/google/` stay closed by name as legacy. `oikos sync`
  (and `setup init`) moves them to `.local/.browser/` and `.local/.secrets/google/` when the new
  place does not exist yet; the browser profile is moved only while this installation's Chrome is
  stopped, otherwise sync says so and leaves it. The tools read the new place first and fall back
  to the old one until it is moved.
- **Rationale.** A working installation is not broken by an update, and an unmoved store is never
  open in between.
- **Consequences.** `sync --check` reports a pending move as out of date (exit 1) and stays red
  until the store is moved. A move that fails (a held file, another filesystem) is a sync problem:
  the store stays where it is and is still used there, the rest of sync runs, exit 1. Chrome
  counts as running when the check cannot tell, so the profile is not moved then.
- **Reconsider if** no installation has the old names left — then the legacy names go.

## D04 — The closed check covers every file tool
<a id="dec-0002-d04"></a>`Decision-ID: DEC-0002/D04`

- **Choice.** The closed-entry check applies to reading, searching and editing tools alike, not
  only to reading ones.
- **Rationale.** Before, Edit/Write into `.local/browser/` passed the guard; a store is not
  edited through the chat either.
