# TASKS_ARCHIVE — finished oikos core backlog entries

Finished entries moved out of [`TASKS.md`](TASKS.md), same one-line format.

## Done

- P1-1 · Two roots · done · CORE_ROOT from the code, INSTALL_ROOT from where oikos runs
  — `tools/common/paths.mjs`: INSTALL_ROOT = `OIKOS_HOME` → `CLAUDE_PROJECT_DIR`/`QWEN_PROJECT_DIR`
  → walk up from cwd to `oikos.yaml`; none found is an error, never a fallback to the core
  (Node resolves symlinks, so `import.meta.url` is always the core). Move every `PROJECT_ROOT`
  use (config, env, landscape, catalog, browser, google auth, setup, hooks, programs, documents,
  sync) to the right root; config from `oikos.yaml`, `.env`/catalog/browser/google from `.local/`.
- P1-3 · sync owns only its entries · done · Foreign hooks, skills, MCP servers survive sync
  — mark oikos's entries (as akmon marks its hooks) and replace only those; today it deletes
  every skill folder it does not know and rewrites `hooks` and `.mcp.json` whole. In the core
  repository it writes no skill pointers (akmon does).
- P1-5 · Installation setup · done · `setup init <dir>` makes the skeleton above
  — plus `setup status`, the session-start hook and BOOTSTRAP.md for the installation model;
  `.local/AGENTS.md` keeps the `- key: value` paths setup parses.
- P1-6 · Running tools from an installation · done · One documented way, skills' commands follow
  — `node oikos/tools/<tool>/cli.mjs` or scripts in the installation; OIKOS.md "Run the tools
  from the project root" and every `node tools/…` in the skills.
- P1-7 · Guards in an installation · done · secret-guard and package-guard judge paths from INSTALL_ROOT
  — `oikos/` is read-only in an installation; development happens in the core repository.
- P1-8 · Tests on a fixture installation · done · Prove isolation with `examples/installation` (ACME)
  — a symlinked installation reads its own config; foreign wiring survives sync; two
  installations never share a browser; part of `npm run check` or `npm test`.
- P1-9 · Leak guard for commits · done · Private terms list outside the repo blocks a commit
  — `~/.config/oikos/private-terms` (never in the repo), checked on every core commit.
- P2-1 · akmon init · done · `_aitna/akmon` submodule; akmon block in the core AGENTS.md
- P2-3 · Development mode · done · Replace `OIKOS_DEVELOPMENT` and package-guard's mode by core vs installation
- P2-4 · Backlog home · done · `_aitna/TASKS.md` is the core backlog, finished entries here
  — AGENTS.md and DEVELOPMENT.md point to it; no dates; an installation's own tasks stay in its
  `.local/TASKS.md`.
