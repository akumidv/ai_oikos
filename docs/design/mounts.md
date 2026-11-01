# Design — mounts: other repositories as sources of skills and notes, never of rules (A9)

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
is accepted until the owner says so; accepted commitments then move to
[ADR 0007](../adr/0007-mounts.md) and the implementation steps to
[`_aitna/TASKS.md`](../../_aitna/TASKS.md) (A9, A11).

**State:** drafted from an installation's requirement and checked against the core's code and
the agent hosts' documentation. Every `D-A9-*` and `D-A11-*` point is decided by the owner
(§ Open points); D-A9-AKMON moved to task A10. The boundary between installations (task A11) builds
on the same model and is designed in § Linked installations. ADR 0007 carries the owner's
decisions on both audits' points and on the security re-audit of D04–D05, and is accepted by the
owner. **Where the ADR and this text differ, the ADR wins**: it is the
later and the more exact text, and this design keeps the reasoning, the plan and the open points.
Built: S1, S2, S3, `setup mount add|remove` with the YAML splicer moved into
`tools/common/yaml-splice.mjs`, D-A9-GUARD-FILES (the closed files and keys, the listed `allow:`
passes, the short `allow:` entry ignored, `sync --prune`), D-S3-PREFIX, D-COMMIT-OPT-IN, S4 (shell and
`git` coverage, with F10 and F15 of the re-audit) and S6 (the `vault` tool and its check).
Committed through 7796443 (S4, S6, the audit-3 fixes); the audit-4 fixes (D-AUDIT4-FIXES) are in the work tree, uncommitted. The audit-5 decisions (D-HOOK-LOAD-FAILURE, D-AUDIT5-EXEC-KEYS, D-AUDIT4-STARTUP-FILES, D-AUDIT5-CORE-LINK, D-AUDIT5-GIT-C, D-AUDIT5-FIXES in § Open points) are decided; their code and the audit-5 fixes are in the work tree, uncommitted. The audit-6 decisions (D-AUDIT6-FALLBACK, D-AUDIT6-FRONTMATTER-HOOKS, D-AUDIT6-CD) are decided; their code is in the work tree, uncommitted. The audit-6b decisions (D-AUDIT6B-SHELL-MODEL, D-AUDIT6B-FRONTMATTER, D-AUDIT6B-PLUGINS, D-AUDIT6B-SHELL-SKILLS, D-AUDIT6B-NESTED-PUSH, in § Open points) are decided; D-AUDIT6B-NESTED-PUSH is deferred; the code of the others is in the work tree, uncommitted.
**How to resume:** read § Frame, § Survey (the corrections to the first draft), § Design, § Linked
installations, then § Open points and ADR 0007; build § Plan slice by slice. Next: S5, S7
(left: the `setup init --vault` migration), S8, the gate, and A11's B1–B4.

## Frame

- **Problem.** An installation's tree, or the same machine, holds other repositories that oikos
  should use:
  - **knowledge vaults**, any number: markdown notes with frontmatter that the organization's
    knowledge base aggregates; the user reads and writes notes there, like a wiki;
  - a **development root** governed by another agent framework: its own `CLAUDE.md`/`AGENTS.md`,
    hooks, skills and tools; development across many repositories happens there, in a session
    opened in that folder.

  Today oikos knows none of them: `sync` writes nothing for them, the guards treat a repository
  inside the installation as installation files, and rules leak both ways (§ Survey).
- **Goal — every direction clean.**
  1. A session in the installation uses a mount's **skills** and **notes**, never its **rules**
     (its `CLAUDE.md` and imports). **An installation writes only into itself** (D-A9-VAULT-WRITE):
     it reads the core, its mounts and its linked installations, and changes none of them. The
     one route into a mount is a note that the `vault` connector writes into a wiki mount. A
     development root's own guards (a branch per task, who commits) run only in a session opened
     there.
  2. A session opened in a mount gets **none of the installation's rules**: neither `OIKOS.md` nor
     the person's `.local/AGENTS.md`.
  3. What is **written into a mount**, above all a vault note, carries nothing of the
     installation: no rules, no `.local/` content or paths, no absolute paths of this machine, no
     personal terms, no secrets. No file oikos generates ends up in the mount's commits.
- **Constraints already decided.**
  - Nothing about an organization in the core; per-organization data comes from the installation.
  - Writes need confirmation (OIKOS.md); a vault is local files, so its writes are file writes
    under the guards. A write command still offers `--dry-run`, as every oikos write command does.
  - Text that oikos writes into the organization's systems is checked once, in
    `tools/common/outgoing.mjs` ([ADR 0003](../adr/0003-outward-content.md)). A vault's notes reach
    the knowledge base, so they are such text.
  - The desk's phase 3 ([design](desk.md) § Outside systems) and A5 wait on this design. The
    outside project there and a mount here are the same thing.
- **Acceptance.**
  - A session opened in each mount shows none of the installation's files in `/memory`.
  - An installation session that read a mount's file shows none of the mount's rule files.
  - A file-tool or shell write into any mount is refused; a note through the `vault` connector
    into a wiki mount passes when clean.
  - No file `sync` writes inside a mount shows in that mount's `git status`.
  - A note naming the installation's absolute root or a `.local/` path is refused.

## Survey — the current code and the hosts

### What the agent hosts do

These rows are checked against the Claude Code documentation (memory, settings, skills, hooks,
CLI reference).

| Behaviour | Consequence |
|---|---|
| `CLAUDE.md` and `CLAUDE.local.md` of the start folder **and every folder above it** load at launch, with their `@imports`. The documentation describes no stop at a git root; for a submodule it says nothing. | A session in a nested mount loads the installation's `CLAUDE.md` → `AGENTS.md` → `OIKOS.md` + `.local/AGENTS.md` (leak 2). |
| A `CLAUDE.md` in a subfolder of the start folder loads **lazily**, once a file there is read or edited. | An installation session reading a mount's file gets the mount's rules (leak 1). |
| Skills in `<subfolder>/.claude/skills/` load lazily the same way, and no setting turns this off. | A mount's own skills may be listed next to oikos's pointers (Q2). |
| `claudeMdExcludes`: globs over **absolute** paths, allowed in any settings layer. The arrays merge; ancestor files and `.claude/rules/**` can be excluded. No "stop at the repository root" setting exists. | The only tool for leaks 1 and 2. |
| Project settings and hooks come from the start folder's `.claude/`, with no parent fallback. Since v2.1.211, `.claude/settings.local.json` is read and written at the **git repository's root**; whether a submodule counts as its own root is not documented. | The installation's guards do not run in a mount session, and the mount's guards do not run in an installation session. A mount must be a repository top for its local settings to be read (TV, Q3). |
| `--add-dir`: skills load from it; `CLAUDE.md` loads only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; most `.claude/` configuration is not read from it. | A folder **outside** the start folder never loads its rules lazily, which makes an outside mount cheaper (§ Design). |

Qwen Code: not checked (Q1). Codex: no oikos guard is wired for Codex at all (`.codex/hooks.json`
holds only the akmon hooks), so Codex is in the same position as Qwen for every guard here.

### The core today — what the design builds on

- **Config.** `config()` in `tools/common/config.mjs` reads only known keys, through `part(key)`,
  and collects problems the way `taskTrackingProblems` does. Those problems already reach
  `sync --check`, `landscape` and `setup status`. A `mounts` key plugs in the same way.
- **sync** (`tools/sync/cli.mjs`) is one top-level script.
  - Skill pointers carry a marker; a marked pointer whose name is not in the list is removed as
    stale. The link depth `../../../` is hard-wired.
  - `.mcp.json` and the names in `.local/sync.json` follow "replace only what sync wrote".
  - `.claude/settings.local.json` is only appended to (`permissions.additionalDirectories`) and
    nothing is removed from it. A `claudeMdExcludes` that sync owns needs the `sync.json` record
    MCP already has.
  - The installation commits its `.claude/skills/` pointers, so a pointer must carry no absolute
    path.
- **Guards.**
  - `package-guard` denies file-tool writes into `oikos/` from an installation; it does not look
    at the shell.
  - `write-guard` exports `workingDirs` (`cd` tracking, with an `unknown` flag) and has the only
    redirection stripper. `secret-guard` has its own inline `cd` tracking.
  - `git-guard` ignores `-C` and `cd` when it decides which repository a commit is in. It has no
    tests.
  - `leaks.mjs` runs `git grep --cached` over the **whole index** of the core for the terms in
    `~/.config/oikos/private-terms`.
  - `secret-guard` judges path names only and has no content patterns.
