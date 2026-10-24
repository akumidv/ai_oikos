# Developing oikos

Read this file **only when the task is developing oikos itself**: its skills, connectors, tools,
OIKOS.md, AGENTS.md or this file. Ordinary use of oikos needs only [OIKOS.md](OIKOS.md).

## What oikos is, and what is still open

oikos is a public, standalone project: an agent toolkit for a CTO or manager working with their
organization's resources. The repository holds only what is useful to any user; everything about
one organization is the **installation's** — a folder per organization or project that holds
oikos as `oikos/` (a symlink or a git submodule), imports `oikos/OIKOS.md` from its own
`AGENTS.md`, keeps `oikos.yaml`, `resources/`, `LANDSCAPE.md` at its root and what belongs to
one machine and person — paths, secrets, the catalog, the browser profile — in its git-ignored
`.local/`.

- **Skills are kinds of work, connectors are services.** A skill (`code-hosting`,
  `task-tracking`, `wiki`, `messaging`, `workspace`, …) carries the know-how that does not depend
  on the service; each connector under it (`gitlab`, `github`, `jira`, …) teaches one tool. A new
  service for an existing kind of work is a new connector, not a new skill.
- **Nothing that names an organization.** No hosts, projects, people, task keys, brand or
  workflow in code, skills or docs — examples use `PROJ-123`, `example.com`, `ACME Corp`. What
  differs per organization is read from the installation's configuration (`settings`,
  `connectors`, `organization`, `mcp_servers`, `brand`) or described in its `resources/` and
  `AGENTS.md`.
- **One core, many installations.** One checkout of oikos may serve several installations at
  once through symlinks, so a tool finds the installation from where it runs — never from where
  its own code lies — and keeps nothing of one installation inside the core.
- **Users' environments differ**: Windows; Linux (Ubuntu), both with a graphical session and
  without one (a server, SSH); WSL with Windows; macOS. Without a display a window the user would
  look at is not there: Chrome runs headless and the agent describes the page. A tool
  identifies the environment with `environment()` (`common/env.mjs`: os, wsl, display) and
  configures itself by it, rather than assuming one — which Chrome mode, where to look for
  installed programs (`common/programs.mjs`: PATH and `/opt` on Linux, `/Applications` on
  macOS, the registry's App Paths on Windows and, under WSL, on its Windows side). Every
  tool, skill and scenario works in all of them: paths through `node:path`, platform checks
  through `node:os` and `isWsl()`, programs found through `common/programs.mjs`, nothing that
  assumes one machine, shell or folder layout. A change is checked at least on the platform at
  hand and reasoned through for the others.
- **Principles**: skill = know-how, tool = the executable; read-only and dry-run by default,
  changing actions only on the user's command.

## Session start for development

oikos is developed **in the core repository**, in a session started there: that session is in no
installation, and oikos's own files may be changed. In an installation `oikos/` is read-only — the
`package-guard` hook denies Edit/Write of any path that really is in the core (through the
`oikos/` link or by its own path), so every installation keeps a clean checkout and updates stay a
plain `git pull`. Where a session is decides, not a flag: the session-start hook says which.

The tools need an installation to run against. To try one from the core, point it at an
installation: `OIKOS_HOME=<installation> node tools/<tool>/cli.mjs …`, or run it from that
installation as `node oikos/tools/<tool>/cli.mjs …`.

1. Read AGENTS.md, OIKOS.md and this file.
2. Read the development backlog `_aitna/TASKS.md`, if present
   (`- <id> · <title> · <status> · <goal ≤12 words> · [detail](link)`; status
   `active | blocked | deferred | done`). It is public: no organization or person in it.

## Layout

```
AGENTS.md              the core repository's entry point: what it is, where to read on
OIKOS.md               how to use oikos — imported by an installation's AGENTS.md (@oikos/OIKOS.md)
BOOTSTRAP.md           installing, setting up, updating oikos on a machine
DEVELOPMENT.md         this file (loaded only for development)
CLAUDE.md              only @AGENTS.md — never imports DEVELOPMENT.md or an installation's files
examples/installation/ an installation of ACME Corp: what one looks like, and the fixture of the tests
tests/                 npm test: installations in temporary folders, isolation checked
QWEN.md                where this host's wiring is; repeats no AGENTS.md text (Qwen reads it itself)
skills/<name>/SKILL.md the skills, one per kind of work (source of truth)
skills/<name>/connectors/<connector>.md  how the skill drives one service's tool
skills/<name>/connectors/<connector>/<file>.md  a connector's routes, or topics read only for one scenario
skills/<name>/scenarios/<scenario>.md  typical tasks, step by step; indexed in the SKILL.md
tools/<name>/cli.mjs   the tools — one per connector or capability
tools/<name>/package.json  a tool's own dependencies, installed on first use into
                       tools/<name>/node_modules (git-ignored); see Writing a tool
tools/common/          shared modules; paths.mjs has the two roots (the core, the installation),
                       config.mjs reads the installation's oikos.yaml, landscape.mjs is the one
                       reader of skills, connectors and resource notes
tools/landscape/cli.mjs  resources | skills — the overview, computed on request
node_modules/          npm dependencies (npm install); .cache/oikos/ holds programs a tool's
                       `install` put into the project (LibreOffice, Chrome for Testing)
tools/setup/cli.mjs    setup status | init [dir] | token — the executable side of BOOTSTRAP.md
tools/handoff/cli.mjs  park | list — a work package parked in .local/<key>/ for another session
                       (ADR 0005): files copied, HANDOFF.md skeleton, the .local/TASKS.md line;
                       a local write, previewed unless --yes, not in writes.mjs
tools/hooks/           the guards of every agent host, fail open, shell parsing in common.mjs;
                       one entry point, host-hook.mjs <guard>:
                       session-start (says whether the session is in an installation or in the
                       core, points at BOOTSTRAP when not set up, adds the catalog summary); write-guard (dry
                       run + user answer before a write of a tool in writes.mjs, an allow-list:
                       only `node oikos/tools/<tool>/cli.mjs <verb> …` alone; writes.mjs is checked by
                       npm run check); git-guard (no `add -A`/`commit -a`/sudo, ask before push
                       and MR/PR — deny outside the default mode; in the core no commit whose
                       staged tree names a private term — leaks.mjs); secret-guard (no file tool
                       and no shell argument on a non-template .env* file, or on a closed store of
                       .local/ — a first name there starting with `.` (.env, .secrets/, .browser/)
                       or a legacy one (browser/, google/), ADR 0002; no search scope over .local/
                       as a whole, no glob or `--include`/`--glob` pattern reaching one of them,
                       no printing the environment; any other name in .local/ is open); context-pressure
                       (85%/95% of a 200k working ceiling, OIKOS_CONTEXT_WINDOW overrides);
                       wired on UserPromptSubmit and, before a subagent starts (Claude `Task|Agent`,
                       Qwen `agent`), on PreToolUse — the reply names the event it answers;
                       package-guard (in an installation no Edit/Write of a path that really is in
                       the core — node_modules stays free)
tools/hooks/leaks.mjs  the private terms (~/.config/oikos/private-terms, never in the repository)
                       against the core's staged tree; `install` makes it the git pre-commit hook
tools/hooks/host.mjs   the tool vocabularies of the hosts: what a call *is* (shell, file write,
                       file read) and which paths it names — the only place a guard
                       spells a host's tool names
tools/hooks/wiring.mjs which guard listens to which event and matcher of which host, and the
                       command line of each: the source of both settings files
.claude/settings.json  the core repository's own Claude Code wiring: its hooks only — no skill
.qwen/settings.json    pointers and no MCP servers, since oikos is developed here, not used.
                       oikos's entries of the `hooks` key come from wiring.mjs (`npm run sync`,
                       drift fails `npm run check`); every other entry and key belongs to the
                       host, the person or another tool (akmon)
extension/             the Chrome extension users load unpacked: popup, per-site helpers
                       (sites/<site>/content.js) from the one table in common/helpers.js;
                       extension/README.md; npm run check checks its manifest and scripts
```

An installation is the other half (examples/installation, OIKOS.md § What lives where): at its
root `AGENTS.md`, `oikos.yaml`, `resources/`, `LANDSCAPE.md` and `oikos/`; in its git-ignored
`.local/` what belongs to one machine and person — AGENTS.md (paths), .env, catalog.yaml, browser/
(Chrome profile), google/, sync.json (the MCP servers sync wrote). `sync` run there writes its
wiring: skill pointers `.claude/skills/<name>/SKILL.md` → `../../../oikos/skills/<name>/SKILL.md`,
hooks `$CLAUDE_PROJECT_DIR/oikos/tools/hooks/host-hook.mjs`, `.mcp.json` with this machine's
absolute paths and `OIKOS_HOME`, and the core's real path in `permissions.additionalDirectories`
of `.claude/settings.local.json`. It replaces only what it wrote: a pointer carries its marker,
a hook command names `tools/hooks/`, an MCP server is listed in `.local/sync.json`.

## Writing a skill

A skill is a **kind of work**, not a service. `skills/<name>/SKILL.md`, English, frontmatter:

- `name` — equals the folder name;
- `description` — what it does and when it triggers, with example phrases; it names the
  connectors only as examples ("the connector (GitLab, GitHub) comes from the configuration");
- `metadata: { owner: oikos, group: <group> }` — `group` is one of `GROUPS` in
  `tools/common/landscape.mjs` (engineering, collaboration, files, web, hr); `npm run check` fails
  on a missing or unknown one, and `npm run skills` lists the skills by it. A skill that fits no
  group gets a new entry in `GROUPS`, with its description, in the same change;
- `when_to_use`, `surface` (what it reaches), `connectors` (the connector files
  under it; none for a skill that works by itself — `documents`, `browser`, `catalog`, `cv`, `footprint`), `refuses`
  (what it will not do and where that goes instead).

The body holds what is true for every connector: the rules, the confirmations, how to report —
and a `## Which connector` section: `node oikos/tools/landscape/cli.mjs skills <name>` shows the
connectors the installation uses (`connectors.<name>` in `oikos.yaml`, first = default), the user's words
pick another, and a table points at each `connectors/<connector>.md`.

**Connectors.** `skills/<name>/connectors/<connector>.md` (no frontmatter) teaches one tool:
commands, the order of steps, the guards, credentials and settings. Commands are written as
`node oikos/tools/<tool>/cli.mjs …`, run from the installation's root. A connector with several routes (google:
browser, IMAP, drive folder, …) keeps them in `connectors/<connector>/<route>.md`; so does a
connector with a topic only one scenario needs (jira: transitions, project setup), as
`connectors/<connector>/<topic>.md`, so the everyday reads do not load it. `npm run check`
fails when a listed connector has no file, a file is not listed, or `oikos.yaml` names a
connector a skill does not have (checked when run with an installation).

