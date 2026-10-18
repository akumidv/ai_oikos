# BOOTSTRAP — installing oikos on a machine

This file is an instruction for the **agent** that installs, sets up or updates oikos for a user,
plus a **ready prompt** to paste into Claude Code. oikos is not installed into other projects. It
has two parts on a machine:

- **the core** — one clone of this repository (`~/oikos` by default): skills, tools, hooks. It is
  shared by every installation on the machine and is not worked in, only updated.
- **an installation** — a folder per organization or project (`~/oikos-acme`, …) holding the core
  as `oikos/` (a symlink, or a git submodule), the organization's `AGENTS.md`, `oikos.yaml`,
  `resources/`, `LANDSCAPE.md`, and the git-ignored `.local/` of this machine and person. The user
  starts the agent in the installation (see [OIKOS.md](OIKOS.md)).

Repository: `<oikos repository URL>` (the public repository this file came from).

---

## Prompt for the user

Paste into Claude Code, started in **any** folder:

```text
Install oikos for me: clone <oikos repository URL> into ~/oikos (ask me if I want another
folder), then follow its BOOTSTRAP.md "Set up" section to make an installation for my
organization.
```

Already cloned? Start Claude Code in any folder and say: `set up an oikos installation (BOOTSTRAP.md)`.

---

## Set up — what the agent does

Every step is safe to repeat. `node <oikos>/tools/setup/cli.mjs …` works from any folder; once the
installation exists, the same is `node oikos/tools/setup/cli.mjs …` from its root. Talk to the user
in their language; everything written stays in English.

1. **Prerequisites.** Node.js ≥ 22 and git; `npx` for the shared browser. Under WSL with a
   Windows Chrome, Node.js is also needed on the Windows side (the chrome-devtools MCP server
   runs there). Missing Node.js → tell the user how to install it for their OS; do not install
   system packages yourself.
2. **The core.** Clone into the folder the user chose (default `~/oikos`), then `npm install`
   there; if it already holds an oikos clone, `git -C <oikos> pull --ff-only` instead. Never clone
   into another project.
3. **The installation.** Ask the user for its folder (one per organization or project, outside
   the core, e.g. `~/oikos-<organization>`), then
   `node <oikos>/tools/setup/cli.mjs init <folder> --org "<name>" --email-domain <domain> [--vault <path>]`.
   It links `oikos/` to the core, writes `AGENTS.md`, `CLAUDE.md`, `oikos.yaml`, `LANDSCAPE.md`,
   `resources/`, `.gitignore` and `.local/` (`AGENTS.md`, `.env` with `JIRA_EMAIL` taken from the
   git email when it is in the organization's domain, else pass `--jira-email`), and runs sync,
   which writes the agent hosts' wiring there. It never overwrites an existing file. Then, with
   the user, from the installation's root:
   - `oikos.yaml`: which connectors each skill uses here
     (`node oikos/tools/landscape/cli.mjs skills` lists them), the site settings (`JIRA_BASE_URL`,
     `GITLAB_URL`, `GITHUB_ORG`, …), the organization's MCP servers (a knowledge base). Then
     `node oikos/tools/sync/cli.mjs` writes `.mcp.json`.
   - `AGENTS.md`: where the knowledge base is, where drafts and final documents go, the brand
     skill for on-brand documents, the SSO. `.local/AGENTS.md`: this machine's paths (the vault,
     the personal memory note) as `- key: value` lines.
   - `resources/<id>.md` (optional): one note per resource the organization has — what it is
     for, how it is reached (`via:` a skill or connector), sign-in.
     `node oikos/tools/landscape/cli.mjs resources` shows them; `node oikos/tools/sync/cli.mjs --check`
     validates them.
   The installation's root may become the organization's own private repository; `.local/`,
   `.mcp.json` and `oikos` are git-ignored by the `.gitignore` init wrote.
4. **Personal tokens — typed by the user, never through the chat.** Tell them to run, in
   **their own terminal** in the installation (not through `!` and not through you: the input
   must be a real terminal):
   ```bash
   cd <installation> && node oikos/tools/setup/cli.mjs token
   ```
   It shows where to create each missing token the installation's connectors need, reads it
   without echo, saves it into `.local/.env` (mode 600) and checks it with the tool's `whoami`.
   Tokens exported in the shell are only a fallback (every installation sees them); `.local/.env`
   wins over them, and `status` flags a token taken from the shell. Never ask for a
   token in the chat; if one is pasted there anyway, tell the user to revoke it and create a new one.
5. **claude.ai connectors** (no tokens): for connectors that go through claude.ai (Slack; Gmail,
   Drive, Calendar as an optional route), the user connects them in claude.ai → Settings →
   Connectors with the work account. Check each by a harmless read once the session has them.
6. **Browser extension** (optional): helpers in the user's own browser — Jira first
   (`extension/README.md`). They load it themselves: `chrome://extensions` → Developer mode →
   Load unpacked → the `extension/` folder of the core clone (under WSL through
   `\\wsl.localhost\<distro>\…`).
7. **Check.** `node oikos/tools/setup/cli.mjs status` until it says `ready` (connectors aside);
   then `node oikos/tools/sync/cli.mjs --check`.
8. **Start working.** Tell the user to start the agent **in the installation folder**
   (`cd <installation> && claude`, or `qwen` — the two are wired alike, see DEVELOPMENT.md § Agent
   hosts): the instructions, hooks and MCP servers load only at session start from that folder.
   On the first start the agent asks once whether to trust the folder and to use its MCP servers —
   accept, otherwise neither the guards nor the skills load. A good first request: "what are my tasks?".

Another organization or project is another installation: step 3 again with another folder. The
installations share the core and nothing else — each has its own configuration, tokens, catalog
and browser (its own Chrome profile and DevTools port, `OIKOS_CHROME_PORT` in `oikos.yaml`).

When a session starts in an installation that is not set up, the session-start hook says what is
missing and points here.

## Update

```bash
git -C <oikos> pull --ff-only && npm --prefix <oikos> install
```

Then, in each installation: `node oikos/tools/sync/cli.mjs && node oikos/tools/sync/cli.mjs --check`,
and start a new session there (hooks and settings are read at start). An installation's own files
and `.local/` are untouched by an update; sync rewrites only oikos's own entries in the wiring.
`setup status` shows whether an update added something to set up.

## Remove

An installation: delete its folder, and revoke the personal tokens (the pages in step 4). The
core: delete its clone once no installation links to it. A vault or document folder named in
`.local/AGENTS.md` is separate and stays.

## What setup never does

- commit or push anything in the core, an installation or a vault (except what the user
  explicitly asks for);
- write into the core: an installation's details, a personal path, a token or a working
  document stay in the installation (its `.local/` for what is personal);
- install system packages, change the shell profile or store tokens anywhere but `.local/.env`.
