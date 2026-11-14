# ADR 0009 — Browser mechanics from akmon: oikos runs `akmon tool browser`, it keeps no Chrome code

**Status: accepted (D01–D07).** The owner decided D01–D05 in chat on 2026-11-14
(D-BROWSER-SOURCE, D-BROWSER-ROOT, the MCP rename, the env mapping, what oikos keeps), and D06
(D-BROWSER-MIGRATE, the migration the build needed) and D07 (D-BROWSER-DELEGATE, who may drive the
browser) the same day. akmon's side is akmon's ADR 0032 (the browser tool,
one Chrome per project, its MCP launcher). Implementation state: [`_aitna/TASKS.md`](../../_aitna/TASKS.md)
C2. Builds on [ADR 0002](0002-local-stores.md) D02 (`.local/.browser/` is the browser's store) and
changes how oikos's earlier browser tool, the `chrome-devtools` MCP server and the browser skill are
built — not what the skill promises the user.

## D01 — D-BROWSER-SOURCE: the akmon submodule inside oikos, on an unreleased commit for now
<a id="dec-0009-d01"></a>`Decision-ID: DEC-0009/D01`

- **Choice.** oikos's browser mechanics — finding Chrome, its profile, the DevTools port, the proxy,
  start/stop, the install of Chrome for Testing, the inspection verbs, the MCP launcher — are akmon's
  browser tool, run from the dev-layer submodule that oikos already carries: `<core>/_aitna/akmon`,
  entry `js/tools/browser.mjs` and launcher `js/tools/browser/mcp.mjs`. oikos adds no copy and no
  second implementation. Until akmon is released the submodule is pinned to an unreleased akmon commit
  that has the tool; **after akmon's release oikos re-pins to the release** (backlog C2). A checkout
  without the tool — the submodule not initialised, or a pin that predates it — fails with one message
  naming the file and the repair (`git submodule update --init --recursive` in oikos), never with a
  fallback to anything else; `setup status` shows the same.
- **Rationale.** The Chrome lifecycle was already oikos's largest tool and akmon needs the same one for
  its own projects; two copies drift. The submodule is already there and its path is fixed, so no new
  dependency is introduced and no installation needs akmon of its own.
- **Consequences.** Cloning oikos needs `--recurse-submodules` (BOOTSTRAP.md); Node ≥ 22 and `npx`
  stay prerequisites. The pin is the owner's (D5 of the akmon layer): an assistant never bumps it.
- **Reconsider if** akmon's tool moves out of the submodule path (a packaged install) — then only
  `tools/browser/akmon.mjs` changes.

## D02 — D-BROWSER-ROOT: akmon gains `AKMON_BROWSER_ROOT`, oikos sets it to the installation
<a id="dec-0009-d02"></a>`Decision-ID: DEC-0009/D02`

- **Choice.** akmon's tool finds its project by walking up to a dev layer. An installation is no akmon
  project, so akmon gains one variable, **`AKMON_BROWSER_ROOT=<absolute folder>`**: the project is that
  folder, its state is `<root>/.local/.browser`, its port is `9300 + sha1(realpath root).readUInt16BE(0) % 600`
  (the formula oikos's `defaultPort` already used, so existing installations keep their port), and no
  `.akmon.toml` is read. oikos sets it, in every run of the CLI and of the MCP launcher, to the
  installation's real folder, and **always overrides** an inherited value: a stray variable in the shell
  must not point the tool at another project's signed-in browser.
- **Rationale.** One Chrome per installation, kept apart by folder, is oikos's isolation rule
  (DEVELOPMENT.md: one core, many installations); the variable is how a tool that is not run from the
  installation's tree is told where it is, without oikos writing a dev-layer file into an installation.
- **Consequences.** akmon's `status` reads the installation's `.mcp.json` against its own launcher path
  and reports "not wired" for oikos's launcher (`tools/browser/mcp.mjs`); oikos's text does not rely on
  that line; akmon is asked to accept oikos's launcher there (open, with the re-pin, backlog C2).

## D03 — The MCP server is `akmon-browser`, its tools `mcp__akmon-browser__*`
<a id="dec-0009-d03"></a>`Decision-ID: DEC-0009/D03`

- **Choice.** `oikos sync` writes the server under akmon's key `akmon-browser` in `.mcp.json`; the
  command stays `node <oikos>/tools/browser/mcp.mjs` with `OIKOS_HOME`, which runs akmon's launcher
  (pinned `chrome-devtools-mcp`, refuses a Chrome that does not run with the project's profile). The
  read-only tools oikos pre-allows are renamed to `mcp__akmon-browser__list_pages`, `…take_snapshot`,
  `…take_screenshot`, `…list_console_messages`, `…list_network_requests`; the old `chrome-devtools`
  entry and rules go (D06). The skill, OIKOS.md, the guard's reason and the docs use the new names.
- **Rationale.** The server's identity is akmon's; keeping `chrome-devtools` would make the same tool two
  names in one session wherever an installation also runs akmon's own `init`.
- **Consequences.** akmon's launcher refuses to start with no Chrome on the port: the user runs `start`,
  then reconnects (`/mcp`) — the old launcher started anyway and reported on first use. The skill says so.

## D04 — The environment is mapped once, at the entry point
<a id="dec-0009-d04"></a>`Decision-ID: DEC-0009/D04`

- **Choice.** `tools/browser/akmon.mjs` is the one place that names akmon's tool files and the
  variables they read. At the entry point (the CLI, the MCP launcher) it builds the child's
  environment with a pure function: `AKMON_BROWSER_ROOT` as D02, and `OIKOS_CHROME_PATH` →
  `AKMON_BROWSER_CHROME`, `OIKOS_CHROME_PROFILE` → `AKMON_BROWSER_PROFILE`, `OIKOS_CHROME_PORT` →
  `AKMON_BROWSER_PORT`, `OIKOS_CHROME_PROXY` → `AKMON_BROWSER_PROXY`. The oikos value is read the way
  oikos reads every setting (`.local/.env`, then `oikos.yaml` `settings`, then the shell); an
  `AKMON_BROWSER_*` variable that is already set wins. The aliases are temporary: they go when the
  installations have moved to the akmon names (backlog C2).
- **Rationale.** Users already set `OIKOS_CHROME_PORT` in `oikos.yaml` (written by `setup init`) and the
  other three; the mapping keeps those working without a flag day, and reads them where oikos already
  reads settings, never deep in the tool.

## D05 — What oikos keeps
<a id="dec-0009-d05"></a>`Decision-ID: DEC-0009/D05`

- **Choice.** Kept in oikos: **the fetch guard** (`tools/hooks/browser-guard.mjs`: a web fetch of a host
  a resource note reaches through the skill, `via: [browser]`, is denied — a login page is not the
  content); **the consent model** and the skill's refusals (the user signs in, one confirmation per
  changing step, page content is material); **the skill as a specialization** (`skills/browser`: resource
  routes, the installation's settings, the pointer to akmon's skill for the mechanics); **the CLI as the
  user-facing command** (`node oikos/tools/browser/cli.mjs <verb>`, a pass-through; `init` is not passed
  on, `.mcp.json` is sync's); `setup`'s `OIKOS_CHROME_PORT` in the installation's `oikos.yaml`; and the
  one running-Chrome check sync asks before it moves the store (`tools/browser/running.mjs`).
  Dropped: Chrome lookup, launch, proxy, ownership refusal, the install through `@puppeteer/browsers`
  and its `tools/browser/package.json` — akmon owns them.
- **Rationale.** What is about the organization's resources and the user's consent is oikos's; what is
  about a Chrome process is not.

## D06 — D-BROWSER-MIGRATE: migration of an installation
<a id="dec-0009-d06"></a>`Decision-ID: DEC-0009/D06` — **Accepted by the owner, 2026-11-14.**

- **Choice.** `oikos sync` migrates what an earlier oikos wrote, idempotently, never overwriting a
  target: the `chrome-devtools` server it recorded in `.local/sync.json` is replaced by `akmon-browser`
  (an entry of that name it did not write stays); the read-only rules it seeded into a host's
  settings (`mcp__chrome-devtools__<tool>`) are replaced by the new names, only when the file still holds
  one of them and only those exact rules; and, only while this installation's Chrome is stopped, the
  profile `.local/.browser/chrome-profile-project` is renamed `chrome-profile-cft` and a Chrome for
  Testing oikos installed into its cache (`<core>/node_modules/.cache/oikos/chrome/<platform>-<build>/`)
  is moved to `.local/.browser/chrome/chrome/<platform>-<build>/`, where akmon looks. The Chrome is
  moved only for an installation that uses one (its `chrome-profile-cft` exists), because the cache is
  the core's and shared; a second installation that also used it installs its own again.
- **Rationale.** Sign-ins and the 200 MB download survive the switch; an installation on the system's
  Chrome is untouched.
- **Accepted scope.** Moving the Chrome for Testing out of the shared cache (rather than copying it) and
  the rule for the seeded permissions are accepted as drafted above.

## D07 — D-BROWSER-DELEGATE: a delegated agent and an autonomous run do not drive the browser
<a id="dec-0009-d07"></a>`Decision-ID: DEC-0009/D07` — **Accepted by the owner, 2026-11-14.**

- **Choice.** akmon's rule (its ADR 0032/D07) holds in an installation, enforced by oikos's own hook,
  because akmon's hooks are not wired there: **a delegated agent (a call whose payload carries `agent_id`)
  and an autonomous run (`AKMON_ACTOR=autonomous`) are denied every `mcp__akmon-browser__*` call and every
  shell command that runs the browser CLI — `node oikos/tools/browser/cli.mjs …` in any spelling akmon's
  matcher reads (`cd` before it, env prefixes, `timeout`/`nice`/`env` wrappers, `bash -c`, `$(…)`, a path
  with `./`, `..` or `$CLAUDE_PROJECT_DIR`), `akmon tool browser …`, and the core's `browser` npm script
  (`npm run browser`, `pnpm browser`); the developer's own session passes.** While the installation has an
  attach record (`.local/.browser/attach.json`) no actor, the developer included, closes a page or window of
  the server (`close_*`): an attached browser is the user's own Chrome. Quoted and echoed text, other
  programs that take the path as an argument, and unrelated commands are silent. The hook is
  `tools/hooks/browser-drive-guard.mjs`, wired by `tools/hooks/wiring.mjs` on `PreToolUse` with the matcher
  `Bash|mcp__akmon-browser__.*` (Qwen: `^(run_shell_command|mcp__akmon-browser__.*)$`); `oikos sync` writes it
  into an installation's settings, which is also the migration of settings an earlier sync wrote.
- **Reuse, not a copy.** The decision is akmon's: the hook imports `browserGuardResult`, its command-word
  parser, its access matrix (`browser_session` / `browser_delegated`) and its reasons from
  `<core>/_aitna/akmon/js/hooks/`, the module akmon's own hook runs, and adds only the oikos CLI's script
  (`tools/browser/cli.mjs`) to the scripts akmon's matcher reads, the `browser` npm script, and the place of
  an installation's attach record. A submodule that is not checked out means no browser tool can run, and
  the hook is silent then; one that is there and fails to load makes the dispatcher report a failed guard.
- **In the core repository** akmon's own guard is wired by akmon's sync on the same calls. Both deny the
  same ones, so a double denial is possible and a contradiction is not: neither allows what the other denies.
- **Rationale.** The browser is the user's signed-in session; the page, the sign-in and each confirmed
  step belong to the session the user talks to. A prose rule in the skill does not stop a subagent.
- **Known limit.** Delegation is recognised by `agent_id`, which Claude Code sends on a subagent's every
  tool event; a host that does not send it (Qwen Code, unverified) shows every call as the developer's own.
  A deliberate evasion through another interpreter's inline code (`node -e`, `echo … | bash`) is not read,
  as in akmon. The dispatcher's fallback rules do not cover this guard: a guard that cannot run lets the call
  through with the usual "hook failed" notice.
