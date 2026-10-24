# `.local/` stores and working space

Accepted commitments: [ADR 0002](../adr/0002-local-stores.md). This note keeps the context,
the alternatives and the open points.

## Context

The secret guard (`tools/hooks/host.mjs`, `tools/hooks/secret-guard.mjs`) closed every folder
under `.local/` except `resources/`. The rule came from an incident: `cat
.local/browser/Default/Cookies` passed (DEVELOPMENT.md, experience entry on the guard). Closing
every folder fixed it, but it also closed personal working folders: an installation's `.local/cv/`
(a CV task's notes and drafts) could not be read. The open entry, `resources/`, was not created
or read by anything — the organization's `resources/` sits at the installation's root.

Inventory of what lives under `.local/` (before D02):

| Entry | Created by | Kind |
|---|---|---|
| `.env` | `setup init`, `setup token` | tokens |
| `browser/` | `tools/browser/cli.mjs` | store: Chrome profiles, `launch.json` |
| `google/` | `tools/google/auth.mjs` | credentials: OAuth client, token |
| `AGENTS.md`, `catalog.yaml`, `sync.json`, `TASKS.md` | setup, catalog, sync, the user | working data |
| `extension/` (F8, planned) | `sync` | generated build |

## Options considered

- **A — a list of closed stores at their old places** (`browser`, `google`, `.env*`); the rest
  open. No migration. Rejected: each new store must be added to the guard's list or it is open;
  the rule is not visible in the tree. *Revisit if* a migration turns out impossible.
- **B — one secrets folder, everything moves at once.** Rejected: a forced move breaks a running
  installation (the browser profile in use). Its layout is kept in D02.
- **C — a closed-name rule, legacy names kept closed, lazy migration.** Chosen, with the owner's
  refinement: the rule is "a dot name under `.local/` is closed", and the browser store gets its
  own `.browser/` apart from `.secrets/`.
- **Status quo — folders closed, an allowlist of open ones.** Rejected: every personal folder
  would need a core change; `.local/` exists to keep drafts out of the repository.
- **A separate `.private/` at the installation's root.** Rejected: two git-ignored zones with
  different meaning; `.local/` already is the machine's and person's zone.

## Points for the implementation

- The check is by name, no `statSync`: the first segment under `.local/` starts with `.`, or is
  `browser`/`google` (legacy).
- `isGoogleSecret` and `isInsideLocal` merge into one predicate over a path; the whole-`.local`
  scope check (`isLocalFolder`, `globNamesSecret` for a glob naming `.local` itself or `.local/**`)
  stays; a glob such as `.local/cv/**` passes.
- Migration in `sync`: move when the old place exists and the new does not; for the browser,
  only when this installation's Chrome is not running (the same check `browser status` uses).
- Paths: `tools/browser/cli.mjs`, `tools/google/auth.mjs`, the MCP launcher that reads the
  profile, `setup` (the `.gitignore` comment), and the docs naming `.local/browser` or
  `.local/google` (OIKOS.md, BOOTSTRAP.md, DEVELOPMENT.md, skills/browser, the Google connector
  files, examples/installation, `_aitna/TASKS.md` Target).
- `skills/documents/SKILL.md` stops forbidding working files in `.local/`.
- Tests for the guard's decisions: dot entry closed for read, grep, edit and shell; open folder and
  file pass; legacy names closed; whole-`.local` scope closed; `--include` globs.
