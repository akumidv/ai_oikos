# QWEN.md

This project uses [AGENTS.md](AGENTS.md) as the guidance for every AI agent working in it,
Qwen Code included. Qwen Code reads `AGENTS.md` itself, so this file repeats nothing on purpose —
an `@AGENTS.md` import here would put the same instructions in the context twice.

Where the Qwen-specific wiring lives, for whoever is looking for it:

- `.qwen/settings.json` — the oikos hooks, wired for this host. Generated from
  `tools/hooks/wiring.mjs` by `npm run sync`; `npm run check` fails if the two drift apart.
- In an installation, sync also writes `.qwen/skills/<name>/SKILL.md` — a pointer to each real
  skill in `oikos/skills/<name>/SKILL.md` — and `.mcp.json` (oikos's `chrome-devtools` plus the
  installation's `mcp_servers`, git-ignored, shared with the other hosts). The core repository,
  where oikos is developed, has neither.

The same rules as everywhere else in oikos: read-only by default, a changing action shown first
and run only after the person confirms it, secrets out of the chat. Both hosts are guarded — the
guards know each host's tool names in `tools/hooks/host.mjs`.