- **The content check exists — ADR 0003.** `tools/common/outgoing.mjs` provides
  `outgoingFindings`, a pure function, and `guardOutgoing`, which the write commands call.
  - Categories `language`, `assistant`, `path`, `secret`, `term`.
  - Built-in secret patterns (provider token prefixes, private keys, JWTs) and path patterns
    (home folders, `/mnt/<d>/Users/`, `.local/`, the scratchpad).
  - The installation's own `terms:` and `allow:` in `.local/outgoing.yaml`.
  - The `assistant` category already flags the word `oikos`, `oikos.yaml` and `node oikos/tools/`.
- **Wiki.**
  - `skills/wiki` picks a connector from `connectors.wiki`; `requireConnector` refuses an
    unlisted one.
  - The connectors share the operation set `search`, `read`, `create`, `append`,
    `replace-section`.
  - `tools/common/sections.mjs` edits markdown sections purely and skips frontmatter.
  - `searchPages` sits in `tools/github-wiki/pages.mjs`, not in `common`.
  - Every write verb must be listed in `tools/hooks/writes.mjs`.
- **The vault today** is a machine path:
  - `setup init --vault <path>` writes `obsidian vault: <path>` into `.local/AGENTS.md`, and
    `setup status` checks it;
  - OIKOS.md § What lives where names it;
  - `git-guard` says it covers "a user's vault" too;
  - `tools/documents/markdown.mjs` finds a vault by its `.obsidian` folder.

  A personal vault often lives **outside** the installation, on another drive.
- **YAML editing.** `tools/common/tracking-config.mjs` has a comment-preserving YAML splicer, but
  its exported API is task-tracking-specific. Its generic helpers (`addUnder`, `applied`, …) are
  private.

### Corrections to the first draft (the installation's handoff)

1. The vault already exists as a machine path (above). Mounts must **migrate** it, not run beside
   it (D-A9-VAULT).
2. The first draft required a mount **inside** the installation and declared in the committed
   `oikos.yaml`. A personal vault is personal, and it is often outside the installation
   (D-A9-WHERE, D-A9-OUTSIDE).
3. The draft's "secret guard patterns" for content do not exist in the guards. They exist in
   `outgoing.mjs`, and a separate `personal-terms` file would duplicate `.local/outgoing.yaml`
   (D-A9-LEAK).
4. `leaks.mjs` scans the whole index. In a vault with history it would flag old notes, so a mount
   would need a scan of the staged **additions** only. Moot since D-A9-VAULT-WRITE: no agent
   commits inside a mount.
5. `git-guard` must learn the target repository from `-C`/`cd`. It should reuse write-guard's
   shell parsing, moved into a shared module, rather than add a third copy.
