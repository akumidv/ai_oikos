---
name: catalog
description: The user's local catalog of counterparties and domains, with tags, and the folders and files where their materials are, kept in .local/catalog.yaml and grown as work goes on — so "show the invoices of X", "where are the contracts for Y", "the latest acceptance report for a project" is a lookup, not a search over the disk. Triggers on a company or person the user works with named in a request about their documents, "invoices of", "acceptance reports for", "where are the documents of", "which counterparties do we have", "remember this folder", "add to the catalog", or any task that starts from a path the user gives in their own folders.
when_to_use: Before searching the user's local folders for a counterparty's or a domain's documents, and after a task that found where such materials live.
metadata:
  owner: oikos
surface: .local/catalog.yaml — named roots, domains and counterparties with their folders, files and notes; lists the files in those folders
refuses: storing document contents, requisites copied out of documents or secrets in the catalog (it holds where things are, not what they say), and searching the whole disk when the catalog does not know an entry (ask the user where the materials are instead)
---

# catalog

Where the user's materials are: named **roots** (top folders of their documents), **domains**
(an area of work: a project, a vendor, taxes) and **counterparties** (companies and people),
each with its folders, notable files, **tags** and a short note. It lives in `.local/catalog.yaml`, one
file per machine, never committed. The session-start hook puts its summary into the context,
so the agent knows from the first message which counterparties and domains exist.

```bash
node oikos/tools/catalog/cli.mjs summary                                   # roots, one line per entry
node oikos/tools/catalog/cli.mjs find "ACME"                               # by id, name or alias: folders, files, note
node oikos/tools/catalog/cli.mjs find "ACME" --files --match "invoice"     # files in its folders, newest first
node oikos/tools/catalog/cli.mjs find apollo --files --since 2026-01-01 [--depth 3] [--limit 30]
node oikos/tools/catalog/cli.mjs find --tag client                         # by tag; with a query both must match
node oikos/tools/catalog/cli.mjs tags                                      # tags in use and who carries them
node oikos/tools/catalog/cli.mjs add counterparty acme-corp --name "ACME Corp" --alias "ACME" \
  --tag client --domain apollo --folder "<abs path>" --file "CARD ACME Corp.docx" --note "…"   # preview
node oikos/tools/catalog/cli.mjs add … --yes                               # writes
node oikos/tools/catalog/cli.mjs add domain apollo --name "Project Apollo" --folder "<abs path>"
node oikos/tools/catalog/cli.mjs add root business "<abs path>"
node oikos/tools/catalog/cli.mjs check                                     # missing folders, shared aliases, unknown domains
```

## How it is used

1. **Start from the catalog.** A request that names a counterparty or a domain: `find` it, then
   work in its folders. `--files --match` narrows by words in the file name (case and
   diacritics are folded, quotes ignored). Files are ordered by the date at the start of the name
   (`20260930 Invoice 14.docx`);
   a `*` after the date means the name has none and mtime was used.
2. **Not in the catalog**: ask the user where the materials are — do not walk the whole disk.
3. **Grow it as you go.** When a task has shown where a counterparty's or domain's materials
   are — a folder the user named, a card with requisites, a new alias seen in documents — say
   in one line what you would add, run `add` (preview) and write with `--yes` once the user
   agrees. Extending is additive: `add` merges lists (aliases, domains, folders, files) and
   replaces `name`/`note` only when given.
4. **Domain or tag.** A domain is an area with its own folders (a project, a vendor); a
   counterparty belongs to one or a few. A tag is a kind that cuts across domains (`client`,
   `supplier`, `bank`, `tax`) — for "all clients", "everything about taxes". A domain's tags
   are inherited by its counterparties. Run `tags` before inventing one and reuse what is
   there; tags are stored lowercase, spaces as `-`, without `#`.
5. **Paths**: give absolute paths; one under a root is stored as `@<root>/…`, so moving a root
   means changing one line. A file may be relative to the entry's first folder.

## Format

```yaml
version: 1
roots:
  business: /path/to/Business
domains:
  apollo:
    name: Project Apollo
    tags: [client, project]
    folders: ["@business/Projects"]
counterparties:
  acme-corp:                       # id: latin lowercase, digits, '-'; never renamed
    name: ACME Corp
    aliases: [ACME, Acme]          # other spellings seen in names and documents
    tags: [client]                 # plus the tags of its domains
    domains: [apollo]
    folders: ["@business/Projects/ACME/20260717 Acme SOW"]
    files: [CARD ACME Corp.docx]
    note: How documents for it are made (numbering, dates), in a sentence or two.
```

The file may be edited by hand; `check` finds what went wrong. Requisites (tax ids,
addresses, signatories) stay in the documents — a card file is referenced, not copied.
