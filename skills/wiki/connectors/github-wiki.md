# Connector: github-wiki

The GitHub wiki of a repository, for the skill `wiki`. One tool:
`node oikos/tools/github-wiki/cli.mjs <command>`; `--json` gives the raw payload.

The GitHub wiki has no API: it is the git repository `<repo>.wiki.git`. Every command clones it
into a temporary folder that is removed when the command ends — nothing is kept in `.local/`, so
every command sees the wiki as it is now. Pages are flat files: `Page-Name.md` (shown as
"Page Name"), `Home.md`, `_Sidebar.md`, `_Footer.md`; pages in other formats (`.textile`, `.rst`,
`.asciidoc`, `.org`, `.wiki`, …) are read as raw text and never written.

**Never fetch a wiki URL with a web-fetch tool, and never clone the wiki yourself** — the tool
holds the credential; a shell clone would put it in reach of the shell.

## Which repository, which page

- `--repo owner/repo` (or `repo` under `GITHUB_ORG`); without it `GITHUB_WIKI_REPO`, else
  `GITHUB_REPO`. A wiki URL in `--page` names its repository itself.
- `--page` takes a page name (`"Release Notes"` → `Release-Notes.md`), a file name
  (`Old-Page.textile`), or a wiki URL (`https://github.com/acme-corp/tools/wiki/Release-Notes`;
  `…/wiki` alone is `Home`). Names match exactly first, then ignoring case.

## Find and read

```bash
node oikos/tools/github-wiki/cli.mjs search --title "release" [--repo acme-corp/tools]
node oikos/tools/github-wiki/cli.mjs search --query "importer" [--limit 25]   # lines, with a line of context
node oikos/tools/github-wiki/cli.mjs read --page "Release Notes"
node oikos/tools/github-wiki/cli.mjs info --page <name|file|URL>   # file, format, last commit (sha, date, author), URL
node oikos/tools/github-wiki/cli.mjs whoami                        # the token owner and the commit identity writes use
```

GitHub's search does not index wikis (unverified until checked live), so `search` searches the
clone: `--title` against page titles, `--query` against every line, both ignoring case.

## Write — dry-run, show, confirm, write

```bash
node oikos/tools/github-wiki/cli.mjs create --title "Onboarding" --file <scratchpad>/page.md --dry-run
node oikos/tools/github-wiki/cli.mjs append --page Home --heading "Sprint 26 summary" --file <scratchpad>/section.md --dry-run
node oikos/tools/github-wiki/cli.mjs replace-section --page Home --heading "Rollout" --file <scratchpad>/section.md --dry-run
```

- Run `info` (or `read`) before every write: it confirms the page and the wiki's commit.
- The body is markdown and is written as given. Content is **English** — the tool refuses
  non-Latin text unless `--allow-non-english` is passed.
- The dry run clones, applies the change in memory and prints the repository, the page, the base
  commit, the current text (the section, or the end of the page for `append`) and the new text,
  the commit message and identity; it pushes nothing.
- `create` refuses when the page exists; the wiki is flat, so `--parent` is refused — link the new
  page from another page or from `_Sidebar` instead.
- `replace-section` replaces the body under a heading up to the next heading of the same or higher
  level, keeping the heading; a missing or repeated heading lists the page's headings and stops.
- `append`: `--heading-level` (default 2), `--at-start` to insert at the top (after any front
  matter); a page that ends inside an unclosed code fence is refused — fix the page first.
- `--version-message` is the commit message (default `Update <page> (oikos)`,
  `Create <page> (oikos)` for a new page).
- Show the user the dry run and write only after they confirm.

## Guards

- **Public repository:** the wiki of a public repository is visible to anyone. Its dry run prints
  `PUBLIC repository <owner/repo> — everything written is visible to anyone`, and every write to
  it — dry run or not — is refused (exit 3) unless the repository is listed in the setting
  `GITHUB_PUBLIC_REPOS`.
- **Not markdown:** a write to a page in another format is refused (exit 3) with the page's URL —
  a person edits it in the web interface.
- **Identity:** a commit is made as the token owner — login and
  `<id>+<login>@users.noreply.github.com` — never with the machine's git identity, which may belong
  to another organization.
- **No force, no rebase:** if the wiki changed between the clone and the push, the push is rejected
  and the tool stops with "the wiki changed since; run the dry run again" (exit 2). Run the dry
  run again, show it, and write only after the user confirms again.
- A push is visible at once; there is no undo here — a person reverts a page in its history on
  GitHub.
- **No wiki yet:** GitHub creates the wiki repository only when the first page is made in the web
  interface. Until then every command stops and names `<server>/<owner>/<repo>/wiki`, where a
  person makes the first page.

## Credentials and settings

| Key | Where | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | `.local/.env` | the token; without it the `gh` login (`gh auth token`) |
| `GITHUB_ORG` | settings | the owner of a bare `repo` name |
| `GITHUB_WIKI_REPO` | settings, optional | the default wiki repository |
| `GITHUB_REPO` | settings, optional | the default when `GITHUB_WIKI_REPO` is not set |
| `GITHUB_PUBLIC_REPOS` | settings, optional | public repositories whose wiki may be written (comma separated `owner/repo`) |
| `GITHUB_API_URL`, `GITHUB_SERVER_URL` | settings, optional | GitHub Enterprise Server (untested) |

The token reaches git only through the environment of the git process (an `http.extraHeader`) —
never the command line, the URL or a config file. Which tokens reach wiki git is **unverified until
checked live**: a fine-grained token may not reach it at all; a classic token with the `repo`
scope, or the `gh auth login` session, is expected to read and push. If the token is refused, the
tool says so and names this route.

Without a credential every command stops with exit 1 and names the missing key, before any request
— the dry runs too: they clone the wiki and read the repository's visibility.

## Not here, on purpose

- **Delete, rename or move a page; restore an old version** — a person does it on GitHub: the
  page's **Edit** and **Page history** on `<server>/<owner>/<repo>/wiki/<Page>`.
- **Turn the wiki on, make its first page, or change who may edit it** — the repository's
  Settings → Features → Wikis on GitHub.
- **Write a page in another format than markdown** — the web interface.
- **Pages under a parent** — the GitHub wiki is flat; link pages from `_Sidebar` instead.
- **`search --mine`** — not offered.
