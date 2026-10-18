# Route: the Google Drive folder

With **Google Drive for desktop** installed and signed in (the corporate account), Drive is an
ordinary folder, and its files are read and written like any local file — no token, nothing in
the Claude cloud.

## Where it is

`node oikos/tools/google/cli.mjs drive` finds it and lists its top-level folders (`My Drive`,
`Shared drives`, in the system's language). Order: `OIKOS_GDRIVE_PATH` (`.local/.env`, or the
shell as a fallback), the catalog root `@gdrive`, then the usual places:

| Environment | Usual place |
|---|---|
| Windows | a drive letter labelled "Google Drive" (`G:\`) |
| WSL | the same Windows drive as `/mnt/<letter>/` — WSL does not mount it by itself; `drive` names the `mount` command for the user to run (oikos does not use sudo) |
| macOS | `~/Library/CloudStorage/GoogleDrive-<account>/`, one per account; the one of the organization's domain is taken |
| Linux | no official client — use the browser route |

Drive mounted as a folder somewhere else: `OIKOS_GDRIVE_PATH`. When `drive` found it by
searching, it prints the command that remembers it as the catalog root `gdrive` (preview, then
`--yes` after the user agrees); then catalog paths like `@gdrive/My Drive/Clients` work too.

## Working with it

- Office files (docx, xlsx, pdf): as local files — skill `documents` (a new document from an
  existing one: its `from-existing` scenario). A new file next to the source is uploaded by the
  Drive app itself.
- `.gdoc`, `.gsheet`, `.gslides` are only links (a small JSON with the document's id), not the
  content. `node oikos/tools/google/cli.mjs link <file>` gives the id, the account, the URL to open and
  the export URLs; read the content through the browser route with them (`browser.md`,
  Drive and Docs). The link's account should be the corporate one.
- Files marked "online only" are fetched by the Drive app when opened; a slow first read is
  normal.
- Deleting or moving a file here deletes or moves it on Drive for everyone who sees it —
  a confirmed step, as in SKILL.md.
