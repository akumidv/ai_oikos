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
  the installation's `AGENTS.md` or the user says otherwise (the tools' content check flags
  non-English text: § Skills, "What goes out").
- Answer the user **in the language of their question**.

## What lives where

| What | Where | Visible to |
|---|---|---|
| Rules, skills, connectors, tools | oikos — `oikos/` in the installation (public) | everyone |
| How the organization's knowledge and documents are kept (`AGENTS.md`, imports this file); the organization, its connectors, settings, MCP servers and brand (`oikos.yaml`); its resources (`resources/`, `LANDSCAPE.md`) | the installation's root (its own, private repository if any) | the organization's people |
| This machine's paths (`AGENTS.md`: the vault, the memory note), the user's catalog of counterparties and folders (`catalog.yaml`), a personal backlog, personal working material — notes, drafts, a CV under work — under any name that does not start with `.`; the stores the tools keep under dot names, closed to the agent: tokens (`.env`), sign-ins (`.secrets/`), the shared browser's profile (`.browser/`) | the installation's `.local/` (git-ignored as a whole) | this machine's user |
| Knowledge, final documents, personal agent memory | where the installation's `AGENTS.md` says (a vault, a knowledge base) | the user and their organization |

**oikos's own files are not changed in ordinary work** — only the installation's files and the
places its `AGENTS.md` names. A change useful to every user is proposed to the user and made in
the oikos repository. The installation's own files hold only what agents read and use — never
documents, drafts or working materials; the user's drafts and working material may live in
`.local/` under a name that does not start with `.`, while its dot-named stores (tokens, sign-ins,
the shared browser's profile) are never read or written by file tools. Nothing that names the
organization — hosts, projects, people, task keys — goes into oikos.

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

The skills are `oikos/skills/<name>/SKILL.md`, one per kind of work, in groups:

| Group | Skills |
|---|---|
| engineering | `code-hosting`, `task-tracking` |
| collaboration | `messaging`, `wiki`, `workspace` (mail, files, calendar) |
| files | `documents`, `catalog` |
| web | `browser` |
| hr | `cv`, `footprint` |

The agent host is given a pointer to each one (`.claude/skills/`, `.qwen/skills/` of
the installation, written by `node oikos/tools/sync/cli.mjs`), lists them with their triggers and
loads the one a request matches.

A skill drives **connectors** — `skills/<name>/connectors/<connector>.md`, each with its tool
(`tools/<connector>/cli.mjs`). Which connectors this installation uses for a skill, the first
being the default, is `connectors:` in the installation's `oikos.yaml`; the user's words (a named
service, a pasted URL) pick another of them. A skill left out there, or with an empty list, uses
no connector. A connector's tool runs only in an installation that lists it there — elsewhere it
stops before any credential, so a token exported in the shell never works for an organization that
does not use the connector, and only a listed connector's token is asked for. `node oikos/tools/landscape/cli.mjs skills`
shows every skill, by group, with its connectors and the ones used here (`skills <name>` for one).

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
was shown, and only after the user has answered; otherwise it is denied with the reason. The hook
compares the whole shell command, so a dry run and its real write are each **one standalone
command, identical except `--dry-run`** — no `;`, `&&` or `|` chained around either, no
redirection or substitution (`--dry-run;` is not a dry run).

**What goes out names no assistant, no local path and no secret.** Text written into the
organization's systems is English and never mentions oikos, its files or command lines
(`oikos.yaml`, `node oikos/tools/…`, `skills/<skill>/`), a path of this machine (`/home/<name>/`,
`/tmp/`, the scratchpad, `.local/`, `file://`), a token or key, or a word of the installation's
own list (`terms:` in `.local/outgoing.yaml`). Every tool write checks its text — titles, bodies,
comments, a `--file`'s content, an image's name and alt text, a text attachment — in the dry run
and the real run alike: the dry run lists each flagged line (`CHECK`, a secret masked) and exits 3
with `flagged: content check:`; the real run refuses with exit 3 and `refused: content check:`.
Fix the text; when a finding is meant (a path the reader needs), show it to the user and, once
they agree, add `--allow-flagged` to both the dry run and the write (`--allow-non-english` covers
non-English text only). A secret is never posted: the flag does not cover it. A line the
installation always lets through goes under `allow:` in `.local/outgoing.yaml` (literal strings).
What an image, an office file or a PDF carries is not read — look at it before attaching. Routes
no tool writes — the messenger, a mail draft, a form in the shared browser, a vault note to be
shared — follow the same rule: run the draft through `node oikos/tools/outgoing/cli.mjs check
--text "…"` (or `--file`), read-only, before showing it for confirmation.

**Sign-in.** Web resources usually sign in through the organization's SSO. The agent never
types passwords or MFA codes; the person signs in — in claude.ai for a connector, or in the
shared browser — and the agent works through that. API tools use personal tokens (below).

### Who "me" is

Questions like "my tasks", "my goals", "my merge requests", "my mail" are answered for the
person whose credentials the session uses — normally the user in front of you:

| Connector | "Me" is | How to check |
|---|---|---|
| jira, confluence | the account of `JIRA_EMAIL` (`currentUser()` in JQL/CQL) | `node oikos/tools/jira/cli.mjs whoami` |
| gitlab, gitlab-issues, gitlab-wiki | the owner of `GITLAB_TOKEN` | `node oikos/tools/<connector>/cli.mjs whoami` |
| github, github-issues, github-wiki | the owner of `GITHUB_TOKEN` / the `gh` login | `node oikos/tools/<connector>/cli.mjs whoami` |
| google | the account of the route in use: mail over IMAP, the shared browser, the Drive app or the connector | `node oikos/tools/google/cli.mjs whoami` (mail); skill `workspace` |
| slack, other claude.ai connectors | the account that connected the connector in claude.ai | the connector's own profile |

For a colleague, pass their work email — on GitHub and GitLab their login — (`--user`, `--owner`, `--assignee`). If the identities
disagree (a connector signed in as someone else), say so before answering.

### Credentials and settings

Personal tokens go in the installation's `.local/.env` (git-ignored, mode 600). The installation's
own files win: `.local/.env`, then `settings` of `oikos.yaml`, then the shell environment — only a
fallback, since every installation on the machine shares it. Keys: `JIRA_EMAIL`,
`JIRA_API_TOKEN` (Jira and Confluence), `GITLAB_TOKEN`, `GITHUB_TOKEN`; optional `GMAIL_APP_PASSWORD` (Gmail over IMAP). Site settings
that are not secret — `JIRA_BASE_URL`, `GITLAB_URL`, `GITHUB_ORG`, … — are `settings:` in
the installation's `oikos.yaml`. Connectors need no token: connect them in claude.ai → Settings →
Connectors with the work account. The user types a token in their own terminal with
`node oikos/tools/setup/cli.mjs token` (no echo, straight into `.local/.env`; with no key named it
asks for each one not yet there — missing, or only in the shell environment or `oikos.yaml`); each
tool's `whoami` shows which are set and where from. A command whose credentials or site settings
are missing stops with exit 1 and names the missing keys — it never falls back to a dry run. Never print a secret, never ask for one in the chat, never put one into
a document; a hook denies reading `.env` files and printing the environment.

**Git.** Stage by name (`git add -A` and `git commit -a` are denied by a hook); `git push`, a
merge request or a pull request only on the user's explicit request — the hook asks, and
outside the default permission mode denies, so the user runs it with `! git push`. No `sudo`.

## Documents

1. The final document goes where the installation's `AGENTS.md` says (a vault's inbox, a folder),
   never into `.local/`; a draft goes there too, or, if the user keeps working on it, into a
   working folder in `.local/` (any name not starting with `.`); throwaway intermediate files go
   to the session scratchpad. None goes into oikos or the installation's own files.
