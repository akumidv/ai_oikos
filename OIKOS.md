# oikos — an assistant for working with an organization's resources

**oikos** (Greek "household") helps a CTO or manager work with their organization's resources:
code hosting, task tracking and goals, the wiki, the messenger, mail, files and calendar,
documents and the knowledge base. Skills are kinds of work, each driving one or more connectors;
which connectors an organization uses, its sites and its resources are the installation's,
never oikos's.

This file is for **using** oikos. An **installation** is a folder per organization or project
that holds oikos as `oikos/` (a symlink or a submodule) and imports this file from its own
`AGENTS.md`. Developing oikos itself — its skills, tools, connectors, these instruction files —
happens in the oikos repository (its `AGENTS.md` and `DEVELOPMENT.md`), not in an installation.

## Language

- Everything written into oikos is in **English**; tracker comments and wiki content too, unless
  the installation's `AGENTS.md` or the user says otherwise.
- Answer the user **in the language of their question**.

## What lives where

| What | Where | Visible to |
|---|---|---|
| Rules, skills, connectors, tools | oikos — `oikos/` in the installation (public) | everyone |
| How the organization's knowledge and documents are kept (`AGENTS.md`, imports this file); the organization, its connectors, settings, MCP servers and brand (`oikos.yaml`); its resources (`resources/`, `LANDSCAPE.md`) | the installation's root (its own, private repository if any) | the organization's people |
| This machine's paths (`AGENTS.md`: the vault, the memory note), tokens (`.env`), the user's catalog of counterparties and folders (`catalog.yaml`), the shared browser's profile (`browser/`), sign-ins (`google/`), a personal backlog | the installation's `.local/` (git-ignored as a whole) | this machine's user |
| Knowledge, final documents, personal agent memory | where the installation's `AGENTS.md` says (a vault, a knowledge base) | the user and their organization |

**oikos's own files are not changed in ordinary work** — only the installation's files and the
places its `AGENTS.md` names. A change useful to every user is proposed to the user and made in
the oikos repository. The installation's files and `.local/` hold only what agents read and use —
never documents, drafts or working materials. Nothing that names the organization — hosts,
projects, people, task keys — goes into oikos.

## Session start

1. Read the installation's `AGENTS.md` and this file (the installation imports it with
   `@oikos/OIKOS.md`). If the session-start hook reports that oikos is not set up, set it up with
   the user following [BOOTSTRAP.md](BOOTSTRAP.md) § Set up (`node oikos/tools/setup/cli.mjs status`
   shows what is left).
2. Read the personal memory note that the installation's `AGENTS.md` points to, if any.
3. While working: experience useful to every user is proposed for "Shared experience" below
   (a change to oikos); experience about this organization or this person goes where the
   installation's `AGENTS.md` says.

## Knowledge

Facts come from the knowledge base the installation names in its `AGENTS.md` (usually an MCP
server in `mcp_servers` of `oikos.yaml`), not from memory; if it is unavailable, say so
explicitly.

## Skills

The skills are `oikos/skills/<name>/SKILL.md`, one per kind of work: `code-hosting`,
`task-tracking`, `wiki`, `messaging`, `workspace` (mail, files, calendar), `documents`, `browser`,
`catalog`. The agent host is given a pointer to each one (`.claude/skills/`, `.qwen/skills/` of
the installation, written by `node oikos/tools/sync/cli.mjs`), lists them with their triggers and
loads the one a request matches.

A skill drives **connectors** — `skills/<name>/connectors/<connector>.md`, each with its tool
(`tools/<connector>/cli.mjs`). Which connectors this installation uses for a skill, the first
being the default, is `connectors:` in the installation's `oikos.yaml`; the user's words (a named
service, a pasted URL) pick another. `node oikos/tools/landscape/cli.mjs skills` shows every skill
with its connectors and the ones used here (`skills <name>` for one).

**Running the tools.** Every tool runs as `node oikos/tools/<tool>/cli.mjs …` from the
installation's root: a tool finds the installation from where it runs (or from `OIKOS_HOME`), never
from where its code lies, so the same core serves every installation on the machine. Run from
elsewhere — the vault, a folder of documents — a tool says it found no installation; go back to the
installation's root or set `OIKOS_HOME` for that command. `oikos/` is read-only in an installation
(a hook denies edits there).

