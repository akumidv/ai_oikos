# Connector: confluence

Confluence Cloud, for the skill `wiki`. One tool: `node oikos/tools/confluence/cli.mjs <command>`;
`--json` gives the raw payload.

**Never fetch a Confluence URL with a web-fetch tool** — it returns a login shell.

## Find and read

- A **knowledge question** ("how do we…", "what is our policy on…") goes to the knowledge base the
  installation names, when it indexes Confluence.
- A **specific page** — to quote it exactly, to edit it, or when the knowledge base may be behind —
  is found and read here:

```bash
node oikos/tools/confluence/cli.mjs search --title "Onboarding" [--space HB]
node oikos/tools/confluence/cli.mjs search --cql 'space = PROD AND lastmodified > now("-30d")'
node oikos/tools/confluence/cli.mjs search --mine [--space PROD]   # pages I created or edited, newest first
node oikos/tools/confluence/cli.mjs read --page 5869600772          # current text; tables as | rows |
node oikos/tools/confluence/cli.mjs info --page <id|URL>            # title, space, version, URL
```

## Write — dry-run, show, confirm, write

```bash
node oikos/tools/confluence/cli.mjs create --space HB --title "..." --parent <id|URL> --file <scratchpad>/page.md --dry-run
node oikos/tools/confluence/cli.mjs append --page <id> --heading "Sprint 26 summary" --file <scratchpad>/section.md --dry-run
node oikos/tools/confluence/cli.mjs replace-section --page <id> --heading "Rollout" --file <scratchpad>/section.md --dry-run
```

- Run `info` (or `read`) before every write: it confirms the page and its version.
- Bodies are a markdown subset (headings, lists, code, rules, `code`, `**bold**`, `[links](url)`);
  anything else degrades to text. Content is **English** — the tool refuses non-Latin text unless
  `--allow-non-english` is passed.
- `create` refuses when a page with that title already exists in the space.
- `replace-section` replaces everything under a top-level heading up to the next heading of the
  same or higher level, keeping the heading; its dry run prints the current and the new text.
  If the heading is missing or not unique, it lists the page's headings and stops.
- `append`: `--heading-level` (default 2), `--at-start` to insert at the top.
- Show the user the dry run and write only after they confirm.

## Guards

Every edit rewrites the whole page body. The tool refuses when the current body does not parse
as ADF and aborts when the version cannot be read. Either means the page is not what the tool
expects: look at the page, do not retry or work around it. Deleting, moving and permissions are
not offered — a person does them in Confluence.

## Credentials

The same Atlassian identity as Jira (`JIRA_EMAIL`, `JIRA_API_TOKEN`) — see the `jira` connector of
the skill `task-tracking`.
`CONFLUENCE_*` variables override them only if Confluence ever needs a different identity.
Without them every command stops with exit 1 and names the missing keys, before any request; only
`append --dry-run` and `create --dry-run`, whose preview reads nothing from Confluence, still show
it — the write itself needs the credentials.
