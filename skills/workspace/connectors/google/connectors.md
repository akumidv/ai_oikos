# Route: the claude.ai connectors

The connectors **Gmail**, **Google Drive** and **Google Calendar** are authorised per person in
claude.ai; their access lives in the Claude cloud, not on the machine. Used when the user has
connected them; not required.

## Is it connected?

Find the connector tools with a tool search (`gmail`, `drive`, `calendar`); in Claude Code they
appear as `mcp__claude_ai_<Name>__…`, and `/mcp` lists them as `claude.ai <Name>`.

- **Not listed** — not added to this claude.ai account: use another route (SKILL.md), or tell
  the user how to connect it if they prefer this one.
- **Only `authenticate` is listed** — added but not signed in. Calling `authenticate` starts the
  sign-in; the user finishes it in the browser, then `complete_authentication` if offered.

## Connecting (once per person, if the user wants it)

1. claude.ai → **Settings → Connectors** → Gmail / Google Drive / Google Calendar → **Connect**.
2. Sign in with the **organization's Google account** (through its SSO, if any), never a personal
   one. Grant the requested permissions.
3. If Google says the app is blocked, the Workspace admin allows the Claude app (Google Admin
   console → Security → API controls → App access control).
4. Start a new Claude Code session in oikos and check `/mcp`.

Creating or editing a Google Doc/Sheet/Slides file through the connector: load the
`anthropic-skills:google-workspace` skill first.
