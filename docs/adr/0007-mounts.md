# ADR 0007 — Mounts: other repositories as sources, an installation that writes only into itself

**Status: draft.** The owner decided every point below in chat, including the points the
`k_auditor` pass raised; this text awaits the owner's acceptance after a security re-audit of D04
and D05. Design, alternatives, open points and the plan: [docs/design/mounts.md](../design/mounts.md).
Implementation state: [`_aitna/TASKS.md`](../../_aitna/TASKS.md) (A9, A11). Builds on
[ADR 0002](0002-local-stores.md) D01 (what lives in `.local/`) and refines
[ADR 0003](0003-outward-content.md) for vault notes (D04 below): they leave the unchecked routes of
its D05 for a checked tool route under its D01, and their override is narrower than its D03.
[ADR 0006](0006-desk-agent.md) D04 phase 3 (review through a mounted project's skill) waits on
this ADR.

## D01 — A mount is a repository used as a source, never of rules
<a id="dec-0007-d01"></a>`Decision-ID: DEC-0007/D01`

- **Choice.** A mount is a repository top (its own `.git` folder or file) that an installation uses
  as a source of skills, of notes or of material to read. In a Claude Code session its
  `CLAUDE.md`, its imports and its `.claude/rules/` never load in an installation session, and the
  installation's rules never load in a session opened in the mount; Qwen Code and Codex get what
  D03 says. A mount is not `oikos/`, not under `.local/` and not inside another mount; a
  repository nested deeper in a mount is covered by it. oikos never creates a mount: the user adds
  the submodule or the clone.
- **Two layers; the local one wins and only narrows.** Shared mounts are declared under `mounts:`
  in `oikos.yaml`, with relative paths and no `..`. Personal mounts are declared in
  `.local/mounts.yaml` with the same schema; a path there may be absolute and outside the
  installation. `config()` merges the layers by real path, and a local entry replaces the shared
  entry of the same path as a whole, except that it cannot widen it: it cannot add `wiki` to
  `use` or set `mention_assistant: allow` where the shared entry does not. Such an attempt is a
  problem and is dropped. A personal mount is named in no committed file unless the user opts in
  (D03 item 4).
- **What is taken.** `use: [wiki | skills]`; without `use` the mount is read only.
  `skills: {from, prefix, only, commit}` makes one pointer per skill, named `<prefix>-<name>`;
  `only` lists the skills that get a pointer, absent means all, so a mount's skill that duplicates
  one of oikos's own is kept out. `only` limits the pointers, not the host: a host may still list
  a mount's own skills when it lazy-loads that folder (design Q2). There is no `use: rules`; a
  wiki's `wiki.rules` is the note schema of that vault, data for the `vault` connector, not agent
  rules. A mount that is itself an installation (D05) takes no `use`; `sync --check` is red
  otherwise.
- **Mounts change only through `setup mount`.** The file tools may not edit `.local/mounts.yaml`
  or the `mounts:` part of `oikos.yaml`; `setup mount add|remove … --dry-run` does, after the user
  confirms, as every write. Otherwise an agent could drop a mount from the list and then write
  into it.
- **Rationale.** The agent hosts load every ancestor's `CLAUDE.md` and a subfolder's lazily, so a
  repository inside an installation leaks rules both ways unless it is declared and wired. A
  personal vault or development root is often outside the installation and must not be named in
  the organization's repository. A personal layer that could widen a shared entry would let a
  local file loosen what the team set.
- **Consequences.** Running a mount's own tools with its own credentials is outside this ADR (a
  later "external capabilities" task); a mount skill that needs them is taken only when the owner
  accepts that.
- **Reconsider if** a host gains a setting that stops the lazy loading of a subfolder's rules and
  skills; then items 1–2 of D03 may give way to it.

## D02 — An installation writes only into itself
<a id="dec-0007-d02"></a>`Decision-ID: DEC-0007/D02`

