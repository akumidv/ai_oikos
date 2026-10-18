# Connector: gitlab-wiki

The wiki of a GitLab project, over the REST API, for the skill `wiki`. One tool:
`node oikos/tools/gitlab-wiki/cli.mjs <command>`; `--json` gives the raw payload.

The project is `--project group/name`, else the setting `GITLAB_WIKI_PROJECT`, else
`GITLAB_PROJECT`. `--page` takes a slug (`guides/Release-Notes`), a title (`Release Notes`), or
the page's URL (`<GITLAB_URL>/group/project/-/wikis/<slug>` — the project then comes from the URL).

## Find and read

```bash
node oikos/tools/gitlab-wiki/cli.mjs search --query "rollout" [--project acme-corp/handbook] [--limit 25]
node oikos/tools/gitlab-wiki/cli.mjs search --title "release"        # titles and slugs only
node oikos/tools/gitlab-wiki/cli.mjs read --page "Release Notes"     # the current text, as stored
node oikos/tools/gitlab-wiki/cli.mjs info --page <slug|title|URL>    # title, slug, format, content hash, URL
node oikos/tools/gitlab-wiki/cli.mjs whoami                          # the token's user, and whether it can write
```

- `search --query` is GitLab's wiki full-text search plus a title filter over the page list.
  Without Advanced Search an instance may refuse or limit the full-text part (unverified until
  checked live); on a refusal (HTTP 400 / 403) the tool falls back to titles and says so.
- A page in another format than markdown (AsciiDoc, RDoc, Org) is read as raw text.

## Write — dry-run, show, confirm, write

```bash
node oikos/tools/gitlab-wiki/cli.mjs create --title "Setup" [--parent guides] --file <scratchpad>/page.md --dry-run
node oikos/tools/gitlab-wiki/cli.mjs append --page "Release Notes" --heading "1.2" --file <scratchpad>/section.md --dry-run
node oikos/tools/gitlab-wiki/cli.mjs replace-section --page "Release Notes" --heading "1.1" --file <scratchpad>/section.md --dry-run
```

- Run `info` (or `read`) before every write: it confirms the page, its format and its content hash.
- Bodies are markdown, written as given. Content is **English** — the tool refuses non-Latin text
  unless `--allow-non-english` is passed.
- `create` makes a markdown page and refuses (exit 3) when the slug exists. `--parent` puts the
  page under that path: the slug becomes `parent/Title` (GitLab makes a nested page from a title
  with `/`, and the slug from the title with spaces as hyphens — unverified until checked live). A
  parent that names no page is taken as a new folder, and the dry run says so.
- `replace-section` replaces everything under a heading up to the next heading of the same or
  higher level, keeping the heading. If the heading is missing or not unique, it lists the page's
  headings and stops (exit 1). Headings inside code fences and YAML front matter do not count.
- `append`: `--heading-level` (default 2), `--at-start` to insert at the top (after the front
  matter, which stays first). A page that ends inside an unclosed code fence is refused: fix the
  page first.
- Every dry run reads the page and shows the project, the page and slug, the **Base** content hash
  (`sha256:` + 12 hex digits), the current text (the section, or the end or start of the page) and
  the new text. It makes only GET requests.
- Show the user the dry run and write only after they confirm.

## Guards

- Every edit rewrites the whole page (read-modify-write). The GitLab wiki API takes no base version
  on a write (unverified until checked live), and the confirmed command must be the dry run's
  command, so there is no `--base` pin. Instead the write re-reads the page right before the PUT
  and prints `applied to <hash>`: when that differs from the dry run's **Base**, the page changed
  in between — tell the user, read the page, and run the dry run again. A change made between the
  write's own re-read and its PUT is **not detected**.
- The API returns no page version that the tool could check (unverified until checked live);
  `info` says so.
- Writes to a page in another format than markdown are refused (exit 3, the page's URL printed).
- The title of an edited page is never changed: the write sends the content only.

## Credentials and settings

| Key | Where | Purpose |
|---|---|---|
| `GITLAB_URL` | settings | the GitLab site |
| `GITLAB_TOKEN` | `.local/.env` | writes need scope `api`; `read_api` is enough for reads |
| `GITLAB_WIKI_PROJECT` | settings, optional | the default wiki project |
| `GITLAB_PROJECT` | settings, optional | the default project when `GITLAB_WIKI_PROJECT` is not set |

The token is the same one the `gitlab` and `gitlab-issues` connectors use. Without the site or the
token every command — dry runs included, since every dry run reads the page — stops with exit 1
and names the missing keys, before any request. `whoami` warns when the token has no scope `api`.

## Not here, on purpose

- **Group wikis** — later; for now a person edits them in GitLab (`<GITLAB_URL>/groups/<group>/-/wikis`).
- **Deleting, moving or renaming a page**, and uploading attachments — a person does them in the
  wiki's web interface.
- **Writing a page in another format than markdown** — a person edits it in GitLab.
- **`search --mine`** (pages I edited) — not offered; GitLab's wiki history is in the web interface.