No organization in either: no hosts, projects, task keys, people, brand, workflow (those go to
the installation — its `resources/<id>.md`, `AGENTS.md`, `settings`, `brand`), no personal paths
or secrets, nothing tied to one machine.

**Scenarios.** A typical task with its own sequence of steps (a new document from an existing
one, …) goes into `skills/<name>/scenarios/<scenario>.md`, not into the SKILL.md body. The
SKILL.md keeps a `## Scenarios` table — scenario, when it applies, which file to read — so an
agent loads only the scenario it needs. After adding or renaming: `npm run sync` and `npm run check`. No list of the skills is kept
anywhere by hand — OIKOS.md points at `npm run skills`.

## Writing a tool

`tools/<name>/cli.mjs` — Node.js ≥ 22, ES modules. Built on `tools/common/`:

| Module | Owns |
|---|---|
| `cli.mjs` | commands on `util.parseArgs`, `--json`/`--help` everywhere, error → exit code, the proxy re-exec, the connector check (`requireConnector`) |
| `http.mjs` | every outward request: named User-Agent, timeout, channel errors, Cloudflare detection; `download()` streams a large file (idle timeout, `.part` until complete) |
| `paths.mjs` | the two roots: `CORE_ROOT` (the code, from `import.meta.url`) and `installRoot()` (`OIKOS_HOME` → `CLAUDE_PROJECT_DIR`/`QWEN_PROJECT_DIR` → the working folder and its parents); `localPath()` for `.local/`, throwing outside an installation; `LOCAL_STORES` and `localStorePath()` — a tool's store under its dot name, or at its legacy place until sync moves it (ADR 0002) |
| `local-stores.mjs` | the move of the stores in `.local/` from their legacy places to their dot names (`moveLocalStores`, run by sync; the browser profile only while its Chrome is stopped) |
| `env.mjs` | settings and credentials: `.local/.env` → `settings` of `oikos.yaml` → environment (a fallback shared by every installation); presence only, never values; `orgEmail()`, `orgGitEmail()` (the git email, only inside a configured domain); `isWsl()`, `environment()` — os, wsl, display |
| `config.mjs` | the installation's `oikos.yaml`: organization, connectors per skill, settings, MCP servers, brand, task-tracking |
| `transitions.mjs` | a tracker's status transition rules (`task-tracking.<connector>`, ADR 0001): the structure check, every problem with its path, and the rule a move falls under (`resolveTransition`) — shared by the tracker connectors |
| `pullrequests.mjs` | the pull requests of a task (ADR 0001 D05): PR/MR URL parsing, the key and its aliases as a whole token, the pool search per repository through `github.mjs` / `gitlab.mjs` (and the extended set's, D08, when the caller passes it), a bare number in `number_repos` and the commit search when nothing is found (D11), `--skip-pr` (D12), de-duplication by URL, the dry run's `## Pull requests` lines and the comment posted with a move — best effort, shared by the tracker connectors |
| `tracking-config.mjs` | the one editor of a tracker project in the installation's `oikos.yaml` (`task-tracking.<connector>.projects.<KEY>`, ADR 0001 D07): lists grow, prose is replaced, a missing block is created; the change is spliced into the source so every other byte and comment stays, re-parsed and validated before an atomic write |
| `project-setup.mjs` | what `<tracker> project-init --dry-run` reports: the workflow laid against the rules, key alias candidates, pool candidates by activity under an owner and by name pattern (GitHub; GitLab named as not searched) — shared by the tracker connectors |
| `outgoing.mjs` | the one content check of what a write sends (ADR 0003): `outgoingFindings(text, rules)` (pure: `language`, `assistant`, `path`, `secret`, `term`), `outgoingRules()` (the built-in patterns plus the installation's `.local/outgoing.yaml`: `terms:`, `allow:`), `guardOutgoing(texts, values, rules)`, `uploadedMarkdown` (an uploaded image line as the service sees it), `nonLatinLetters` |
| `files.mjs` | a path the user gave that does not exist: the similar files or folders that were probably meant (`missingMessage`) |
| `local-files.mjs` | the path rule for a local file a tool carries elsewhere — `jira attach` and image lines upload it, `handoff park` copies it: its real path inside the allowed roots (`fileRoots`), never a closed store of `.local/` (`closedStore`), an `.env*` file or a dot-named entry outside a working folder of `.local/` (`dotComponent`); `pathProblem` / `nameProblem` say why, `localFile` judges one typed file |
| `programs.mjs` | external programs a tool drives (LibreOffice, Chrome): explicit `OIKOS_*_PATH` → system install → a copy in `node_modules/.cache/oikos`; missing shared libraries (ldd) |
| `atlassian.mjs` | the shared Jira/Confluence identity and client |
| `adf.mjs` | Atlassian Document Format ↔ text/markdown (`[~accountid:ID]` is a mention) |
| `diff.mjs` | a line diff for compact dry runs |
| `governance.mjs` | merged PR/MR totals and CODEOWNERS rules, the same on every code host |

Rules:

- **Two roots.** What is oikos's — skills, tools, programs a tool installed, its node_modules — is
  under `CORE_ROOT`; what is the installation's — `oikos.yaml`, `resources/`, `.local/` — under
  `installRoot()`, never derived from where the code lies (Node resolves the `oikos/` symlink, so
  `import.meta.url` is always the core). A path of the installation is a function evaluated when
  used, not a constant at import, so `--help` and `npm run check` work in the core. A module that
  is both imported and run checks `isMain(import.meta.url)` (`common/cli.mjs`), never
  `import.meta.url === file://argv[1]`: through the link the two differ.
- **A new secret or store goes under a dot name in `.local/`** — credentials files under
  `.local/.secrets/<tool>/`, a tool's own state (a profile, a cache) under `.local/.<name>/`, tokens
  in `.local/.env` — declared in `LOCAL_STORES` (`common/paths.mjs`) and reached through
  `localStorePath()`, with its old place as `legacy` when it moves. The secret guard closes a dot name by
  itself, so nothing is added to it; any other name in `.local/` is the user's working material and
  open to the agent ([ADR 0002](docs/adr/0002-local-stores.md)).
- Read-only by default. A changing action has `--dry-run`.
- **A connector's tool runs only where it is listed.** Its entry is `runCli('<tool>', commands,
  { connector: '<name>' })`: before a command runs, `requireConnector` (`common/cli.mjs`) throws
  `UsageError` (exit 1) unless the installation lists the connector under some skill in
  `connectors:` — before any credential lookup or request, so a token from the shell reaches only
  the installations that use the connector. Usage and `--help` print without the check; outside an
  installation it is the no-installation error. Tools that are not a connector (landscape, catalog,
  browser, documents, footprint, handoff, setup, sync, hooks) pass no `connector`. The same list decides the rest:
  the tokens `setup` and the session-start hook ask for (`setup/tokens.mjs` `needed`) and the
  connectors `landscape skills` shows as used — nothing listed, for a skill or at all, means no
  connector, never every one.
- Missing credentials or site settings are an error, the same in every connector: the command
  throws `UsageError` (exit 1) naming each missing key (`credentialsHelp`) before any request —
  never a fallback to a dry run, never exit 0. Only an explicit `--dry-run` whose preview reads
  nothing from the site still runs without them, and says the write itself needs them. The guards (the content check, Jira transitions only among the
  statuses open to an agent, Confluence read-modify-write guards) are kept.
- **Every write that sends text calls `guardOutgoing`** (`common/outgoing.mjs`) once, with every
  text it sends — title, body, heading, a move's comment, a `--file`'s content, an image's name and
  alt text, a text attachment — in the dry run and the real run alike, before any upload or write,
  with the rules read once by `outgoingRules()` at the command. The command takes
  `--allow-non-english` and `--allow-flagged` (in both runs, so the confirmed command is the one
  that showed the findings); `--force` stays the lossy-content override. A tool keeps no check of
  its own. `project-init` and `repos` write only `oikos.yaml` and are not checked;
  `tools/outgoing/cli.mjs check` is the same check, read-only, for routes no tool writes.
- Every request goes through `common/http.mjs`, never a bare `fetch`.
- Output is for an agent's context: compact lines, what was cut is stated, `--json` for the raw
  payload. Name the cause of a failure (no channel / rejected token / no access), never a guess.
- Exit codes: 0 ok, 1 usage, 2 remote error, 3 refused by a guard — stderr starts `refused: …`;
  the documented prefixes tell the next step apart: `refused: content check:` (fix the text, or
  override, ADR 0003), `refused: policy:` (a move the tracker rules refuse, ADR 0004); a flagged
  dry run exits 3 too, with `flagged: content check:`. A guard throws `GuardRefusal`
  (`common/cli.mjs`), whose message carries its prefix.
- **Dependencies**: an npm package is welcome where it is simpler and more reliable than our
  own code — especially for file formats (e.g. `fflate` for ZIP). Keep the balance: a small
  piece is written here rather than pulled in with a heavy package and its dependency tree.
  oikos runs as its own program, it is not a library linked into an installation's code, so a
  no-dependency rule does not apply.
  After cloning or pulling: `npm install`.
- **Where a dependency goes — installed only when the skill is used.** A user may never
  use a given skill, so `npm install` brings only what is shared or small:
  - the root `package.json` — small packages several tools use (`yaml`, `fflate`);
  - `tools/<name>/package.json` — a package only that tool needs, above all a heavy one. It is
    not installed by the root `npm install`; the tool's `install` command shows the plan
    (packages, size) and, with `--yes` after the user agrees, runs
    `npm install --prefix tools/<name>` into `tools/<name>/node_modules` (git-ignored). Commit
    its `package-lock.json` too.
  - Load such a package with `await import()` at the point of use, not a top-level `import`:
    the tool's other commands, `--help` and `npm run check` keep working without it. When the
    import fails with `ERR_MODULE_NOT_FOUND`, stop with a UsageError naming
    `node tools/<name>/cli.mjs install` — never install silently.
  - Node resolves `tools/<name>/node_modules` first, then the root one, so a tool sees both.
- **External programs** (LibreOffice, Chrome, …): use what the user already has; never install
  a second copy of something that is installed. Look it up through `common/programs.mjs`
  (which also has `toolDependenciesInstalled` / `installToolDependencies` for the rule above;
  `tools/browser` `install` is the example):
  explicit path, the system install, under WSL also the Windows side (registry App Paths).
  Only when nothing is found, and with the user's agreement, offer two ways: the user installs it with their system,
  or the tool's `install` command puts a copy into the project (`node_modules/.cache/oikos`) —
  a plan by default, `--yes` after the user agrees, never sudo; missing system libraries are
  named with the command for the user to run. Direction: one `setup` step (BOOTSTRAP.md) runs
  `npm install`, looks each program up and offers these two ways, so a new machine is ready in
  one pass; until then each tool's `install` is run on its own.

## Resources

An installation describes its organization's resources in its `resources/<id>.md` (never in the
core): note frontmatter (`id: business-resources-<id>`, `title`, `domain: business`,
`source_lang: en`, `tags`, `status`, `created_at`) plus the resource fields (`resource`, `kind`,
`network`, `url`, `auth` — `none|git|token|connector|browser|sso`, `auth_env`, `via` — the skills
or connectors that reach it), and a body with `## What it is for`, how to reach it, sign-in, rules
and how the organization uses it (boards, statuses, channels — what a connector file must not
say). Nothing is generated from the notes: `landscape resources` computes the overview when asked,
and `sync --check` fails on a note off the schema or a `via` naming no skill or connector. No
note at all is valid — a fresh clone has none. Never a secret value.

## Choosing the route to a resource

1. **API tool** (`tools/<name>/cli.mjs`) — where an API exists, a personal token is acceptable
   and the integration is safe.
2. **claude.ai connector** — where one exists (Google, Slack, Pipedrive, Figma): the oikos
   connector file is know-how over it, no token in oikos.
3. **Shared browser** (`skills/browser`) — no API, or an API that is not safe to hand an agent
   (compliance, finance, admin consoles). This is the general route and worth developing: new
   web resources start here.

## Checking a change

- `npm run check` — skills frontmatter and connector files, the core's own hook wiring, the hook
  files (`node --check`, because a hook that cannot load only fails open), the extension, the
  write-guard list. `OIKOS_HOME=<installation> npm run check` checks an installation the same way:
  its `oikos.yaml`, resource notes, skill pointers, settings and `.mcp.json`. It then runs oxlint
  (`npm run lint` alone) with akmon's rules (`.oxlintrc.json` extends
  `_aitna/akmon/profiles/oxlint.json`): an error fails the check. The project's own settings there:
  a one-line `if` may go without braces (Google §4.1.1's exception), and the size rules
  (`complexity`, `max-*`) only warn until the long functions are split.
- `npm test` — installations made from examples/installation in temporary folders: each reads its
  own configuration through the shared core, sync keeps foreign wiring, `oikos/` is read-only
  there, two installations never share a browser (and the browser's MCP server refuses another's
  Chrome), `setup init`, the leak check.
- Before a commit of the core: `node tools/hooks/leaks.mjs` (git-guard runs it on the agent's
  `git commit`; `node tools/hooks/leaks.mjs install` makes it the user's pre-commit hook).
- The development layer is akmon (`_aitna/akmon`, a submodule; the `## Dev layer — akmon` block of
  AGENTS.md): `node _aitna/akmon/js/akmon/cli.mjs sync` writes `CLAUDE.md`, `GEMINI.md`, `.codex/`,
  `.github/copilot-instructions.md`, its hooks in `.claude/settings.json` and the skill stubs in
  `.claude/skills/` and `.agents/skills/` (one per `skills/<name>`, so a skill added here needs it
  too; the Python entry `_aitna/akmon/bin/` refuses this node project); `--check` and
  `node _aitna/akmon/js/akmon/cli.mjs verify --strict` must pass, as in CI
  (`.github/workflows/akmon.yml`, with `npm run check` and `npm test`). Every file it generates
  is committed; the two syncs keep to their own entries in the shared settings. The backlog is
  [`_aitna/TASKS.md`](_aitna/TASKS.md), finished entries in `TASKS_ARCHIVE.md`, no dates.
- Run every changed command against the live service: reads for real, writes with `--dry-run`
  only. Never post to Jira/Confluence to test.
- A guard's decision is checked without a host: `echo '<payload json>' | node
  tools/hooks/host-hook.mjs <guard>` prints the JSON it answers, and the same payload with the
  other host's tool names must print the same decision.

## Agent hosts

oikos is used from more than one agent host (Claude Code, Qwen Code). They agree on the hook
envelope — event names, the payload fields, the JSON a hook answers, even `$CLAUDE_PROJECT_DIR`
as the project folder — and differ in four things, each with one owner:

| What differs | Where it is spelled |
|---|---|
| the folder of the skill pointers | `HOSTS` in `tools/hooks/wiring.mjs`, written by `npm run sync` |
| the settings file and its `matcher` vocabulary | same table; the file's `hooks` key is generated, the rest of the file is the host's |
| the names of the host's tools | `tools/hooks/host.mjs`; a guard asks what a call *is*, never what one host calls it |
| the usage shape in the session transcript | `tools/hooks/context-pressure.mjs` reads both |

A new host is an entry in `HOSTS`, a set of names in `host.mjs`, and nothing else; `npm run check`
then fails until its settings file is generated, so a host cannot be added half-wired. Both hosts
gate the wiring on the folder being trusted (Qwen Code: hooks and project skills of an untrusted
folder do not load at all), which `BOOTSTRAP.md § Set up` has the person confirm on the first start.
Qwen Code reads `.mcp.json` too, but uses a server only once it is approved (`qwen mcp approve --all`,
kept per folder and per server entry; a headless run skips an unapproved one silently), a step of
the same section. Reading through the `oikos/` link needs leave on both: Claude Code gets the core's
real path in `permissions.additionalDirectories` of `.claude/settings.local.json`, Qwen Code a
relative `oikos` in `context.includeDirectories` of `.qwen/settings.json` (it resolves against the
start folder and follows the link; without it every read through `oikos/` is refused) — sync adds
both in an installation, never in the core.

## Development experience

- 2026-10-21 — `.local/` was closed folder by folder (any folder there, except an allowlisted
  `resources/` nothing used), so a personal working folder such as `.local/cv/` could not be read,
  and the decision depended on whether the folder existed. The guard now decides by name only
  (ADR 0002): a first name under `.local/` that starts with `.` is a closed store, and so are the
  legacy `browser/` and `google/`; everything else is open. The check covers every file tool —
  before, Edit/Write into `.local/browser/` passed, because only the read tools were scoped. The
  Google sign-in moved to `.local/.secrets/google/`, the browser profile to `.local/.browser/`;
  sync moves an old store when the new place is free, the profile only while its Chrome is
  stopped, and the tools use the old place until then. A glob whose first name under `.local/` is
  a wildcard (`.local/*.md`, `.local/{cv,notes}/**`) stays closed, since it could match a dot name.

- 2026-10-17 — Installations (Phase 1). Run through an installation's `oikos/` symlink, four
  tools (catalog, browser, documents, google) did nothing and exited 0: their "am I the program"
  test compared `import.meta.url`, which Node gives with the link resolved, with `argv[1]`, which
  keeps it. Every path that mixed the two broke the same way, which is why the installation is
  found from the working folder and the host's variables, never from the code's location, and
  `isMain()` compares real paths. The core repository is not an installation and the tools say so
  instead of falling back to it — a fallback would quietly read one organization's data from
  another's session. `oikos.yaml` keys holding only comments parse as null, which `config()` had
  reported as "must be a mapping" for every fresh template.

- 2026-10-18 — The chrome-devtools MCP server attached to whatever answered on the port: `start`
  checked whose Chrome it was, the server did not, so a session could drive another
  installation's signed-in browser. The browser is now told by the installation's code (its folder
  name), read from the `--user-data-dir` of the process on the port — the profile is
  `<code>/.local/browser/chrome-profile` (`.local/.browser/` since ADR 0002), so the code needs no
  file of its own and also names another installation's Chrome. `checkPort` (`tools/browser/cli.mjs`) is the one check `start`,
  `status`, `stop` and `mcp.mjs` make; `mcp.mjs` refuses before spawning `npx`, on stderr and as
  the JSON-RPC error answering `initialize`, and exits 1. A profile set by `OIKOS_CHROME_PROFILE`
  outside that layout is not recognised as another installation's ("a Chrome not started by oikos").

- 2026-10-17 — The chrome-devtools MCP server timed out at session start (the host waits 30 s):
  `npx -y chrome-devtools-mcp@latest` through `cmd.exe` asks the registry on every start, which
  behind the proxy took 72 s with the package already cached. `mcp.mjs` pins the version and runs
  `npx --prefer-offline`: 2 s. Raising the version is an edit there; the first start after it
  downloads once and may miss the timeout — `/mcp` reconnects.

- 2026-10-15 — `extension/` hides Jira blocks (app panels, Agents) by their visible titles, not
  by Jira's test ids or classes: a block is the largest ancestor of its title holding no other
  known title, so the issue view's own section titles are listed as landmarks. Hiding is
  `display: none` plus holding the block's frames at `about:blank` — `display: none` alone still
  loads an app's iframe. Nodes are never removed, React would break. Built without access to a
  live Jira page (tested on a modelled DOM in jsdom); the popup's **Copy diagnostics** gives the
  real paths when a title or the layout turns out different.

- 2026-09-28 — The resource table in LANDSCAPE and `resources/registry.json` were copies of the
  notes, and the AGENTS.md skills table a copy of the skills' frontmatter: `registry.json` had no
  reader, LANDSCAPE is not loaded at session start, and the AGENTS table drifted (a new skill
  needed a hand-written row). All three are gone; `npm run resources` / `npm run skills` compute
  the overview on request from `tools/common/landscape.mjs`. Frontmatter is read by the `yaml` package, not a bracket-list mini-parser.

- 2026-09-28 — A path the user types is often a little off (the date of one invoice with the
  number of another). `common/files.mjs` suggests neighbours by edit distance within one edit of
  the best, follows a close folder with the rest of the path, and the message tells the agent to
  ask when there are several. Editing code with `String.replace(a, b)`: `$'`, `$&`, `$1` in `b`
  are patterns — a replacement containing `'~$'` pasted the rest of the file; use `split(a).join(b)`.

- 2026-09-28 — `documents replace --drop-row`: forms like invoices and acceptance reports are built of layout
  tables, so a phrase is inside several `<w:tr>` at once (the item row and the rows of the tables
  around it). Rows are matched by tag depth, not a non-greedy regex, and the innermost matching
  row is the one dropped; more than one innermost match is refused. `--in-place` backs the file up
  into the temp folder and writes through a rename.

- 2026-09-28 — A service-completion document is named an **acceptance report** in English, not
  "act" (a calque that reads as something else). The catalog examples are a project domain
  (`apollo` / "Project Apollo") with a client counterparty (`acme-corp` / "ACME Corp", tag
  `client`). Examples stay abstract (no real counterparties); the real data lives in each
  installation's catalog.

- 2026-09-28 — Development mode was on (`OIKOS_DEVELOPMENT=1` in `.local/.env`), yet the agent
  proposed changes and asked the user to switch it on: `secret-guard` keeps `.env` out of the
  agent's reach, so it cannot see the flag. The session-start hook now states the mode.
- 2026-09-28 — `tools/catalog`: YAML through the `yaml` package (no dependencies, keeps
  comments on rewrite). A document written from `{}` flow maps stays in flow style, so `save`
  turns every collection to block style. A synced disk rewrites mtimes, so files
  are ordered by the `YYYYMMDD` date at the start of the name, mtime only as a fallback.

Short dated entries about building oikos.

- 2026-09-28 — The Anthropic office skills (docx, pdf) expect `pandoc`, `zip`, Python with
  `defusedxml`, and a LibreOffice with `pdftoppm`; a fresh machine may have none of them.
  `tools/documents` covers .docx on Node: ZIP through `fflate`, text replacement is our own
  code, rendering through LibreOffice. `docxtemplater` and `mammoth` were considered — heavy,
  and built for other jobs (template tags, HTML export).
- 2026-09-28 — LibreOffice has no npm distribution (`libreoffice-convert` and similar only call
  an installed `soffice`). `documents install` unpacks the official `.deb` archive with
  `dpkg-deb -x` — no sudo. download.documentfoundation.org redirects to mirrors that can hang:
  `download()` aborts on an idle timeout and the next mirror from `<file>.mirrorlist` is tried.
  A Windows LibreOffice driven from WSL needs its input and `--outdir` on the Windows disk
  (`%LOCALAPPDATA%\Temp`, found with `cmd.exe /c echo` run with `cwd: /mnt/c` to avoid the UNC
  warning), paths passed through `wslpath -w`, and an ASCII name for the input copy; its
  "Could not find platform independent libraries" line is noise, not an error.
  Installing it (or Chrome) when the user already had one on the Windows side was a mistake:
  under WSL the Windows install counts as installed. A headless conversion needs its own profile (`-env:UserInstallation=`), or a LibreOffice
  window the user has open swallows it silently. PNG export renders only the first page.
- 2026-09-28 — Word splits visible text into runs (revision ids, spell-check marks), so a
  phrase is rarely one string in the XML. `documents replace` searches the joined `<w:t>` of a
  paragraph and puts the new text into the run where the match starts. `<w:tab/>` inside
  `<w:pPr><w:tabs>` is a tab stop, not a tab character.
- 2026-09-28 — `secret-guard` parses the body of a heredoc as shell commands: a comment naming
  `.local/.env` or a line `const set = …` in a file written with `cat <<'EOF'` is denied. Until
  the hook skips heredoc bodies, write such files with the Write tool.
- 2026-09-29 — `documents from-markdown` (a note → a policy-format .docx, `--pdf`) is built on
  the `docx` package (tools/documents/package.json), not pandoc: pandoc is often absent and has no
  title-page/brand control. Fonts are embedded through docx's `fonts` (one regular file per
  family; Word/LibreOffice synthesise bold and italic), and the Windows LibreOffice reads them, so
  the PDF has the brand faces without installing them. Brand assets are found through
  `OIKOS_BRAND_ASSETS` or the brand plugin folder named by `OIKOS_BRAND_PLUGIN`. Mermaid is not rendered by the tool (mermaid-cli pulls a
  Chrome); the missing figures' sources are written out and the scenario says how to render them.
- 2026-09-28 — A Claude Code background session cannot create a worktree while the repository
  has no commit yet, and its Write/Edit guard then refuses edits in the shared checkout.

- 2026-09-29 — Google APIs without a library: `tools/google` signs in with the user's own
  OAuth client (Desktop app; its "secret" is not secret for installed apps, but is kept in
  `.local/google/` — `.local/.secrets/google/` since ADR 0002 — next to the token anyway),
  loopback on `127.0.0.1:<random>` + PKCE S256 + `state`, `hd=<organization.email_domain>`, and refuses an `email` outside that domain from the id token. A Windows
  browser reaches the WSL loopback through localhost forwarding; with no browser on the
  machine the redirected address is pasted into the terminal. `HttpError` carries the URL,
  so no token ever goes into a URL (revoke sends it in the body). `secret-guard` denies
  `.local/google/`. Gmail bodies are base64url MIME trees; Drive needs `supportsAllDrives` +
  `includeItemsFromAllDrives` + `corpora=allDrives` to see shared drives; Docs export
  `text/markdown`. The route is **off** unless `OIKOS_GOOGLE_API=1`: a Google Cloud project per
  user is often not acceptable to an organization, so the browser is the main Google route.
- 2026-09-29 — Gmail without Google Cloud: IMAP with an app password (`tools/google/mail.mjs`,
  imapflow + mailparser as tools/google's own lazy dependencies, ~15 MB). Search the
  "All Mail" folder found by special-use `\All` (its name is localized), opened read-only
  (EXAMINE) so nothing is marked read; `X-GM-RAW` takes the Gmail search box syntax, UTF-8 words
  included; `X-GM-MSGID` / `X-GM-THRID` are the web interface's ids. Google shows the 16-character
  password in groups of four; the tool drops the spaces. Creating an app password makes Google send a
  "Security alert" mail.
- 2026-09-29 — Google Drive for desktop is a virtual drive on Windows (label "Google Drive",
  usually `G:`), and WSL does not mount it on its own: `tools/google drive` asks Windows for the
  drives (`Get-PSDrive` through `powershell.exe`) and names the `mount -t drvfs` command for the
  user. Its top-level folders are localised (`My Drive` / `Мой диск`), `.shortcut-targets-by-id`
  is not. A `.gdoc` holds `doc_id` (+ `resource_key`, `email`), the old Backup and Sync wrote
  `url`; Slides export by path (`/export/pptx`), Docs and Sheets by `?format=`.
- 2026-09-28 — Chrome refuses `--remote-debugging-port` on its default profile, so the user's
  everyday sessions cannot be shared: `start` runs a separate instance (own `--user-data-dir`, a
  new window; the user's open Chrome is never touched, `stop` closes only ours) and the user
  signs in there once. The profile lives in `.local/.browser/` (`.local/browser/` before ADR
  0002): `chrome-profile` for the user's own Chrome, `chrome-profile-project` for one `install` put into the project — cookies are
  encrypted per build, so the two are not mixed. Under WSL the Windows Chrome takes it through its
  `\\wsl.localhost\…` path, and the chrome-devtools MCP server must run on the Windows side
  (`cmd.exe /c npx …`), because WSL in NAT mode cannot reach Windows loopback.
  `tools/browser/mcp.mjs` does this; `status` probes the port through `powershell.exe`.
- 2026-09-28 — Chrome ignores `HTTPS_PROXY`; `browser start` passes the agent's proxy as
  `--proxy-server` and `NO_PROXY` as `--proxy-bypass-list` (`.domain` → `*.domain`). A Windows
  Chrome reaches a proxy listening on WSL's `127.0.0.1` through WSL localhost forwarding —
  verified: via the proxy an internal GitLab answers itself, directly it redirects to Cloudflare Access.

- 2026-09-28 — Node's fetch ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set at
  startup; without it an internal host behind Cloudflare Access answers with its login page (HTTP
  200, HTML). `common/cli.mjs` re-runs the tool with the variable set; `common/http.mjs`
  reports a Cloudflare Access redirect as a channel problem.
- 2026-09-28 — GitLab's MR `search` covers title and description, not the source branch, so
  `gitlab task` misses an MR whose key is only in the branch name.
- 2026-09-28 — A hook's `ask` reaches the user only in the default permission mode (it was
  measured as a silent no-op elsewhere), so `decide()` in `tools/hooks/common.mjs` turns it
  into a deny naming `! <command>` for the user. The guards parse the command into segments
  (executable position), so `echo "git push"` or `grep sudo` pass; `bash -c "…"` is not looked into.
- 2026-09-28 — The write guard is an allow-list: a Bash command that names a write tool (by path,
  by name, through a symlink or `cd`, or by a cli.mjs it cannot pin) and a write verb passes only
  as one plain `node oikos/tools/<tool>/cli.mjs <verb> …`, or as a read — readers (cat, grep, rg,
  `sed -n Np`, `git log|diff|show|status|grep|blame|commit`, echo), literal `cd`s and strict read
  calls, with no substitution and no redirection into a file. Everything else is denied, a guard
  failure included. So a heredoc, a loop or an inline test that names a write tool and a write
  verb is denied: write the script with the file tool and run the file. Not covered: a script
  file a shell runs (`bash x.sh`), a preload (`node -r`, `NODE_OPTIONS`) on a read, a copied
  cli.mjs, and `--file` contents that change between the dry run and the write. A new command with `--dry-run` must be added
  to `tools/hooks/writes.mjs`, or `npm run check` fails.
- 2026-09-28 — Jira search uses `/rest/api/3/search/jql` (token paging, no total); agile
  endpoints page with `startAt` and `isLast`/`total`.
- 2026-09-30 — Qwen Code reads `.mcp.json` and `AGENTS.md` (its `@` imports included) and **nothing under `.claude/`** — not the settings, not the skill pointers. An oikos
  clone was therefore running unguarded there, and looking fine: every guard fails open, so a hook
  that never fires and a hook that never matched look the same from the outside. The same is true
  inside a guard — comparing `payload.tool_name` with `'Bash'` is true-by-absence on the other
  host. Hence `tools/hooks/host.mjs` (what a call *is*) and `tools/hooks/wiring.mjs` (which host
  wires what), with both settings files' `hooks` generated from the one table.
- 2026-09-30 — The hook envelope is shared, the matcher vocabulary is not: Qwen matches the
  canonical snake_case name (`run_shell_command`, `write_file`), and an unanchored alternation
  written in Claude's names (`Edit|Write`) matches some calls and not others without saying so.
  Qwen expands `$CLAUDE_PROJECT_DIR` too, and answers the
  same `permissionDecision` JSON, so only the names are its own. Its permission modes are
  `plan|default|auto-edit|auto|yolo`; the existing rule "an `ask` outside `default` becomes a
  deny" carries over unchanged.
- 2026-09-30 — Qwen's transcript records `usageMetadata.promptTokenCount` (cached included) and
  the model's own `contextWindowSize`, not Anthropic's `input_tokens` + two cache fields. A hook
  that reads only the latter is inert on this host, so `context-pressure` reads both shapes and
  weighs the fill against the working ceiling capped by the model's window, never against 1M.
- 2026-09-30 — A broken hook is a silent hook: fail open prints a `systemMessage` and lets the
  action through, so the two syntax errors this port introduced were invisible until `npm run
  check` ran `node --check` over `tools/hooks/*.mjs`. That check is now part of `npm run check`.
- 2026-09-30 — `secret-guard` read only `file_path`/`path`, so a search could reach `.local/` two
  other ways. A folder below it (`.local/browser`, the Chrome profile) passed, because only
  `.local` itself was named; and Claude's `Glob` was neither in the tool vocabulary nor in the
  matcher, so the guard never saw it. A `grep_search` `glob` does not bypass `.gitignore` (tested
  with ripgrep, and Qwen adds `--no-ignore-vcs` only when `respectGitIgnore` is off), which is why
  the first reading of this as a live leak was wrong. The guard now checks the scope folder and the
  globs (`glob`, and `pattern` of the glob tools only — for `grep_search` it is a regex over
  contents and `\.env` in it is a normal query). Both branches, not just the file one: the shell
  argument had the same hole — `cat .local/browser/Default/Cookies` names a path *through*
  `.local/browser`, and only `.local` itself counted as a secret name. What decides is now the first
  name under `.local/`: a folder there is a store and nothing under it is opened, a file (the
  catalog, the backlog) is judged by its own name; `ls`/`stat` stay open through the metadata list.
  (Superseded 2026-10-21 by ADR 0002: a dot name decides, not a folder.)
  A glob naming a `.env` template is not a leak either — `isEnvFile` lets
  `.example|.sample|.template` through, so the glob rule makes the same exception rather than
  blocking what reading the same file allows. Closed with the same care, and none of them a live
  leak: the value of `--include`/`--glob` is judged as a glob (`grep x --include .env` chooses what
  to read, while `--exclude .env` leaves it alone and stays free); a relative scope is asked of both
  roots, the session's `cwd` and oikos's own, because a tool call may carry another `directory` and
  a check of one folder is not a check of a secret (since ADR 0002 the decision is by name, so only
  the session's `cwd` is asked); and a glob written with `\` separators matches
  like one written with `/`. What these close is the guard's own blind spots, not a route any skill
  walks.
- 2026-09-30 — A resource reached by the host itself (an MCP server, an authorised connector) is
  not a gap in the skills: `npm run resources` said "reached by no oikos skill" for the knowledge-base MCP server, which
  read as a missing skill and prompted writing a duplicate of AGENTS.md. The overview now names
  how each such resource is reached and keeps a separate list for the routes that are genuinely
  open.
- 2026-10-22 — The write guard looks for tool mentions by script position: a tool's name as a
  plain word (`for t in jira`) or an expanding path in a segment that only reads (`ls $P`,
  `grep x {a,b}.md`) is no longer a mention. Loop and `if` bodies, `cut/sort/uniq/tr/jq/nl/column`,
  `find` without actions, multi-range `sed -n`, any `cd` and bare assignments count as reads. A
  call of a script the guard cannot pin (`node oikos/tools/$t/cli.mjs --help`) is a read when its
  command word is a literal that is no tool's write verb.
- 2026-10-22 — Direct HTTP writes are denied: `curl`/`wget` with a writing method or a body to
  connected hosts (a fixed list plus the installation's `JIRA_BASE_URL`/`CONFLUENCE_BASE_URL`/
  `GITLAB_URL`/`GITHUB_*_URL`, read lazily through `env.mjs`) and `gh api` with a writing method or
  fields; read-only `gh api graphql` queries stay free. `gh` porcelain and `bash -c` text are not
  looked at (`bash -c` text is since the later 2026-10-22 entry on nested shells).
- 2026-10-22 — Long Jira texts flooded dry runs: over 2000 characters, the
  edit/create/description/comment dry runs print the size, the outline and a unified diff from the
  current description (or the first lines), via `common/diff.mjs` (Myers, no dependency, capped
  hunks). `--full` is display-only and accepted on the real run, because the write guard matches
  the real run to the dry run minus `--dry-run`. `search --count` uses
  `POST /search/approximate-count` (`/search/jql` gives no total).
- 2026-10-22 — `jira attach` uploads files through one path rule (`localFile`) that asks the
  secret guard's `isLocalStore`/`isEnvFile`: `.local/` working folders open, dot-named stores and
  `.env*` closed, and outside a working folder any dot-named component (`.mcp.json`, `.claude/`,
  `.git/`) refused — for image lines too. A type allowlist without archives (a zip could carry a
  closed store), 10 MB per file, attachments read back by id, exit 2 if one is missing.
- 2026-10-22 — `jira history` turns the changelog into moves by role (me / person / app; no
  author = automation), time in status (the current one up to now) and returns from review by the
  return rule (from `/review/i` to a non-review status the issue was in before, its initial status
  included — `In Review → QA` the first time is no return), per issue or as median/mean over a
  `--jql` selection. A changelog over 5000 entries is said TRUNCATED and its time is partial;
  `--json` carries moves and totals, `--raw` adds the raw changelog.
- 2026-10-22 — Repository governance (`github|gitlab governance`, `merged`): GitHub answers 404
  both for an unprotected branch and for a non-admin token, so the clients got
  `api(path, { absentOn404: true })` and the tool reports "not protected, or needs admin", never
  "not protected". `/repos/{r}/environments` returns an object, so it is read with `api`, not
  `paged`. GitLab `merged` reads `updated_after` and keeps MRs whose `merged_at` is on or after the
  date.
- 2026-10-22 — Shell commands that name a tool together with a write verb inside heredocs or
  scripts are still denied (their text is read as commands); write scripts with the file tool and
  run the file.
- 2026-10-22 — Accepted trade-off: a compact dry run is the default for long texts; the user
  confirms an outline + diff (create: outline + first lines), `--full` shows all — owner decision.
- 2026-10-22 — Write-guard fixes from an audit. `$?`, `$#`, `$$`, `$!`, `$-` are special
  parameters that expand to digits or option letters, not to a path, so `echo "exit=$?"` after a
  pipe is a read. A word-split variable holding a write call (`CMD='node …/cli.mjs comment …';
  $CMD`) had passed as a read: an expanding command word is now never quiet or a loose read, and
  any write verb in the text with an expanding executed word makes the command not a read.
- 2026-10-22 — Nested shells: the literal string of `bash -c`/`sh -c`/`zsh -c`/`dash -c` (also
  behind `timeout` or `env`) and the words of `eval` are classified as a command of their own, up
  to three levels deep. A read stays a read; an inner write is denied with "run it standalone", so
  that its dry-run signature can match; a string the outer shell expands is denied when it holds
  a write verb or an HTTP write option.
- 2026-10-22 — curl's config files are part of its command line: `-K`/`--config <file>` and the
  user's `$CURL_HOME/.curlrc` and `~/.curlrc` (unless `-q`/`--disable` comes first) are read for
  a method, a body or a host. A config that cannot be read (`-K -`, an expanded path, a missing,
  special or over-64 KB file) counts as a write, decided by the hosts on the command line.
- 2026-10-22 — Control words (`do`, `then`, `if`, `!`, `{`, …) are stripped in the shared segment
  prefix (`tools/hooks/common.mjs`), so git-guard and secret-guard see the command in `do git
  push` too, not only the write guard. The write guard's header now states its known limits —
  what the command text cannot show: `xargs -a`, a script written earlier and run now, globs to
  names prepared earlier (`node *`), environment variables, and `node -e` code.
- 2026-10-22 — Developing the guard under its own hook: install a new version through the
  scratchpad (write it there, `node --check`, then `mv` it into place), so a half-written guard
  never runs as the hook, and keep probe commands in files rather than on the command line, where
  the guard itself judges them.