- **Choice.** An installation session reads the core, its mounts and its linked installations
  (D05), and changes none of them. `package-guard` denies `Edit`, `Write`, `NotebookEdit` and
  `MultiEdit` of a path inside any mount, with "open a session in `<mount>` to change it". The
  mounts it protects are those of the configuration together with those recorded in
  `.local/sync.json`: a mount dropped from the configuration stays protected until `sync` removes
  its wiring, and an unreadable configuration never opens the guard. In the shell, a redirection
  into a mount and a `git` write subcommand with `-C <mount>` or after a `cd` into it are denied,
  through one shared shell parser (`tools/hooks/shell.mjs`); a `git` subcommand not on a read
  allow-list counts as a write. `git-guard` takes the target repository the same way. Reads stay
  open. Two routes write into a mount, both from oikos's own tools: a note written by the `vault`
  connector (D04), and `sync`'s own wiring, which is git-ignored there (D03 items 2–3).
- **Rationale.** A mount has its own framework and guards (a branch per task, who commits), which
  run only in a session opened there. A per-mount write switch would make the installation's
  guards stand in for the mount's.
- **Consequences.** Committing a vault is the user's, in their git client or a session opened in
  the vault, so no agent commit inside a mount needs a leak scan. The shell coverage is the
  redirection and `git` only, with the known gaps of the shell guard (globs, `find -exec`, other
  writing programs); the file tools and the `vault` tool are the main routes, and the wider shell
  coverage stays open in the design (Q4).

## D03 — `sync` wires each mount and records what it wrote
<a id="dec-0007-d03"></a>`Decision-ID: DEC-0007/D03`

- **Choice.** `tools/sync/mounts.mjs` writes, per mount:
  1. for an inside mount, `claudeMdExcludes` in the installation's `.claude/settings.local.json`
     for the mount's `CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/**`;
  2. for an inside mount, `claudeMdExcludes` in `<mount>/.claude/settings.local.json` for the
     `CLAUDE.md` and `CLAUDE.local.md` of the installation root and every folder between it and
     the mount, keeping the mount's own keys;
  3. every file it writes inside a mount into the mount's git `info/exclude` (found with
     `git rev-parse --git-path`, so a submodule's is found too), unless git already ignores it;
  4. skill pointers per D01, with the marker oikos's own pointers carry, and the origin shown in
     `landscape`. A shared inside mount's pointer is committed and carries no absolute path. The
     pointer of an outside mount, and every pointer of a personal mount, goes into the
     installation's own git `info/exclude` and is never committed, unless the user sets
     `skills.commit: true` on a personal inside mount;
  5. for an outside mount, `permissions.additionalDirectories`.

  Absolute paths go only into git-ignored local files. Everything written is recorded in
  `.local/sync.json`, so a removed mount entry removes exactly its wiring and nothing the user
  wrote. `sync --check` is red on a missing mount or one that is not a repository top, on
  overlapping mounts, on two wikis with one name or two defaults, on a `skills.only` name that is
  not a skill, on a pointer name already taken, and on missing, stale or moved wiring (one that
  names another installation root).
- **Rationale.** `claudeMdExcludes` is the only setting the hosts offer against the rule leaks,
  and it takes absolute paths; the record is the pattern MCP entries already follow. A pointer of
  a personal mount in the installation's commits would name that mount in the organization's
  repository.
- **Consequences.** Qwen Code and Codex get items 3–5 and the guards, not 1–2, until their
  context loading is known. Moving an installation makes the wiring stale; `sync` rewrites it.

## D04 — The `vault` connector: notes into wiki mounts, with the content check
<a id="dec-0007-d04"></a>`Decision-ID: DEC-0007/D04`

- **Choice.** Any `use: wiki` mount makes the `vault` connector of the `wiki` skill available;
  `requireConnector` lets this derived connector through without a `connectors:` line. It is never
  the default wiki connector, so a knowledge question still goes to the knowledge base first, and
  a request that names a vault or a note selects it. Verbs: `search` (all wikis or
  `--wiki <name>`, the wiki named per hit), `read`, `create` (from `wiki.template`, frontmatter
  checked against `wiki.rules`, into `wiki.inbox`), `append`, `replace-section`; `--dry-run` as
  everywhere, the write verbs listed in `tools/hooks/writes.mjs`. Several wikis each have a
  `name`; `create` goes to the named one, else to the one with `default: true`, else asks.
