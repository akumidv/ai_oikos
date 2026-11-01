# ADR 0007 — Mounts: other repositories as sources, an installation that writes only into itself

**Status: accepted.** The owner decided every point below in chat, including the points both
`k_auditor` passes raised and the fixes of the security re-audit of D04 and D05, and accepted this
text; the refinements of ADR 0003 below are commitments with it. Design, alternatives, open points
and the plan: [docs/design/mounts.md](../design/mounts.md). Implementation state:
[`_aitna/TASKS.md`](../../_aitna/TASKS.md) (A9, A11; the accepted gaps L4, L5). Builds on
[ADR 0002](0002-local-stores.md) D01 (what lives in `.local/`) and refines
[ADR 0003](0003-outward-content.md): vault notes (D04 below) leave the unchecked routes of its D05
for a checked tool route under its D01, and their override is narrower than its D03; the rules of
`allow:` entries (D04) and the linked installations' terms (D05) apply to every check of its D01.
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
  `use` or set `mention_assistant: allow` where the shared entry does not. Such a widening is a
  problem and is dropped; the shared entry's value stands. A personal mount is named in no
  committed file unless the user opts in (D03 item 4).
- **What is taken.** `use: [wiki | skills]`; without `use` the mount is read only.
  `skills: {from, prefix, only, tracked}` makes one pointer per skill, named `<prefix>-<name>`.
  The prefix defaults to the mount folder's name, slugified, and must match `^[a-z0-9][a-z0-9-]*$`
  (`tools/common/slug.mjs`); a prefix that does not, or that cannot be made from the folder's name,
  is a problem and the mount gets no pointers. A pointer name longer than 64 characters is a
  problem and only that pointer is skipped. `only` lists the skills that get a pointer, absent
  means all, so a mount's skill that duplicates one of oikos's own is kept out. `only` limits the
  pointers, not the host: a host may still list a mount's own skills when it lazy-loads that folder
  (design Q2). In the resolved mount, `skills.prefix` is the effective prefix, or null when none is
  usable, and `skills.tracked` is always a boolean. There is no `use: rules`; a wiki's `wiki.rules`
  is the note schema of that vault, data for the `vault` connector, not agent rules.
- **A problem entry is not used, and stays protected.** A mount that is this installation or a
  folder above it, or that is or contains the core or another installation (a linked installation
  registered without `use` excepted, D05), a linked installation with `use`, and any other entry
  with a problem (a missing root, a root that is not a repository top, an overlap) is a problem:
  `sync --check` is red, and the `vault` tool and `transfer` do not use the entry. The guards keep
  protecting its path as a mount; a problem never opens a guard.
- **The files the guards lean on are closed to the file tools** (`tools/hooks/mounts-lock.mjs`):
  `.local/mounts.yaml`, `.local/outgoing.yaml` and `.local/sync.json` as a whole; the `mounts:`
  part of `oikos.yaml`; and the keys `hooks`, `disableAllHooks` and `claudeMdExcludes` of
  `settings.json` and `settings.local.json` in every host folder `sync` wires (`.claude/`,
  `.qwen/`). The user edits them in their own editor; `sync` writes its own entries as a tool.
  Mounts change through `setup mount add|remove … --dry-run`, a guarded write
  (`tools/hooks/writes.mjs`) that runs only after its dry run was shown and the user had the word.
  This holds for the file tools; a shell write into these files is the shell gap of D02.
- **Rationale.** The agent hosts load every ancestor's `CLAUDE.md` and a subfolder's lazily, so a
  repository inside an installation leaks rules both ways unless it is declared and wired. A
  personal vault or development root is often outside the installation and must not be named in
  the organization's repository. A personal layer that could widen a shared entry would let a
  local file loosen what the team set. An agent that could edit the mounts list, the `allow:`
  entries, sync's record or the hook wiring could unlock its own guards.
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
  `.local/sync.json`: a mount dropped from the configuration stays protected, since plain `sync`
  keeps its wiring and prints a note; only `sync --prune` removes it, a guarded write
  (`tools/hooks/writes.mjs`, `sync: ['--prune']`) that needs its dry run first, and
  `sync --dry-run` writes nothing. An unreadable configuration never opens the guard. Reads stay
  open. Two routes write into a mount, both from oikos's own tools: a note written by the `vault`
  connector (D04), and `sync`'s own wiring, which is git-ignored there (D03 items 2–3).