2. Facts come from the knowledge base (above).
3. An office file (docx/pdf/pptx/xlsx) — skill `documents`; on-brand — the organization's brand
   skill named in the installation's `AGENTS.md`; the look of `from-markdown` is `brand:` in
   `oikos.yaml`.

## Context economy

- A subagent writes a large result — a report, a dry run, a sweep — into a file and returns a short
  summary; the session reads large files in parts (`grep` first, then offset and limit).
- Prefer compact dry runs: Jira dry runs of a text over 2000 characters print its size, outline and
  a diff by default; `--full` shows all of it.
- Before a long session runs out, park the work package:
  `node oikos/tools/handoff/cli.mjs park --task PROJ-123 --title "<title>" --from <file or folder>…`
  (`--name <slug>` for work with no task key) shows what it would copy and write; with `--yes` it
  copies the files to `.local/proj-123/` (names kept; a name taken by other content only with
  `--replace`), writes a `HANDOFF.md` skeleton when there is none, sets the task's line in
  `.local/TASKS.md` (`- PROJ-123 · <title> · parked · [handoff](proj-123/HANDOFF.md)`) and prints
  the prompt that resumes it. Then fill `HANDOFF.md` under its headings — Where things are, Agreed
  rules, Decisions, Next steps, How to start. `list` shows the parked packages.
- Without the tool, do the same by hand: copy the session's working files to
  `.local/<task-key-lowercase>/` (a working folder: its name never starts with `.` and is never a
  closed store's — `browser`, `google` — or the next session cannot read it; only files from the
  installation or the scratchpad, never an `.env*` file, a closed store or a dot-named entry outside
  a working folder of `.local/`), write `HANDOFF.md` there under the same headings, and add or
  update the task's line in `.local/TASKS.md`.

## Shared experience

Short dated entries useful to **every** user: document structures, tracker and sprint
techniques, pitfalls. Nothing about one organization; experience about developing oikos goes to
DEVELOPMENT.md.

- none yet