- **Where it writes.** Only `.md` notes inside the mount's real path; never into `.git/`,
  `.claude/`, `.obsidian/`, a `CLAUDE.md`, `CLAUDE.local.md` or `AGENTS.md`, or a nested
  repository.
- **The check.** Every note, in a shared or a personal vault, goes through `outgoingFindings`
  with the categories `path`, `secret`, `term`, and `assistant` unless the mount sets
  `mention_assistant: allow`; `language` is off unless `wiki.rules` sets a language. The terms
  are the built-ins, the organization's terms in `.local/outgoing.yaml`, and the installation's
  derived terms: its absolute root, this machine's home path and the names of `.local/` files
  (a short or common name is not a term, to keep the noise down). A finding refuses the write
  with the places named. The one override is an `allow:` line of `.local/outgoing.yaml`; the
  `vault` tool takes no `--allow-flagged`.
- **The existing vault migrates.** `setup init --vault <path>` writes a personal wiki mount into
  `.local/mounts.yaml` instead of the `obsidian vault:` line of `.local/AGENTS.md`; `setup status`
  checks the mount, and an existing `obsidian vault:` line is reported with the `setup mount add`
  command that replaces it. `setup mount add <path> --use … [--skills-only …] [--commit-pointers]
  (--personal | --shared) --dry-run` and `setup mount remove` edit either layer.
- **Rationale.** A vault's notes reach the organization's knowledge base, and a personal vault
  sits outside the organization altogether, so both are outward text under ADR 0003; one check,
  not a second terms file. A personal vault, where notes about one's own tools are normal, may
  allow the word. A vault has no outside reader who would catch a wrong override, so the override
  is a line the user writes, not a flag the agent can add.

## D05 — Linked installations: a boundary in both directions, crossed only by `transfer`
<a id="dec-0007-d05"></a>`Decision-ID: DEC-0007/D05`

- **Choice.** An installation's root is its repository, the work that is versioned. `.local/` is
  never a repository: machine state, secrets, the person's local and private material; its stores
  stay there. Private material that must not meet the organization's lives in a separate,
  personal installation.
- **The boundary.** On in every installation, never declared. A path belongs to another
  installation when the nearest ancestor of its real path that `isInstallation` accepts is not
  this installation; the core is never one. A read there (the file tools, and shell reads through
  `shell.mjs`) is denied unless that installation is registered as a mount without `use`, in
  either layer, the local entry winning; a personal link goes in `.local/mounts.yaml`. A write
  there is always denied (D02).
- **Transfer.** Material moves between installations only through `setup transfer <file in a
  linked installation> [--to <path>] --dry-run`, run in the receiving installation, so it still
  writes only into itself. It runs `outgoingFindings` with the terms of both installations
  together, whichever way the file goes: their `.local/outgoing.yaml` terms and derived terms, and
  the organization's markers (its email domain, its connectors' internal hosts, its tracker key
  patterns). It shows the findings, and the user confirms.
- **Copying after a read.** Text read from a linked installation and written into this one by the
  file tools is not detectable by a guard; OIKOS.md states that such material moves only through
  `setup transfer`. This rule is not machine-checked.
- **Rationale.** The owner's requirement is no leak in either direction. Two installations keep the
  two kinds of material apart by construction; scopes inside one `.local/` keep them apart by an
  ignore line. Checking both term sets needs no label for which installation is personal, which
  would itself be a place to go wrong.
- **Reconsider if** a separate personal installation leaves a gap the owner cannot close; then the
  rejected scopes inside `.local/` (design § Rejected) are reopened. Or if copying after a read
  is seen in practice; then the reads of a linked installation get narrower.