- **The shell.** A redirection into a mount and a `git` write subcommand into a mount are denied,
  through one shared shell parser (`tools/hooks/shell.mjs`); a `git` subcommand not on a read
  allow-list counts as a write. The target repository is taken from `-C`, a `cd`, `--git-dir`,
  `--work-tree`, `GIT_DIR` and `GIT_WORK_TREE`. A subcommand that recurses into submodules
  (`submodule foreach|update`, `--recurse-submodules`) and `clean -ff` count as a write into every
  inside mount; a read with `-c` or `--config-env` counts as a write. `git-guard` takes the target
  repository the same way.
- **How a target path is judged** (here, in D04 and in D05). A path is resolved component by
  component, each symbolic link followed before the next `..` is applied, the last component
  included. Containment in a mount, an installation or the core is judged by the device and inode
  of the ancestors, or with the case checked where the file system folds case (drvfs under WSL keeps
  the case it is given). A file with more than one hard link is refused as a target. A tool writes
  through a temporary file in the target's own folder, renamed into place.
- **Rationale.** A mount has its own framework and guards (a branch per task, who commits), which
  run only in a session opened there. A per-mount write switch would make the installation's
  guards stand in for the mount's. A string comparison of paths lets a link, a `..` after a link or
  a case variant walk past every check.