6. Mentioning oikos in a note (the draft's Q6) is already decided by ADR 0003: it is an
   `assistant` finding, refused unless allowed. Keep it consistent, or amend ADR 0003 explicitly.

### Moving an installation (found while the first installation moved)

BOOTSTRAP has Set up, Update and Remove, but nothing on moving an installation folder.

| Item | Behaviour |
|---|---|
| The `oikos` symlink | Relative, so it breaks when only the installation moves. `setup init <folder>` recreates a missing link and never overwrites other files. |
| `.mcp.json` (`OIKOS_HOME`, the core's path) | `sync` rewrites it. |
| `permissions.additionalDirectories` | Append-only: a stale entry stays when the core moves. |
| `.local/AGENTS.md` paths | Nobody rewrites them. |
| `.local/.browser/launch.json` | Keeps the old profile path until the next browser `start`; the default DevTools port and the installation code change, since both come from the folder. |
| Mount wiring (items 1–3 below) | Holds absolute paths, so a move makes it stale. |
| The host's per-project data (Claude Code `~/.claude/projects/<encoded path>/`: history, auto memory) | Stays under the old key; moved by hand. |
| An editor workspace file outside the installation | Names the old folder; fixed by hand. |

Wanted in the core:
- `sync --check` is red when a generated file (`.mcp.json`, `settings.local.json`,
  `launch.json`, the mount wiring) names another installation root, and `sync` rewrites them.
- BOOTSTRAP gets a "Moving an installation" section:
  1. Relink `oikos/`.
  2. Run `sync`, then `sync --check`.
  3. Move the host's project data and fix the editor workspace by hand.
  4. Pin `OIKOS_CHROME_PORT` if something outside depends on the port.
  5. Start a new session, with `qwen mcp approve --all` when `.mcp.json` changed.

Moving the folder of a git repository with a submodule keeps the submodule, because its git dir
path is relative. Backlog: P3-5.

## Design

### Model

A **mount** is a repository that oikos uses as a **source**: of skills, of notes, of material to
read. It is never a source of rules. Its own rules govern only a session opened in it, and an
installation session never changes it (D-A9-VAULT-WRITE). An installation declares any number of
mounts. Another oikos installation registered as a mount is a **linked installation**
(§ Linked installations).

```yaml
# oikos.yaml — shared mounts: inside the installation, relative paths
mounts:
  vaults/team:                    # relative to the installation's root, '/' separators, nesting allowed
    use: [wiki]                   # wiki | skills; absent — read only
    wiki: { name: team, rules: NOTES.md, template: templates/note.md, inbox: inbox/ }
  projects/dev-root:
    use: [skills]
    skills: { from: .claude/skills, prefix: dev, only: [deploy-status, search-artifacts] }
```

```yaml
# .local/mounts.yaml — personal mounts: the same schema; a path may be absolute and outside the
# installation. Git-ignored and never indexed: a personal link is named in no committed file.
mounts:
  /path/to/personal/vault:
    use: [wiki]
    wiki: { name: own, rules: NOTES.md, template: templates/note.md, inbox: inbox/, default: true }
  /path/to/dev-root:              # a development root beside the installation
    use: [skills]
    skills: { from: .claude/skills, prefix: dev }
  /path/to/personal-installation: # a linked installation: read only
```

- **Two layers, the local one wins** (D-A9-WHERE). `config()` merges `.local/mounts.yaml` over
  `oikos.yaml` by real path: a local entry for a path the shared file declares replaces that
  entry as a whole, but only narrows it (D-A9-LOCAL-NARROW): `use: wiki` is a write route (the
  `vault` connector), so a local entry cannot add `wiki` to `use` or set
  `mention_assistant: allow` where the shared entry does not; the widening is a problem and is
  dropped. A problem entry is not used by the `vault` tool or `transfer`, opens no reads, and stays
  protected by the guards: every root of a mount entry, problem or not, is in `config().guarded`
  ([ADR 0007](../adr/0007-mounts.md) D01).
- **`use`.** `wiki` makes the mount a source of the `vault` connector; `skills` makes pointers to
  its skills. Without `use` the mount is read only: its files may be read, nothing is taken from
  it.
- **`skills.only`** (D-A9-SKILL-PICK) lists the skill names to point to; absent, every skill under
  `skills.from`. It keeps out a mount's skill that duplicates one of oikos's own (a tracker or a
  wiki skill) and would compete for the same requests.
- **Paths.**
  - A mount path is a **repository top** (its own `.git`). It is not `oikos/` and not under
    `.local/`. It is not inside another mount. A shared path is relative and has no `..`; a local
    path may be absolute.
  - A repository nested deeper inside a mount, such as a development root's child checkouts, is
    covered by that mount.
  - Paths are judged component by component, links followed before the next `..`, containment by
    device and inode or with the case checked, hard-linked targets refused (ADR 0007 D02 § How a
    target path is judged; the re-audit's F4). Which form the host matches in `claudeMdExcludes`,
    logical or real, is TV.
- **oikos does not create a mount**; the user adds the submodule or clone. BOOTSTRAP says how,
  including `ignore = all` in `.gitmodules` for a repository that commits often (a vault), so the
  installation does not show it as modified.
- **No `use: rules`.** The one exception is a wiki's *content* rules (`wiki.rules`): a markdown file
  whose front matter holds the vault's note rules (D-S6-RULES-FORMAT), read by the vault connector
  when it writes a note. They are data rules, not agent rules.
- **Several wikis.**
  - Each wiki mount has a `name` (default: its path).
  - `search` runs over all of them and names the vault of each hit; `read` takes a hit as given.
  - `create` goes to the vault the user or the task names, else to the one with `default: true`,
    else it asks.
  - Which source is asked first, the knowledge base or the vaults' drafts, is set by the
    installation's `AGENTS.md`.
- **Inside or outside.**
  - An **inside** mount needs the exclusion wiring both ways (items 1 and 2 below).
  - An **outside** mount is not below the installation's start folder, so it never loads its rules
    lazily (item 1 is moot). The installation is not its ancestor, so item 2 is moot too. It needs
    `permissions.additionalDirectories` for file access, the guards, and pointers that carry no
    absolute path in a committed file.

### What `sync` writes per mount

Absolute paths go only into git-ignored local files. `sync` replaces only what it wrote and
records it in `.local/sync.json` (`{mcp: [...], mounts: {...}}`). A removed mount entry keeps
its wiring under plain `sync`, which prints a note; `sync --prune`, a guarded write with its dry
run first, removes exactly that wiring (D-A9-GUARD-FILES, ADR 0007 D02). Built as
`tools/sync/mounts.mjs`, not as more top-level script.

1. **The installation does not load an inside mount's rules.** `sync` adds `claudeMdExcludes` to
   the installation's `.claude/settings.local.json`: `<abs mount>/**/CLAUDE.md`,
   `<abs mount>/**/CLAUDE.local.md`, `<abs mount>/**/.claude/rules/**`.
2. **An inside mount does not load the installation's rules.** `sync` writes `claudeMdExcludes`
   into `<mount>/.claude/settings.local.json`: the `CLAUDE.md` and `CLAUDE.local.md` of the
   installation's root and of every folder between it and the mount. The mount's own keys in that
   file stay; its framework may write the same entries, which is harmless because arrays merge.
3. **Nothing oikos writes lands in a mount's commits.** Every file `sync` writes inside a mount is
   added to `<mount>/.git/info/exclude`, unless `git check-ignore` already ignores it. This is
   local and never changes the mount's committed files.
4. **Skills** (`use: skills`):
   - one pointer per skill under `skills.from` (only those in `skills.only` when it is set), named
     `<prefix>-<name>`, next to oikos's own, with the same marker; the prefix defaults to the
     mount folder's name slugified and matches `^[a-z0-9][a-z0-9-]*$`, and a pointer name over 64
     characters is a problem that skips only that pointer (D-S3-PREFIX);
   - the link is computed for an inside mount;
   - the pointer of an outside mount, and every pointer of a personal mount, goes into the
     installation's `.git/info/exclude` (chosen at build time), unless `skills.tracked: true` is
     set on a personal inside mount (D-A9-PERSONAL-POINTERS, D-COMMIT-OPT-IN);
   - the pointer says where the skill comes from, that the mount's rules are not loaded, and that
     work which writes into the mount or needs its guards is done in a session opened there;
   - running the mount's own tools with its credentials is not part of this task: a mount skill
     whose steps call such a tool is taken only when the owner accepts that (external
     capabilities, a later task);
   - `landscape skills` shows the origin.
5. **Wiki** (`use: wiki`): every wiki mount is a source of the `vault` connector (§ Vault). Its
   path enters `permissions.additionalDirectories` when it is outside.
6. **Checks.** `sync --check` is red when:
   - a declared mount is missing or not a repository top;
   - it overlaps `oikos/`, `.local/` or another mount;
   - it is a problem entry of ADR 0007 D01 (this installation or a folder above it, a folder that
     holds the core, a linked installation with `use` or without a `.git` of its own, a folder that
     holds another installation within the nested search of two levels and 100 folders, task L6);
   - two wikis share a name, or more than one is `default`;
   - a name in `skills.only` is not a skill under `skills.from`;
   - the wiring of items 1–5 is missing or stale, or names another installation root (a move).

   `setup status` and `landscape` list the mounts with `use`, the layer (shared or local) and the
   wiki name.

### Guards

- **An installation writes only into itself** (D-A9-VAULT-WRITE). The core is already guarded
  this way; every mount and every linked installation joins it.
  - File tools: `package-guard` denies `Edit`/`Write`/`NotebookEdit`/`MultiEdit` of a path inside
    any mount with "open a session in `<mount>` to change it". `sync`'s own wiring (items 2–3) is
    written by `sync`, not through the file tools.
  - The files the guards lean on are closed to the file tools (D-A9-SELF-UNLOCK,
    D-A9-GUARD-FILES; `tools/hooks/mounts-lock.mjs`, built): `.local/mounts.yaml`,
    `.local/outgoing.yaml`, `.local/sync.json`, the `mounts:` part of `oikos.yaml`, and the host
    settings files (`settings.json`/`settings.local.json` in `.claude/` and `.qwen/`, and the user-level
    ones) of which the file tools may change only the `permissions` key (D-AUDIT5-EXEC-KEYS, which
    reshapes D-A9-GUARD-FILES to an allow-list). `.mcp.json` at the installation root, `~/.claude.json`
    and the shell startup files of the home are closed too (D-AUDIT5-EXEC-KEYS, D-AUDIT4-STARTUP-FILES).
  - Shell: a redirection into a mount is denied, and so are `git` write subcommands (`add`,
    `commit`, `push`, `checkout`, `reset`, `rebase`, `merge`, `stash`, `tag`; any subcommand not on
    a read allow-list) into a mount. The target comes from `-C`, a `cd`, `--git-dir`,
    `--work-tree`, `GIT_DIR` and `GIT_WORK_TREE`; submodule recursion and `clean -ff` count as a
    write into every inside mount; a read with `-c` or `--config-env` counts as a write
    (D-A9-AUDIT2-GAPS, F15). This uses write-guard's parsing, moved into the shared
    `tools/hooks/shell.mjs` without changing its behaviour (S2). `git-guard` takes the target
    repository the same way.
  - Reads stay open.
  - What the hooks do not see is stated in ADR 0007 D02 Consequences: other writing programs in
    the shell, MCP tools and Codex sessions (task L5), and the user's answer to a dry run.
- **The `vault` connector is the one route into a mount.** It writes notes into `use: wiki` mounts
  only, and nothing of the installation goes with them (leak 3, D-A9-LEAK). The exact rules are
  ADR 0007 D04; in short:
  - every note goes through `outgoingFindings` — its path and name, frontmatter, headings and
    body, template text included — with the categories `path`, `secret`, `term`, and `assistant`
    unless the mount sets `mention_assistant: allow` (D-A9-OIKOS-WORD); `language` is off unless
    the note rules set English (D-S6-RULES-FORMAT);
  - the terms are the built-ins, `.local/outgoing.yaml`, the installation-derived terms (its
    absolute root, this machine's home path and the names of `.local/` files), the linked
    installations' terms (D-A11-LINKED-TERMS), and for a personal vault also the organization's
    markers (D-A9-VAULT-TERMS, F7);
  - the text is normalised before matching (NFKC, zero-width characters and emphasis markup
    removed, split words joined; F13), and executable or fetching content is refused unless
    the note rules' `allow` lists it (D-A9-NOTE-EXEC, D-S6-RULES-FORMAT);
  - a finding refuses the write with the places named; the one override is an `allow:` line of
    `.local/outgoing.yaml`, except for executable content, which only the note rules allow — no `--allow-flagged` on the `vault` tool (D-A9-OVERRIDE); an `allow:`
    entry shorter than 8 characters is ignored, and the dry run lists each line an entry let pass
    (D-A9-GUARD-FILES).
  - It writes only into `wiki.inbox` or below the notes root, never under any mount's
    `skills.from`, a `SKILL.md`, a dot folder, a rule file or a nested repository (F5).

  Committing the vault is the user's, in their own git client or a session opened in the vault,
  so no agent commit inside a mount needs a scan.
- **Latency.** A guard that needs the mounts reads `config()` per call, since every guard is a
  fresh process. Measure it against the existing two-second test. If it is slow, read the
  resolved mounts from `.local/sync.json`, which `sync --check` keeps honest.
- **`session-start`** names the mounts, one line each: what is used, the wiki name, and that a
  mount is changed only in a session opened there (notes through the `vault` connector aside).

### Vault — the `wiki` connector over wiki mounts

`skills/wiki/connectors/vault.md` documents it, over `tools/vault/cli.mjs`.

| Verb | What it does |
|---|---|
| `search` | Title, frontmatter, text; all wikis or `--wiki <name>`. Reuses `searchPages`, moved to `common`. |
| `read` | A hit as given. |
| `create` | From `wiki.template`, frontmatter checked against `wiki.rules`, into `wiki.inbox` unless a folder is given. |
| `append`, `replace-section` | Through `tools/common/sections.mjs`. |

- No frontmatter `id` rename.
- `--dry-run` as everywhere; the write verbs are listed in `tools/hooks/writes.mjs`.
- The leak check above runs on every write.
- The connector is derived from `use: wiki` (D-A9-CONNECTOR): available whenever a wiki mount
  exists, never the default wiki connector, so knowledge questions still go to the knowledge base
  first. A request that names a vault or a note selects it; the installation's `AGENTS.md` may
  set the order.

## Linked installations — the boundary between installations (A11)

The owner's requirement: **no leak in either direction** between an organization's installation
and a person's own. Private material lives in a separate, personal installation, not in scopes
inside one installation's `.local/`.

- **What is where** (D-A11-LOCAL-REPO, D-A11-STORES).
  - An installation's **root is its repository**: the work that is versioned.
  - `.local/` is never a repository: machine state, secrets, and the person's local and private
    material. Its stores (desk, footprint, catalog, backlog, people) stay there; a store moves into
    the root only by the owner's decision for that store.
- **Registration** (D-A11-READ). Another installation is read only when it is registered as a
  mount without `use` (§ Model):
  - in `oikos.yaml` or `.local/mounts.yaml`, the local entry winning;
  - a personal link goes in `.local/mounts.yaml`, so it is named in no committed file and no index.

  A registered installation can be read at any time, including for a one-off lookup.
- **The boundary guard** (D-A11-BOUNDARY): on in every installation, never declared, in the
  hosts oikos wires its guards for (Claude Code, Qwen Code; not Codex).
  - A path belongs to **another installation** when the nearest ancestor of its real path that
    `isInstallation` accepts — an `oikos.yaml` **or** an `oikos/` that leads to the core
    (`tools/common/paths.mjs`) — is not this installation. Paths are judged as ADR 0007 D02 says.
  - A read there (`Read`, `Grep`, `Glob`, and shell reads by the path tracking of `shell.mjs`) is
    denied unless the installation is registered: "register it in `.local/mounts.yaml`".
  - A search whose scope is an ancestor of this installation's root is denied, with no exception for
    a mount (D-S4-ANCESTOR); any shell command that names a path in an unregistered
    installation is denied, whatever the program (D-A9-AUDIT2-GAPS, F10; built in S4). A hard
    link made earlier is an accepted gap.
  - A write there is denied on every route § Guards covers.
  - Today only the browser tells installations apart, by the profile path.
- **What may be changed** (D-A11-SHARED). An installation changes only itself. It reads the core,
  its mounts and its linked installations, and changes none of them. This is the rule of
  § Guards; A11 adds only the read side for an unregistered installation.
- **Transfer: data crosses only on request.** Reading is not moving.
  - Material goes from one installation into another only through one command, run **in the
    receiving installation**, so it still writes only into itself: `setup transfer <file in a
    linked installation> [--to <path>] --dry-run`.
  - It runs `outgoingFindings` with the terms of **both** installations together, whichever way
    the file goes (D-A11-DIRECTION; this replaces the first draft's check "of the direction" with
    the source's terms only): their `.local/outgoing.yaml` terms and derived terms, and the
    organization's markers — its email domain, the internal hosts of its connectors, its tracker
    key patterns.
  - A finding refuses the transfer, as a vault note's does; the one override is an `allow:` line
    of the receiving installation's `.local/outgoing.yaml` (D-A11-TRANSFER-REFUSE).
  - The source is text only in the first version, a binary one is refused; its real path lies in
    a registered linked installation, outside its closed stores and `.env*` files, checked by the
    tool itself (D-A11-TRANSFER-BINARY).
  - `--to` lies inside this installation, never in the core, a mount, `.git/`, a host folder, a
    closed store, `.local/{mounts,outgoing}.yaml`, `.local/sync.json` or a rule file; the dry run
    says when it would overwrite (F2). Exact text: ADR 0007 D05.
  - Every outgoing-text check in an installation also takes the terms of all its linked
    installations (D-A11-LINKED-TERMS), so text copied after a read is caught once it takes a
    checked route.
  - A typical case: a summary of footprint reports the user agreed to, taken into the personal
    installation for a CV.

Plan: after A9 S1 (mounts in `config()`) and S2 (`shell.mjs`).

| Slice | What | Delegate |
|---|---|---|
| B1 | The boundary guard for the file tools (reads of an unregistered installation, writes of any; paths judged per ADR 0007 D02) with tests | k_implementer |
| B2 | The same through `shell.mjs` (the search-scope and any-program rules of F10 land in S4) | k_implementer |
| B3 | `setup transfer` with both installations' terms (the organization's markers derived from `oikos.yaml`), a finding refuses, text sources only, the source and `--to` rules, `--dry-run`, the write verb in `writes.mjs`; the linked installations' terms in every outgoing check | k_implementer, then k_auditor (security: F2, F4, F11 against the code) |
| B4 | Docs: OIKOS.md (What lives where: the root is the repository, `.local/` never is; linked installations), BOOTSTRAP.md (a personal installation beside an organization's) | k_mechanic |

TV at build time: how the organization's tracker key patterns are read from `oikos.yaml`; what a
transfer of a folder means.

## Plan — trunk first

The trunk is the coarsest slice that meets the acceptance condition for rules and writes. Every
later slice returns to it with the condition still met. The delegate of each slice is named; the
orchestrator keeps synthesis and the owner dialogue.

| Slice | What | Delegate |
|---|---|---|
| S0 | Owner decisions `D-A9-*`, then the ADR 0007 draft; the owner decides. Both audits and their decisions are in; ADR 0007 accepted by the owner. | orchestrator; k_auditor over the ADR draft |
| **S1 trunk** | `mounts` in `config()`, both layers merged per D-A9-WHERE (local wins), `use`, `skills.only`, with its problems; mount roots in `paths.mjs`; `tools/sync/mounts.mjs` items 1–3 with the `sync.json` record and `--check`; `package-guard` denies file-tool writes into every mount; `session-start` line; tests. Built, with the closed files and keys of D-A9-GUARD-FILES (`mounts-lock.mjs`), the listed `allow:` passes and `MIN_ALLOW_LENGTH`, `sync --prune`, and `setup mount add\|remove` | k_implementer |
| S2 | Move write-guard's `workingDirs` and redirection stripper into `tools/hooks/shell.mjs`; behaviour unchanged, tests green. Built | k_mechanic |
| S3 | Skill pointers with the prefix and `skills.only` (computed link, outside-mount rule), `landscape` origin; D-S3-PREFIX, `skills.tracked`. Built | k_implementer |
| S4 | Shell coverage of the write rule: redirections and `git` write subcommands into any mount, the target from `-C`, `cd`, `--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`, submodule recursion and `clean -ff` as writes into every inside mount, `-c`/`--config-env` as a write (F15); the search-scope and any-program boundary rules (F10); the guards' paths judged per ADR 0007 D02 (F4); `git-guard` target repository via `shell.mjs`; first `git-guard` tests | k_implementer, then k_auditor (security) |
| S5 | A moved installation: `sync --check` red on a generated file that names another root (`.mcp.json`, `settings.local.json`, `launch.json`, mount wiring), `sync` rewrites them (P3-5) | k_implementer |
| S6 | `vault` tool and connector with the check of ADR 0007 D04: `outgoingFindings` over path, frontmatter, headings and body (F14), derived and linked installations' terms, the organization's markers for a personal vault (F7), `mention_assistant`, normalised text (F13, in `outgoing.mjs` for every check), executable content refused (D-A9-NOTE-EXEC), the write targets (F5) and path judging (F4), problem entries unused (F8); `wiki` skill; akmon skill-pointer sync | k_implementer, then k_auditor (security: F4 links, `..`, drvfs case, hard links) |
| S7 | `setup mount add … --dry-run` (D-A9-HELPER) on the YAML splicer moved into a generic module (built); `setup init --vault` migration (D-A9-VAULT) | k_mechanic (extraction), k_implementer |
| S8 | Docs: OIKOS.md (What lives where: mounts; a mount's rules never load; an installation writes only into itself), DEVELOPMENT.md (Layout: what sync writes, the guards), BOOTSTRAP.md (adding a mount; moving an installation, P3-5), `examples/installation/oikos.yaml` | k_mechanic |
| Gate | `npm run check`, `npm test` to green; audit of the whole change; live checks by the owner (§ To verify) | k_validator, k_auditor |

Order: S0 → S1 → (S2 ∥ S3 ∥ S6) → S4 → (S5 ∥ S7 ∥ S8) → Gate, then A11's B1–B4 (§ Linked
installations). S2 is behaviour-preserving and may start at once.

## Open points

| # | Point | State | Options → decision |
|---|---|---|---|
| **D-A9-WHERE** | Where mounts are declared | **decided (owner): B** | `oikos.yaml` for shared mounts plus `.local/mounts.yaml` for personal ones, one schema; a local entry replaces a shared entry of the same path (owner, 2026-10-28). A personal mount is never named in a committed file. |
| **D-A9-OUTSIDE** | May a mount live outside the installation? | **decided (owner): yes** | An absolute path, in the local layer only. An outside mount needs less wiring: no lazy rules, no ancestor chain. |
| **D-A9-VAULT** | The existing vault model (`setup init --vault`, `obsidian vault:` in `.local/AGENTS.md`) | **decided (owner): A, migrate** | `--vault` writes a personal wiki mount into `.local/mounts.yaml`; `setup status` checks the mount; the `obsidian vault:` line goes; OIKOS.md follows. |
| **D-A9-LEAK** | The leak check of text written into a mount | **decided (owner): A** | `outgoingFindings` with the categories `path`, `secret`, `term` (and `assistant` per D-A9-OIKOS-WORD); the terms are the built-ins, `.local/outgoing.yaml` and the derived installation terms. `language` is off unless the note rules set English (D-S6-RULES-FORMAT). A hook only denies: the way past a false finding is an `allow:` line. It runs in the `vault` connector (§ Guards). Rejected: B, a new `.local/personal-terms`. |
| **D-A9-OIKOS-WORD** | A note that mentions oikos (Q6) | **decided (owner): C** | `assistant` is on by default, as ADR 0003 has it; a mount may set `mention_assistant: allow` (a personal vault, where notes about one's own tools are normal). Its "ADR 0003 is not amended" is superseded by D-A9-0003-SCOPE. `mention_assistant: allow` is the mount's choice of categories, not an override of a finding (ADR 0007 D04; the re-audit's C5). |
| **D-A9-CONNECTOR** | Is the `vault` connector derived from `use: wiki`, or also listed in `connectors.wiki`? | **decided (owner): A, derived** | Any wiki mount makes `vault` available; it is never the default wiki connector; a request that names a vault or a note selects it; the installation's `AGENTS.md` may set the order. |
| **D-A9-VAULT-WRITE** | May an installation session write into a mount? | **decided (owner): A** | An installation writes only into itself. The file tools and the shell never write into a mount; the `vault` connector writes notes into `use: wiki` mounts, with the leak check. The first draft's `write:` key is gone. |
| **D-A9-SKILL-PICK** | Which of a mount's skills get pointers | **decided (owner): a filter** | `skills.only: [names]`; absent, all of them. It keeps out a skill that duplicates one of oikos's own. |
| **D-A9-HELPER** | `setup mount add <path> --use … --dry-run`, or the user edits the YAML | **decided (owner): the helper** | Built (with S1, on the splicer extracted into `tools/common/yaml-splice.mjs`). It writes to `.local/mounts.yaml` or `oikos.yaml` by `--personal`/`--shared`, and takes `--use`, `--skills-only`, `--prefix`, `--wiki-name` and `--tracked-pointers`. |
| **D-A9-AKMON** | Is an installation itself attached to akmon? | **moved out of A9 (owner)** | akmon is meant for developing code, agents and skills in installations too, attached more softly than for developers, since oikos users are not developers; the model is task A10. A9 assumes no akmon in an installation and must not block one: a mount's exclusion wiring and the guards stay valid if an installation later carries `_aitna/`. |
| **D-A9-SHAPES** | The resolved mount and the `sync.json` record of S1 | **decided (owner): accepted** | `{ path, layer, root, inside, use, skills, wiki, mention_assistant }`; `mounts: { <real root>: { installExcludes, installDirs, excludes, created, ignored, pointers, installIgnored } }`. Confirmed by the owner with S3 and D-A9-GUARD-FILES: in the resolved `skills`, `prefix` is the effective prefix or null when none is usable, and `tracked` is always a boolean; the outgoing rules gain `problems` (the ignored `allow:` entries). |
| **D-A9-SELF-UNLOCK** | An agent edits the mounts list, then writes into the dropped mount (audit) | **decided (owner): A** | The file tools may not edit `.local/mounts.yaml` or the `mounts:` part of `oikos.yaml`; mounts change through `setup mount add\|remove --dry-run`. Rejected: B, rely on the write's confirmation. Widened by D-A9-GUARD-FILES. |
| **D-A9-PERSONAL-POINTERS** | A personal mount's pointer lands in the organization's commits (audit) | **decided (owner): A, with an opt-in** | Pointers of personal and outside mounts go into the installation's `info/exclude`; the user may set `skills.tracked: true` (D-COMMIT-OPT-IN) on a personal inside mount to commit them. Rejected: B, no pointers for personal mounts. |
| **D-A9-VAULT-TERMS** | Is a note into a personal vault checked against the organization's terms? (audit) | **decided (owner): A** | Yes, every note in either layer; for a personal (local-layer) vault the terms also include the organization's markers as transfer uses them — email domain, connectors' internal hosts, tracker key patterns (the re-audit's F7, part 1). Rejected: B, secrets and paths only. |
| **D-A9-LOCAL-NARROW** | A local entry widens a shared one (audit) | **decided (owner): A** | Whole replacement stays, but a local entry cannot add `wiki` to `use` or set `mention_assistant: allow`; the attempt is a problem and is dropped. Rejected: B, the local entry may do anything. |
| **D-A9-OVERRIDE** | How a vault note with a finding passes (audit) | **decided (owner): A** | Only an `allow:` line of `.local/outgoing.yaml`; no `--allow-flagged` on the `vault` tool. Rejected: B, the flag as on other writes. |
| **D-A9-0003-SCOPE** | ADR 0007's relation to ADR 0003 (audit) | **decided (owner): as recommended** | ADR 0007 refines ADR 0003 for vault notes: they leave D05's unchecked routes for D01's checked route, and their override is narrower than D03's. This replaces "ADR 0003 is not amended" of D-A9-OIKOS-WORD. |
| **D-A11-COPY** | Text read from a linked installation and written here by the file tools (audit) | **decided (owner): A** | A rule in OIKOS.md, not machine-checked: such material moves only through `setup transfer`. Rejected: B, no reads of linked installations. |
| **D-A11-DIRECTION** | Which terms `setup transfer` checks (audit) | **decided (owner): A** | The terms of both installations together, either way. Rejected: B, a `kind: personal` label. |
| **D-A9-GUARD-FILES** | The files the guards lean on, open to the agent (re-audit F1, F9, F16) | **decided (owner): A; built** | Closed to the file tools (`tools/hooks/mounts-lock.mjs`): `.local/mounts.yaml`, `.local/outgoing.yaml`, `.local/sync.json`; in `settings.json`/`settings.local.json` of `.claude/` and `.qwen/` the keys `hooks`, `disableAllHooks`, `claudeMdExcludes` and `env` (`env` added in audit 4, H-A: it is within this decision's scope, whatever the protection leans on). The outgoing dry run lists every line an `allow:` entry let pass, with the entry; an `allow:` entry empty or shorter than 8 characters (`MIN_ALLOW_LENGTH`, `tools/common/outgoing.mjs`) is a problem and ignored. Plain `sync` keeps a gone mount's wiring and prints a note; only `sync --prune`, a guarded write (`writes.mjs` `sync: ['--prune']`) with its dry run first, removes it; `sync --dry-run` is read-only. The user-level host settings: D-AUDIT3-USER-SETTINGS. Reshaped by D-AUDIT5-EXEC-KEYS: the settings keys are now an allow-list (only `permissions` may change), and `.mcp.json` and `~/.claude.json` are closed. Rejected: B, an accepted gap. |
| **D-A9-NOTE-EXEC** | Notes that carry content Obsidian runs or fetches (re-audit F6) | **decided (owner): A** | The vault note check refuses `dataviewjs`, `$=`, `<%`, `<script>`, `<iframe>` and remote embeds unless the note rules' `allow` lists them (D-S6-RULES-FORMAT). Built in S6. Rejected: B, an accepted gap. |
| **D-A11-TRANSFER-REFUSE** | Does a finding refuse a transfer? (re-audit F3) | **decided (owner): A** | Yes, as for a vault note; the only override is an `allow:` line in the receiving installation's `.local/outgoing.yaml`. Rejected: B, findings only advise. |
| **D-A11-TRANSFER-BINARY** | Binary transfer sources (re-audit F11) | **decided (owner): A** | Text only in the first version; a binary source is refused. The source's real path lies in a registered linked installation, outside its closed stores and `.env*`, checked by the tool itself. Rejected: B, a binary source moves with the dry run saying its content was not checked. |
| **D-A11-LINKED-TERMS** | Linked installations' terms in outward checks (re-audit F7, part 2) | **decided (owner): A** | Every outgoing-text check in an installation also takes the terms of all its linked installations: their `.local/outgoing.yaml` terms and derived terms. |
| **D-A9-AUDIT2-GAPS** | What of the re-audit's F10, F12, F13, F15 is closed and what is an accepted gap | **decided (owner): as recommended** | Closed in S4: F10 (a search scope above the installation root denied, with no exception for a mount, D-S4-ANCESTOR; any shell command naming a path in an unregistered installation denied whatever the program; a hard link made earlier is an accepted gap) and F15 (the `git` target also from `--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`; submodule recursion and `clean -ff` a write into every inside mount; a read with `-c`/`--config-env` a write). F13: text normalised before matching (NFKC, zero-width characters and emphasis markup removed, split words joined), and the check stated as a net for accidents, not a barrier (ADR 0007 D04, ADR 0003 Consequences). Accepted gaps with a task: F12, content drift between dry run and real run (task L4; ADR 0007 D04, ADR 0003); MCP tools, Codex sessions and other writing programs in the shell (task L5; ADR 0007 D02); the rest of the ancestor search (task L6, D-S4-ANCESTOR). |
| **D-LINKED-NOGIT** | A linked installation without a `.git` of its own (owner, 2026-11-04) | **decided (owner): a repository** | Per D01 ("a mount is a repository"), a linked installation registered as a mount without `.git` at its top is a problem entry ("not the top of a repository") and is not readable; `sync --check` reports it. A personal installation without a remote gets `git init` once. Built: the problem entry and the read refusal (`repositoryProblems`, `opensReads`); not built: the one-time `git init` (no `git init` in `tools/`). Rejected: treating an installation without `.git` as a clean mount. |
| **D-AUDIT3-USER-SETTINGS** | The user-level host settings: `hooks`, `disableAllHooks`, `claudeMdExcludes`, and `env` from audit 4 (audit 3, 2026-11-04) | **decided (owner): closed; built** | Closed to the file tools, as the installation's settings already are (D-A9-GUARD-FILES): the keys (four, with `env`) of `~/.claude/settings.json` and `settings.local.json` there, of the folder `CLAUDE_CONFIG_DIR` names when it is set, and of `~/.qwen/settings.json` and `settings.local.json`; in `tools/hooks/mounts-lock.mjs` (`userSettingsFiles`, read at the package guard's entry point). The guard runs only in a session inside an installation. A shell write to them stays in the accepted gap L5. Reshaped to an allow-list by D-AUDIT5-EXEC-KEYS, as D-A9-GUARD-FILES. Rejected: an accepted gap. |
| **D-AUDIT4-FIXES** | The fourth audit's fixes (audit 4, 2026-11-04) | **no decision: restores accepted ADR text** | Built in the work tree, uncommitted, and recorded in ADR 0007 without a new decision: `env` closed (H-A; D-A9-GUARD-FILES, D-AUDIT3-USER-SETTINGS); a hook takes the host's project folder before `OIKOS_HOME`, and an `OIKOS_HOME` that leads to no installation denies the writes (ADR 0007 D02); a `mounts:` that is not a mapping declares its names (M-A; D01); a linked installation that holds another is a problem (D01); the shell judgements of the git output options, the hook state folder, wrappers, program variables, `~name`, braces and globs on write routes (D02); the Medium and Low findings the code fixes, the vault check's remote-embed, attribute and CSS-escape forms among them (D04 names no forms, so it is unchanged). The residuals are accepted gaps of task L5 (ADR 0007 D02). |
| **D-HOOK-LOAD-FAILURE** | What a hook decides when its guard cannot load, throws, crashes or misses its deadline (audit 5) | **decided (owner): A** | `tools/hooks/host-hook.mjs` is an import-free dispatcher (node builtins only at top level). It runs the guard in a child process (`--run <guard>`, killed with its process group) with a deadline `DEADLINE_MS` = 20 s; every wired oikos hook carries an explicit `timeout` `HOOK_TIMEOUT_SECONDS` = 30 (`tools/hooks/wiring.mjs`, written into the `.claude/` and `.qwen/` settings). For PreToolUse the fallback rules decide: shell tools denied on privilege words (sudo, doas, pkexec, su), git write verbs, and a redirection other than to /dev/null, /dev/stdout or /dev/stderr; file-write tools denied; reads allowed with a loud `systemMessage`; on a timeout any shell command or file write denied outright (split the command). A denial the guard printed before it failed stands. Overhead about 30 ms per hook call. Installations need a re-sync, since the wiring changed. The fallback rules and the time budget are ADR 0007 D02. |
| **D-AUDIT5-EXEC-KEYS** | Which keys of the host settings the file tools may change (audit 5); reshapes D-A9-GUARD-FILES | **decided (owner): B** | An allow-list in place of the key deny-list of D-A9-GUARD-FILES and D-AUDIT3-USER-SETTINGS: the file tools may change only `permissions` in the host settings files, the installation's `settings.json` and `settings.local.json` for `.claude/` and `.qwen/` and the user-level ones, including the folder `CLAUDE_CONFIG_DIR` names. `.mcp.json` at the installation root, `~/.claude.json` and the one in `CLAUDE_CONFIG_DIR` are closed. M3: the text after the edit must be strict JSON (a BOM, a comment or a trailing comma is denied as uncheckable); an unparsable current file denies any edit to it; an absent file counts as `{}`. Code: `tools/hooks/mounts-lock.mjs`. |
| **D-AUDIT4-STARTUP-FILES** | Shell startup files in the home (audit 4) | **decided (owner): close** | Closed to the file tools, judged by real path: `~/.bashrc`, `~/.profile`, `~/.bash_profile`, `~/.zshrc` and the other shell startup files, `$ZDOTDIR`'s zsh files, `~/.config/fish/conf.d` and `~/.config/environment.d`. The user edits them in their own editor. Audit 6 adds `~/.bash_aliases` and the folders `~/.bashrc.d`, `~/.config/fish/functions` and `~/.config/systemd/user`, closed too; files merely sourced by a startup file are not closed in general, since that set is unbounded. Code: `userClosedFiles` in `tools/hooks/mounts-lock.mjs`. |
| **D-AUDIT5-CORE-LINK** | Shell writes over the core link and over settings (audit 5) | **decided (owner): accepted gap** | The shell replacing, moving or removing the `oikos/` core link (`ln`, `mv`, `rm`), and shell writers over settings (`cp`, `sed -i`), stay accepted gaps: task L5 residuals (ADR 0007 D02). |
| **D-AUDIT5-GIT-C** | `git -c <key>=<value>` whose value writes, such as `core.pager="cat > file"` (audit 5, the owner's L3) | **decided (owner): accepted gap** | Same class as the single-string wrappers: accepted, task L5 residuals (ADR 0007 D02). The code carries the comment (`tools/hooks/common.mjs`). |
| **D-AUDIT5-FIXES** | The fifth audit's fixes (audit 5) | **no decision: restores accepted ADR text** | Built in the work tree, uncommitted, and recorded in ADR 0007 D02 without a new decision. M1 braces: sequences expanded exactly; a brace the guard cannot fully expand (past the cap, or nested past it) is judged like a too-wide glob (every mount below the folder before it). M2: a linear brace scan, a word-length cap before brace work, and one glob and expansion budget per command, shared across segments and inner `bash -c`/`eval`; a spent budget gives "every mount below" (measured: 1 MB commands judged in 0.1–1.3 s). L1: git abbreviated long options (three characters or more) matched only where git accepts them (`config --file`, `init`/`clone --separate-git-dir`, `checkout-index --prefix`); `diff`/`log --output`, `format-patch --output-directory`, `archive --output` and `fast-export --export-marks` are verified rejected by git and kept exact. L2: clustered short options of wrappers split (`strace -fo`, `ltrace`), and the wrappers `eatmydata`, `fakeroot`, `faketime` and `valgrind` added. L4: remote embeds matched across tab, LF and CR and their HTML entities, and SVG `feImage`, `image` and `use` `href` caught. L5: the mounts scanner judges unparsable files (block lists, `? key`, aliases, flow sequences, a list-shaped top level), with one `declaredMountKeys` for both files. L6: the dev exemption from the broken-home rule is by the host project's folder, not the cwd. L7: wide git places (`-C`, `--git-dir`, `--work-tree` globs) fail closed. U1, U2: `~name/` and brace expansion only on unquoted words, never in heredoc bodies. U3: a glob that matches a mount folder is not a mount write for an index- or tracked-only `git checkout -- <glob>`, `git restore` or `git rm --cached` when the git target is the installation (a mount is a separate, untracked repository). U4: git read forms allowed under a broken home (branch list, grep, `config --get`/`--list`, `remote [-v]`, reflog, stash list). `privilegeDenial` wrapped in `checked`. Found in verification: a `cd`/`pushd` target is expanded like any unquoted word (braces incl. sequences, globs, the shared budget); a target too wide to list marks its folder wide, and a git write in a command with a wide folder that holds or contains a mount is denied. Variables assigned in the command are substituted inside the program word (`${G}t`); a quoted part glued to a variable (`$G"t"`) is not, the same class as `$(which git)`. The residuals are accepted gaps of task L5 (ADR 0007 D02). |
| **D-AUDIT6-FALLBACK** | What a guard decides when its child dies from a signal, and the rest of the fallback (audit 6) | **decided (owner)** | A guard child killed by a signal the dispatcher did not send is treated like a timeout: any shell command and any file write denied, reads allowed. For other guard failures the fallback strips quotes and backslashes before matching, denies escalation words (`run0`, `sudoedit` among them), allows a git call only when its subcommand is on an inline copy of git-guard's read list, and denies a program word that is a variable expansion. Residual: a command that kills the dispatcher itself is decided by the host's handling of a dead hook (task L5). Audit 6b: any word starting with `$` and a letter is denied in the fallback, and `--output` on a git read. |
| **D-AUDIT6-FRONTMATTER-HOOKS** | Whether a file tool may write a skill, agent or command file whose front matter runs hooks (audit 6) | **decided (owner): B** | A file tool may not produce a skill, agent or command markdown file (under `.claude/skills`, `.claude/agents`, `.claude/commands`, in the project and in the user config dir) whose front matter has a top-level `hooks` key; a malformed front matter with a `hooks:` line is denied too. Front-matter hooks run a command outside every guard, the reasoning of D-AUDIT5-EXEC-KEYS. Rejected: A, close those folders to the file tools; editing skills is ordinary work. |
| **D-AUDIT6-CD** | The working-folder tracking of the shell guard: `cd` forms and nested shells (audit 6) | **decided (owner)** | The tracking also follows `CDPATH` assigned in the command (an unknown value makes a relative target wide), `cd`/`cd ~` with `HOME` assigned in the command, `function name { … }` definitions, and passes the reached folder into nested shells (`bash -c`, `sh -c`) and `find -exec`. `eval cd …` and `cd "$(…)"` are accepted residuals, the same class as `$(which git)` (task L5). |
| **D-AUDIT6B-SHELL-MODEL** | The shell guards as protection, not a boundary (audit 6b) | **decided (owner): A** | The shell guards (mount-shell, write-guard parsing) protect against mistakes and obvious forms; they are not a boundary. An agent can write a script file and run it (`sh f.sh`, `node f.mjs`), and no hook sees that text. Closed in audit 6b: a here-string fed to a shell is judged as an inner command; a shell reading its program from a pipe, `-s`, `<(…)` or `/dev/stdin` makes the folder unknown, so git writes and redirects in that command are denied; `-c --`; nesting past the depth cap is denied; the current folder is a bounded set of candidates (globs, braces, CDPATH, an assigned `HOME`); assigned variables and the wide list are passed into nested commands; `find -execdir`, and `-exec` with `{}` or positional parameters, are judged wide under find's start paths; `NAME+=` makes a variable unknown; `script -c`, `watch`, `busybox sh` and `fish -c` are nested shells; budgets cover inner judgements. Rejected: B, redesign the parser to fail closed on everything unseen (costly, and the script-file route stays). The real boundary is an OS-level sandbox: open task A12 in `_aitna/TASKS.md`. |
| **D-AUDIT6B-FRONTMATTER** | How the skill front matter is parsed for hooks (audit 6b) | **decided (owner): A** | The front-matter block is parsed with the `yaml` package, merge keys on and duplicate keys an error. A top-level own key `hooks`, a parse error, or a top level that is not a mapping is denied. YAML is a superset of JSON, so a one-line JSON or flow front matter is covered by the same parse. A skill folder reached through a symlink is judged too. Rejected: B, deny any word `hooks` (false denials on skills that mention hooks). |
| **D-AUDIT6B-PLUGINS** | File tools and the user's plugins folder (audit 6b) | **decided (owner): A** | File tools may not write under the user config `plugins` folder (`~/.claude/plugins`, or `$CLAUDE_CONFIG_DIR/plugins`). Plugin hooks and servers run outside every guard, and the user installs plugins through the host. Rejected: B, accept as a gap. |
| **D-AUDIT6B-SHELL-SKILLS** | Shell writes of skill, agent and command files (audit 6b) | **decided (owner): accepted gap** | Shell writes (`mv`, `cp`, `ln`, `tee`, `sed -i`, redirects) of skill, agent and command files are the same accepted class as shell writes over settings (D-AUDIT5-CORE-LINK): task L5 residuals (ADR 0007 D02). |
| **D-AUDIT6B-NESTED-PUSH** | git-guard's ask on `git push` inside nested commands (audit 6b) | **decided (owner): deferred, watch in practice** | git-guard's ask on `git push` is not applied inside nested commands (`bash -c "git push"`, `eval`, `… \| bash`). Not fixed for now; revisit if it shows up in practice. No task. |
| **D-S4-ANCESTOR** | The search scope above the installation: the clause "unless it stays inside this installation's mounts" (ADR 0007 D05; re-audit F10) | **decided (owner, 2026-11-04): drop the clause; accepted gap L6** | The built rule denies every search whose scope is an ancestor of this installation's root, with no exception for a mount (`readDenial` in `tools/hooks/package-guard.mjs`, `scopesOf` in `tools/hooks/mount-shell.mjs`), so the clause described nothing that is built. Accepted gap, task L6: a folder that holds another installation but is not above this one is searched without that installation being detected beyond the nested-installation search (depth 2, at most 100 folders), and `list_directory` of a parent folder lists names (it is not a search tool). Rejected: scanning every scope for installations. |
| **D-S6-RULES-FORMAT** | The format of `wiki.rules`, the vault's note rules | **decided (owner, 2026-11-04): as written here; built in S6** | A markdown file whose YAML front matter holds: `required` (front-matter keys a new note must have; checked on `create`); `language` (`en`, `english`, or a tag starting `en-` or `en_` turns the language check on, any other value leaves it off); `allow` (kinds of executable content the vault allows, the keys of `EXECUTABLE_KINDS` in `tools/common/outgoing.mjs`: `dataviewjs`, `inline-js`, `template-tag`, `script`, `iframe`, `remote-embed`; a kind not listed is refused on every write). No front matter means no rules. Refused, a usage error with nothing written: an unknown key, an unknown kind, a value that is not a list of names, front matter that does not parse or is not a mapping, a configured file that is missing or outside the vault. The body is free prose for people. Code: `noteRules`, `vaultRules`, `checkRequired` in `tools/common/vault.mjs`. |
| **D-S3-PREFIX** | The skill pointer prefix | **decided (owner): as recommended; built** | Default: the mount folder's name slugified; the prefix matches `^[a-z0-9][a-z0-9-]*$` (`tools/common/slug.mjs`); the whole pointer name is at most 64 characters, else a problem and only that pointer is skipped. |
| **D-COMMIT-OPT-IN** | The name of the key that lets a personal inside mount's pointers be committed | **decided (owner): `skills.tracked`; built** | `skills.tracked: true`, setup flag `--tracked-pointers`; replaces `skills.commit`. Rejected: `skills.commit`. |
| Q1 | Qwen Code: context-file loading across a `.git` boundary, an exclude setting, skills from a subfolder | open | Until known, Qwen gets items 3 and 4 and the guards wired in `.qwen/`, not items 1, 2 and 5. Codex gets item 3 only and no oikos guard at all (`.codex/hooks.json` holds only akmon's hooks; ADR 0007 D03, task L5). |
| Q2 | A mount's own skills load lazily next to the pointers (no switch), so a skill may be listed twice | leaning | Accept; the prefix keeps the names apart. Check live. |
| Q3 | `<mount>/.claude/settings.local.json` read at the submodule's root | open | Check live: settings.local.json follows the git root since v2.1.211. |
| Q4 | Shell coverage: the known gaps of L2 (globs, `find -exec`) and other writing programs | decided (owner): accepted gap | Accepted with D-A9-AUDIT2-GAPS, task L5; the file tools and the `vault` tool are the main routes. |

## Rejected (candidates)

- **`--add-dir` per session, no mounts.** Skills come and rules do not, but it is per session and
  per host and nothing is written down; leaks 2 and 3 are untouched and there is no write guard.
- **Shared `claudeMdExcludes` in the committed `.claude/settings.json`** with relative globs
  (`**/vault/**/CLAUDE.md`). Globs over absolute paths with a bare `**/` match far outside the
  installation, and the mount side needs a file in the mount anyway. *Revisit if* the hosts accept
  project-relative patterns.
- **Let the mount's framework write its own ancestor exclusions** ("rules stop at my git root").
  Good and general, and a framework may do it; oikos still writes item 2, since it knows which
  ancestors are its own.
- **One wiki per installation.** Rejected by the owner: several vaults are mounted.
- **A separate `personal-terms` file** (first draft). It would duplicate `.local/outgoing.yaml`
  (D-A9-LEAK). *Revisit if* the terms for mounts must differ from the terms for outgoing text.
- **`write: allow | deny` per mount** (first draft). Replaced by D-A9-VAULT-WRITE: an installation
  writes only into itself, and notes go through the `vault` connector.
- **Scopes inside one installation's `.local/`**, the installation's env-scopes handoff:
  `.local/work` and `.local/personal` as two repositories, a store resolver, `--scope` per item.
  Rejected by the owner: the root is the work repository, `.local/` is never one, and private
  material lives in a separate installation (§ Linked installations). *Revisit if* a separate
  installation leaves a gap.
- **A transfer's findings only advise** (D-A11-TRANSFER-REFUSE B). Short of "no leak in either
  direction": the write guard sees only that a dry run came first. *Revisit if* false findings on
  transfers become common and an `allow:` line is too coarse.
- **A binary transfer with the dry run saying its content was not checked**
  (D-A11-TRANSFER-BINARY B). *Revisit if* binary material must move between installations.
- **Executable note content, or the guard files, left as accepted gaps** (D-A9-NOTE-EXEC B,
  D-A9-GUARD-FILES B). Both checks are cheap, and Obsidian and an unlocked guard act outside every
  hook.

## To verify (live, by the owner)

- A session in each mount shows none of the installation's files in `/memory`.
- An installation session that read a mount's file shows none of the mount's rule files.
- Q1 Qwen; Q2 duplicate listing; Q3 settings read at a submodule's root.
- `claudeMdExcludes` matches a mount reached through a symlink: logical path or real path.

## Tests (each fails without the change)

A temporary installation with three `git init` mounts: two wikis (one nested, `vaults/team`, and
one outside, in the local layer), a skills mount, and a second installation beside it.

- `sync` wiring:
  - `sync` writes items 1–3 with absolute paths only in local files; a second run changes nothing;
  - a user's own `claudeMdExcludes` entries and other keys stay; removing an entry keeps its
    wiring with a note, and `sync --prune` removes exactly that wiring;
  - a mount's `settings.local.json` lands in its `.git/info/exclude` when not ignored.
- `sync --check` is red for: a missing mount, a mount under `.local/`, overlapping mounts, two
  wikis with one name, two defaults, stale wiring.
- Skill pointers: the prefix, the marker, removal with the entry; no absolute path in a committed
  file.
- `config()`: a local entry replaces the shared entry of the same path; `skills.only` keeps only
  the listed skills; an unknown name there is a problem.
- The write guard:
  - denies Edit/Write, a shell redirection and `git -C <mount> commit` into every mount, a wiki
    mount included;
  - denies a file-tool edit of `.local/{mounts,outgoing}.yaml`, `.local/sync.json`, and of the
    `hooks`, `disableAllHooks`, `claudeMdExcludes` keys of the host settings files;
  - denies a write reached through a link, a `..` after a link or a case variant of a mount path;
  - allows reads.
- The leak check of the `vault` connector:
  - refuses a note that names the installation's root, a `.local/` path or a
    `.local/outgoing.yaml` term, also when the term is split by emphasis, a zero-width character
    or a line break;
  - refuses a note that names oikos, unless the mount sets `mention_assistant: allow`;
  - refuses a `dataviewjs` block, `$=`, `<%`, `<script>`, `<iframe>` or a remote embed unless
    `wiki.rules` allows it;
  - refuses a target under `skills.from`, a `SKILL.md`, a dot folder, a rule file, a link out of
    the mount, a hard-linked note;
  - ignores an `allow:` entry shorter than 8 characters and lists each line an entry let pass;
  - passes a clean note.
- The boundary (A11):
  - a read of an unregistered installation is denied, a read of a registered one is allowed;
  - a search scoped above the installation root and a shell command naming an unregistered
    installation are denied;
  - a write into either is denied;
  - `setup transfer --dry-run` lists the findings of both installations' terms and writes
    nothing; a finding refuses the real run; a binary source, a source in a closed store or
    `.env*`, and a `--to` outside this installation or into a guarded place are refused.
- `git-guard` takes the target repository from `-C`, `cd`, `--git-dir`, `--work-tree`, `GIT_DIR`
  and `GIT_WORK_TREE`; submodule recursion, `clean -ff` and a read with `-c` count as writes.
- The `vault` tool:
  - search across both wikis with the wiki named per hit, and with `--wiki`; read;
  - create in the default wiki and in a named one, from the template, with the frontmatter
    checked;
  - a note with a secret or a leak term is refused.

## Files the change touches

`tools/common/config.mjs`, `tools/common/paths.mjs`, `tools/sync/cli.mjs`, `tools/sync/mounts.mjs`
(new), `tools/hooks/shell.mjs` (new), `tools/hooks/package-guard.mjs`, `tools/hooks/git-guard.mjs`,
`tools/hooks/leaks.mjs`, `tools/hooks/session-start.mjs`, `tools/hooks/writes.mjs`,
`tools/hooks/mounts-lock.mjs` (new), `tools/common/outgoing.mjs` (derived and linked terms, the
`allow:` rules, normalisation), `tools/common/slug.mjs` (new), `tools/common/mount-config.mjs` and
`tools/common/mount-skills.mjs` (new), `tools/setup/cli.mjs`, `tools/setup/mount.mjs` (new),
`tools/landscape/cli.mjs`, `tools/vault/cli.mjs` (new), `tools/common/yaml-splice.mjs` (new, the
splicer moved out of `tools/common/tracking-config.mjs`),
`skills/wiki/SKILL.md`, `skills/wiki/connectors/vault.md` (new), `examples/installation/oikos.yaml`,
OIKOS.md, DEVELOPMENT.md, BOOTSTRAP.md, tests.
