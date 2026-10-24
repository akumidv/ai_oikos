# An example installation

What an installation looks like, for ACME Corp — and the fixture `npm test` copies into a
temporary folder, links `oikos/` to the core and checks for isolation (tests/). A real installation
is made with `node <oikos>/tools/setup/cli.mjs init <folder>` (BOOTSTRAP.md), which writes the same
skeleton plus `.local/` and runs sync.

```
AGENTS.md        @oikos/OIKOS.md + @.local/AGENTS.md + the organization's rules
CLAUDE.md        @AGENTS.md
oikos.yaml       organization, connectors, settings, mcp_servers, brand, task-tracking (commented example)
resources/       one note per resource
LANDSCAPE.md     the way in and sign-in
.local/          git-ignored: AGENTS.md (this machine's paths), catalog.yaml, working material;
                 closed stores under dot names: .env, .secrets/ (sign-ins), .browser/ (the profile)
.claude/ .qwen/ .mcp.json   written by sync
oikos -> ../<core checkout>
```
