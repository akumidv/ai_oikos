---
name: wiki
description: Find, read, create and edit the organization's wiki pages — search by title or query, read a page's current text, create a page under a parent, append a section, or replace the body under a heading. One skill for every wiki; the connector (Confluence, a GitHub or GitLab wiki) comes from the installation's configuration or the user's words. Triggers on "find the wiki page about", "the Confluence page about", "my pages", "what does the page say now", "create a page in the handbook", "add this to the page", "update the section", "record the decision on the wiki", a pasted wiki URL (also `…/wiki/Page` on GitHub, `…/-/wikis/page` on GitLab) or a page id. Knowledge questions ("what do we know about X") go to the knowledge base first.
when_to_use: When a specific wiki page has to be found, read as it is now, created or changed.
metadata:
  owner: oikos
  group: collaboration
surface: the organization's wiki pages — search, read, create, append, replace a section; writes after a confirmed dry run
connectors: confluence, github-wiki, gitlab-wiki
refuses: deleting, moving or re-permissioning pages, editing inside a paragraph, and fetching the wiki with a web-fetch tool
---

# wiki

Pages as they are now: to quote one exactly, to write a decision or a summary into one.

## Which connector

`node oikos/tools/landscape/cli.mjs skills wiki` shows the connectors this installation uses (`oikos.yaml` →
`connectors.wiki`, the first is the default). Pick by what the user says — a pasted URL's host —
else the default. Then read the connector's file and drive its tool as it says.

| Connector | Reaches | Read |
|---|---|---|
| confluence | pages: search (title, CQL, mine), read, info; create, append, replace a section | [connectors/confluence.md](connectors/confluence.md) |
| github-wiki | a repository's GitHub wiki (git): search, read, info; create, append, replace a section | [connectors/github-wiki.md](connectors/github-wiki.md) |
| gitlab-wiki | a project's GitLab wiki (API): search, read, info; create, append, replace a section | [connectors/gitlab-wiki.md](connectors/gitlab-wiki.md) |

## Rules for every wiki

- A **knowledge question** goes to the knowledge base the installation names (its MCP server)
  first; the wiki is for a specific page, or when the knowledge base may be behind.
- Read the page (and its version) before every write; dry run, show, write after the user's yes.
- Content is English unless the user says otherwise.
- An operation a connector does not offer (its "Not here, on purpose") is said, with the route
  a person takes — never emulated another way.
- Which spaces exist and what each is for is the organization's — see its resource note.