The organization's resources, what each is for and which skill reaches it:
`node oikos/tools/landscape/cli.mjs resources` (`resources <id>` for one); the notes are the
installation's `resources/`, the way in and sign-in its `LANDSCAPE.md`.

In the browser itself: the oikos extension (`extension/`, loaded unpacked; helpers for Jira and
other sites, see `extension/README.md`).

**Writes need confirmation.** Every changing action — in the tracker, the wiki, mail, the drive,
the messenger or the browser — is shown first (`--dry-run`, a draft, or a description of the
click) and runs only after the user confirms it. For the Jira and Confluence tools a hook
enforces this in every permission mode: a write runs only as the exact command whose `--dry-run`
was shown, and only after the user has answered; otherwise it is denied with the reason.

**Sign-in.** Web resources usually sign in through the organization's SSO. The agent never
types passwords or MFA codes; the person signs in — in claude.ai for a connector, or in the
shared browser — and the agent works through that. API tools use personal tokens (below).

### Who "me" is

Questions like "my tasks", "my goals", "my merge requests", "my mail" are answered for the
person whose credentials the session uses — normally the user in front of you:

| Connector | "Me" is | How to check |
|---|---|---|
| jira, confluence | the account of `JIRA_EMAIL` (`currentUser()` in JQL/CQL) | `node oikos/tools/jira/cli.mjs whoami` |
| gitlab | the owner of `GITLAB_TOKEN` | `node oikos/tools/gitlab/cli.mjs whoami` |
| github | the owner of `GITHUB_TOKEN` / the `gh` login | `node oikos/tools/github/cli.mjs whoami` |
| google | the account of the route in use: mail over IMAP, the shared browser, the Drive app or the connector | `node oikos/tools/google/cli.mjs whoami` (mail); skill `workspace` |
| slack, other claude.ai connectors | the account that connected the connector in claude.ai | the connector's own profile |

For a colleague, pass their work email (`--user`, `--owner`, `--assignee`). If the identities
disagree (a connector signed in as someone else), say so before answering.

### Credentials and settings

Personal tokens go in the installation's `.local/.env` (git-ignored, mode 600). The installation's
own files win: `.local/.env`, then `settings` of `oikos.yaml`, then the shell environment — only a
fallback, since every installation on the machine shares it. Keys: `JIRA_EMAIL`,
`JIRA_API_TOKEN` (Jira and Confluence), `GITLAB_TOKEN`, `GITHUB_TOKEN`; optional `GMAIL_APP_PASSWORD` (Gmail over IMAP). Site settings
that are not secret — `JIRA_BASE_URL`, `GITLAB_URL`, `GITHUB_ORG`, … — are `settings:` in
the installation's `oikos.yaml`. Connectors need no token: connect them in claude.ai → Settings →
Connectors with the work account. The user types a token in their own terminal with
`node oikos/tools/setup/cli.mjs token` (no echo, straight into `.local/.env`); each tool's
`whoami` shows which are set and where from. Never print a secret, never ask for one in the chat, never put one into
a document; a hook denies reading `.env` files and printing the environment.

**Git.** Stage by name (`git add -A` and `git commit -a` are denied by a hook); `git push`, a
merge request or a pull request only on the user's explicit request — the hook asks, and
outside the default permission mode denies, so the user runs it with `! git push`. No `sudo`.

## Documents

1. Drafts and the final document go where the installation's `AGENTS.md` says (a vault's inbox, a
   folder); throwaway intermediate files go to the session scratchpad. None goes into oikos, the
   installation's files or `.local/`.
2. Facts come from the knowledge base (above).
3. An office file (docx/pdf/pptx/xlsx) — skill `documents`; on-brand — the organization's brand
   skill named in the installation's `AGENTS.md`; the look of `from-markdown` is `brand:` in
   `oikos.yaml`.

## Shared experience

Short dated entries useful to **every** user: document structures, tracker and sprint
techniques, pitfalls. Nothing about one organization; experience about developing oikos goes to
DEVELOPMENT.md.

- none yet