- **Consequences.** Committing a vault is the user's, in their git client or a session opened in
  the vault, so no agent commit inside a mount needs a leak scan. The hooks see the file tools (the
  matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob` and its Qwen counterpart), shell
  redirections and `git`, and nothing else. Accepted gaps, task L5: other writing programs in the
  shell (`cp`, `sed -i`, `python`, `node -e`, globs, `find -exec`; design Q4, task L2), MCP tools
  (the matcher does not match `mcp__*`) and Codex sessions (no oikos guard is wired for Codex,
  D03). The write guard shows that a dry run was printed and that the user had the word after it,
  not what they answered. The file tools and the `vault` tool are the main routes.

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
     `skills.tracked: true` on a personal inside mount (`setup mount add … --tracked-pointers`);
  5. for an outside mount, `permissions.additionalDirectories`.

  Absolute paths go only into git-ignored local files. Everything written is recorded in
  `.local/sync.json`, so `sync --prune` removes exactly the wiring of a removed mount entry and
  nothing the user wrote (D02). `sync --check` is red on a missing mount or one that is not a
  repository top, on overlapping mounts, on a problem entry (D01), on two wikis with one name or
  two defaults, on a `skills.only` name that is not a skill, on a pointer name already taken, and on
  missing, stale or moved wiring (one that names another installation root).
- **Rationale.** `claudeMdExcludes` is the only setting the hosts offer against the rule leaks,
  and it takes absolute paths; the record is the pattern MCP entries already follow. A pointer of
  a personal mount in the installation's commits would name that mount in the organization's
  repository.
- **Consequences.** Qwen Code gets items 3 and 4 and the guards wired in `.qwen/settings.json`, not
  items 1, 2 and 5, until its context loading is known (design Q1). Codex gets item 3 only: no oikos
  guard is wired for Codex (`.codex/hooks.json` holds only akmon's hooks), so no guard of this ADR
  runs in a Codex session (D02 Consequences, task L5). Moving an installation makes the wiring
  stale; `sync` rewrites it.

## D04 — The `vault` connector: notes into wiki mounts, with the content check
<a id="dec-0007-d04"></a>`Decision-ID: DEC-0007/D04`

- **Choice.** Any `use: wiki` mount without a problem (D01) makes the `vault` connector of the
  `wiki` skill available; `requireConnector` lets this derived connector through without a
  `connectors:` line. It is never the default wiki connector, so a knowledge question still goes to
  the knowledge base first, and a request that names a vault or a note selects it. Verbs: `search`
  (all wikis or `--wiki <name>`, the wiki named per hit), `read`, `create` (from `wiki.template`,
  frontmatter checked against `wiki.rules`, into `wiki.inbox`), `append`, `replace-section`;
  `--dry-run` as everywhere, the write verbs listed in `tools/hooks/writes.mjs`. Several wikis each
  have a `name`; `create` goes to the named one, else to the one with `default: true`, else asks.
- **Where it writes.** `create` writes a `.md` note into `wiki.inbox` or a folder below the wiki's
  notes root (the mount's root); `append` and `replace-section` change only an existing `.md` note
  there. Never under any mount's `skills.from`, never a `SKILL.md`, never in a folder whose name
  starts with a dot (`.git/`, `.claude/`, `.qwen/`, `.obsidian/`, …), never a rule file
  (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `QWEN.md`, `GEMINI.md`), never in a nested
  repository. The target is judged as D02 says.
- **The check.** Every note, in a shared or a personal vault, goes through `outgoingFindings`:
  the note's path and name, its frontmatter, headings and body, template text included. The
  categories are `path`, `secret`, `term`, and `assistant` unless the mount sets
  `mention_assistant: allow`; `language` is off unless `wiki.rules` sets a language. The terms are
  the built-ins, the organization's terms in `.local/outgoing.yaml`, the installation's derived
  terms (its absolute root, this machine's home path and the names of `.local/` files; a short or
  common name is not a term, to keep the noise down) and the linked installations' terms (D05).
  For a wiki mount of the local layer they also include the organization's markers, as D05 lists
  them. The text is normalised before matching: NFKC, zero-width characters and emphasis markup
  removed, hyphenated and line-split words joined. The check also refuses executable or fetching
  content — a `dataviewjs` block, an inline `$=` query, a `<%` template tag, a `<script>` or
  `<iframe>` element, an embed of a remote resource — unless `wiki.rules` allows that kind. A
  finding refuses the write with the places named.
- **The override.** The one override of a finding is an `allow:` line of `.local/outgoing.yaml`,
  a file closed to the file tools (D01); the `vault` tool takes no `--allow-flagged`. An `allow:`
  entry that is empty or shorter than 8 characters (`MIN_ALLOW_LENGTH`,
  `tools/common/outgoing.mjs`) is a problem and is ignored, and a dry run lists every line an
  `allow:` entry let pass, with the entry. `mention_assistant: allow` is not an override of a
  finding: it is the mount's choice of categories, made in the closed mounts configuration, and a
  local entry cannot set it where the shared one does not (D01).
- **The existing vault migrates.** `setup init --vault <path>` writes a personal wiki mount into
  `.local/mounts.yaml` instead of the `obsidian vault:` line of `.local/AGENTS.md`; `setup status`
  checks the mount, and an existing `obsidian vault:` line is reported with the `setup mount add`
  command that replaces it. `setup mount add <path> --use … [--skills-only …] [--prefix …]
  [--wiki-name …] [--tracked-pointers] (--personal | --shared) --dry-run` and `setup mount remove`
  edit either layer.
- **Rationale.** A vault's notes reach the organization's knowledge base, and a personal vault
  sits outside the organization altogether, so both are outward text under ADR 0003; one check,
  not a second terms file. A personal vault, where notes about one's own tools are normal, may
  allow the word. A vault has no outside reader who would catch a wrong override, so the override
  is a line the user writes in a file the agent's file tools cannot change, not a flag the agent
  can add. A note is a file the vault tool writes itself, invisible to the hooks, so its path rules
  carry everything. Obsidian runs a note's scripts and fetches its embeds outside every guard.
- **Consequences.** The check is a net for accidents, not a barrier against an agent that hides a
  term on purpose (look-alike letters, encodings the normalisation does not undo). Accepted gap,
  task L4: the write guard binds the command's tokens, not the text, so a body passed by `--file`
  can change between the dry run and the real run; the real run still checks it, but writes text
  nobody saw.

## D05 — Linked installations: a boundary in both directions, crossed only by `transfer`
<a id="dec-0007-d05"></a>`Decision-ID: DEC-0007/D05`

- **Choice.** An installation's root is its repository, the work that is versioned. `.local/` is
  never a repository: machine state, secrets, the person's local and private material; its stores
  stay there. Private material that must not meet the organization's lives in a separate,
  personal installation.
- **The boundary.** On in every installation, never declared, in every host oikos wires its guards
  for (Claude Code, Qwen Code; not Codex, D03). A path belongs to another installation when the
  nearest ancestor of its real path that `isInstallation` accepts (an `oikos.yaml`, or an `oikos/`
  that leads to the core) is not this installation; the core is never one. Paths are judged as D02
  says. A read there (the file tools, and shell reads through `shell.mjs`) is denied unless that
  installation is registered as a mount without `use`, in either layer, the local entry winning; a
  personal link goes in `.local/mounts.yaml`. A search whose scope is an ancestor of this
  installation's root is denied unless it stays inside this installation's mounts. Any shell
  command that names a path in an unregistered installation is denied, whatever the program. A
  write into another installation is denied on every route D02 covers.
- **Transfer.** Material moves between installations only through `setup transfer <file in a
  linked installation> [--to <path>] --dry-run`, run in the receiving installation, so it still
  writes only into itself.
  - **The source.** Text only in the first version: a source of a binary type is refused. Its real
    path lies in a registered linked installation, outside that installation's closed stores and
    its `.env*` files; the tool checks this itself, since its own read is invisible to the hooks.
  - **The destination.** `--to` is judged as D02 says and lies inside this installation, never
    inside the core, a mount, `.git/`, a host folder (`.claude/`, `.qwen/`, `.codex/`), a closed
    store, `.local/mounts.yaml`, `.local/outgoing.yaml`, `.local/sync.json`, or a rule file
    (`AGENTS.md`, `CLAUDE.md`, `.local/AGENTS.md`). The dry run says when it would overwrite a file.
  - **The check.** `outgoingFindings` with the terms of both installations together, whichever way
    the file goes: their `.local/outgoing.yaml` terms and derived terms, and the organization's
    markers (its email domain, its connectors' internal hosts, its tracker key patterns). A finding
    refuses the transfer, as in D04; the one override is an `allow:` line of the receiving
    installation's `.local/outgoing.yaml`, and `transfer` takes no `--allow-flagged`.
- **Every check takes the linked installations' terms.** Every outgoing-text check in an
  installation — the routes of ADR 0003 D01, the vault (D04) and transfer — also takes the terms of
  each registered linked installation: its `.local/outgoing.yaml` terms and its derived terms.
- **Copying after a read.** Text read from a linked installation and written into this one by the
  file tools is not detectable by a guard; OIKOS.md states that such material moves only through
  `setup transfer`. This rule is not machine-checked; the linked installations' terms catch such
  text once it takes a checked route outward.
- **Rationale.** The owner's requirement is no leak in either direction. Two installations keep the
  two kinds of material apart by construction; scopes inside one `.local/` keep them apart by an
  ignore line. Checking both term sets needs no label for which installation is personal, which
  would itself be a place to go wrong. A finding that only advised would fall short of "no leak";
  the transfer tool's own read and write are invisible to the hooks, so its source and destination
  rules carry everything.
- **Consequences.** A hard link made earlier into another installation is not seen by the boundary
  (an accepted gap). A script that reads another installation itself (`node`, `python`) is outside
  the hooks (D02, task L5). The source can change between the dry run and the real run, as in D04
  (task L4).
- **Reconsider if** a separate personal installation leaves a gap the owner cannot close; then the
  rejected scopes inside `.local/` (design § Rejected) are reopened. Or if copying after a read
  is seen in practice; then the reads of a linked installation get narrower. Or if binary material
  must move; then a binary transfer with the dry run saying its content was not checked is
  reconsidered.
