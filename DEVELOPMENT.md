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
agents/<name>/README.md  the standing agents: a thin charter over skills (ADR 0006); see Writing an agent
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
tools/desk/cli.mjs     new | index | list | find | compact | reopen — the desk agent's topics in
                       .local/desk/ (ADR 0006): folders, the derived INDEX.md, retention by age;
                       local writes of open files, compact and reopen previewed unless --yes
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
`.local/` what belongs to one machine and person — AGENTS.md (paths), .env, catalog.yaml, private.yaml
(people: aliases, emails, accounts — personal data on purpose, listed in the installation's `.gitignore` by
`setup init` and `sync`; ADR 0006 D06), browser/
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
  `tools/common/landscape.mjs` (engineering, collaboration, files, web, hr, ongoing); `npm run check` fails
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

## Writing an agent

A standing agent is `agents/<name>/README.md` and nothing more (ADR 0006 D01; an interim format until
akmon has a standard for agents, which then binds this section). Frontmatter: `name` (equals the
folder), `description` (what it does and when to start it, with example phrases), `skills` (a list;
each must exist in `skills/`), `owns` (one open folder of `.local/`, never a closed or legacy store
name), `metadata.owner`. Sections, each `## <name>`: Mission; Skills (how it uses them — links, no copy
of a skill's rule); Owns; Never; Session start; Closing a topic; Workers (briefs it may delegate,
with their inputs, the folder they write to and what they return). An agent has no permission of its
own: a charter may only narrow what the guards allow, and says what it never does.

An installation switches an agent on with `agents:`; `sync` writes a pointer of its name into
`.claude/skills/` and `.qwen/skills/` (so an agent and a skill must not share a name), and the
session-start hook names the agents on. `npm run check` fails on a charter off this format, a
listed skill that does not exist, a bad `owns`, a name shared with a skill, and — in an
installation — an `agents:` entry oikos does not have. A capability an agent needs goes into a
skill (the agent links it); mechanics a skill repeats go into a tool.

## Writing a tool

`tools/<name>/cli.mjs` — Node.js ≥ 22, ES modules. Built on `tools/common/`:

| Module | Owns |
|---|---|
| `cli.mjs` | commands on `util.parseArgs`, `--json`/`--help` everywhere, error → exit code, the proxy re-exec, the connector check (`requireConnector`) |
| `http.mjs` | every outward request: named User-Agent, timeout, channel errors, Cloudflare detection; `download()` streams a large file (idle timeout, `.part` until complete) |
| `paths.mjs` | the two roots: `CORE_ROOT` (the code, from `import.meta.url`) and `installRoot()` (`OIKOS_HOME` → `CLAUDE_PROJECT_DIR`/`QWEN_PROJECT_DIR` → the working folder and its parents; a hook process, `hookInstallation()`, takes the project folders first, then `OIKOS_HOME`, and an `OIKOS_HOME` that leads to no installation is `brokenHome`, ADR 0007 D02); `localPath()` for `.local/`, throwing outside an installation; `LOCAL_STORES` and `localStorePath()` — a tool's store under its dot name, or at its legacy place until sync moves it (ADR 0002) |
| `local-stores.mjs` | the move of the stores in `.local/` from their legacy places to their dot names (`moveLocalStores`, run by sync; the browser profile only while its Chrome is stopped) |
| `env.mjs` | settings and credentials: `.local/.env` → `settings` of `oikos.yaml` → environment (a fallback shared by every installation); presence only, never values; `orgEmail()`, `orgGitEmail()` (the git email, only inside a configured domain); `isWsl()`, `environment()` — os, wsl, display |
| `config.mjs` | the installation's `oikos.yaml`: organization, connectors per skill, settings, MCP servers, brand, task-tracking, agents, desk |
| `desk.mjs` | the desk's shared facts: its folder name (`handoff` keeps it out of its packages), the unit statuses, the `desk:` part's defaults and checks |
| `transitions.mjs` | a tracker's status transition rules (`task-tracking.<connector>`, ADR 0001): the structure check, every problem with its path, and the rule a move falls under (`resolveTransition`) — shared by the tracker connectors |
| `pullrequests.mjs` | the pull requests of a task (ADR 0001 D05): PR/MR URL parsing, the key and its aliases as a whole token, the pool search per repository through `github.mjs` / `gitlab.mjs` (and the extended set's, D08, when the caller passes it), a bare number in `number_repos` and the commit search when nothing is found (D11), `--skip-pr` (D12), de-duplication by URL, the dry run's `## Pull requests` lines and the comment posted with a move — best effort, shared by the tracker connectors |
| `tracking-config.mjs` | the one editor of a tracker project in the installation's `oikos.yaml` (`task-tracking.<connector>.projects.<KEY>`, ADR 0001 D07): lists grow, prose is replaced, a missing block is created; the change is spliced into the source so every other byte and comment stays, re-parsed and validated before an atomic write |
| `project-setup.mjs` | what `<tracker> project-init --dry-run` reports: the workflow laid against the rules, key alias candidates, pool candidates by activity under an owner and by name pattern (GitHub; GitLab named as not searched) — shared by the tracker connectors |
| `outgoing.mjs` | the one content check of what a write sends (ADR 0003): `outgoingFindings(text, rules)` (pure: `language`, `assistant`, `path`, `secret`, `term`), `outgoingRules()` (the built-in patterns plus the installation's `.local/outgoing.yaml`: `terms:`, `allow:`), `guardOutgoing(texts, values, rules)`, `uploadedMarkdown` (an uploaded image line as the service sees it), `nonLatinLetters` |
| `files.mjs` | a path the user gave that does not exist: the similar files or folders that were probably meant (`missingMessage`) |
| `local-files.mjs` | the path rule for a local file a tool carries elsewhere — `jira attach` and image lines upload it, `handoff park` copies it: its real path inside the allowed roots (`fileRoots`), never a closed store of `.local/` (`closedStore`), an `.env*` file or a dot-named entry outside a working folder of `.local/` (`dotComponent`); `pathProblem` / `nameProblem` say why, `localFile` judges one typed file; `scratchProblem` is the rule for the scratch folders a caller allows (`handoff park`: `$OIKOS_SCRATCH` and this installation's Claude Code session scratchpad, not the temporary folder at large): the folder itself is no source, a file inside is carried only when the current user owns it; `anyClosedStore` refuses a closed store of any `.local/`, not only the installation's |
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
  browser, documents, footprint, handoff, desk, people, setup, sync, hooks) pass no `connector`. The same list decides the rest:
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
- A guard under development is the hook on the next call, and a broken one fails open, silently:
  write the new version in the scratchpad, run `node --check` on it, then move it into place, and
  keep probe commands in files rather than on the command line, where the guard judges them. A
  silent pass in a session is not evidence that a hook works; `npm run check` is.
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

Qwen Code reads `.mcp.json` and `AGENTS.md` (its `@` imports included) and nothing under
`.claude/`, and matches the canonical snake_case tool names (`run_shell_command`, `write_file`): an
unanchored alternation in Claude's names (`Edit|Write`) matches some calls and not others, without
saying so. Every guard fails open, so a guard that is absent or never matches looks the same from
outside as one that works; comparing `tool_name` with `'Bash'` is true by absence on the other host.
Hence the wiring is generated from one table and checked.

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
