# Scenario: a new document from an existing one

The user wants "the same document, with this changed": the next invoice from the last one, next
month's acceptance report, a letter to another addressee, a filled-in template. **Edit a copy of the existing
file, never regenerate it** — the layout, tables, fonts and details stay exactly as they were.
The new document keeps the source's language.

Formats: `.docx` (a legacy `.doc` is converted first, step 1). Other formats are not covered
yet.

## Steps

0. **Find the files** through the catalog (skill `catalog`): `node oikos/tools/catalog/cli.mjs find
   <counterparty> --files --match "<type or number>"`. A path that does not exist: the tools
   name the similar files (`no such file … similar to …`); ask which one was meant — never pick
   between two candidates.
1. **Read the source**: `node oikos/tools/documents/cli.mjs text <file.docx>` — numbered paragraphs
   (body, then headers/footers/notes). `--runs` shows how Word split a paragraph into runs. A
   `.doc`: `node oikos/tools/documents/cli.mjs render <file.doc> --format docx --out-dir <scratchpad>`
   and work from that copy.
2. **Decide every change** from the source and the request — typically the number, the date,
   the period, amounts and the amount in words, the addressee. Derive the pattern from the
   previous document (an invoice dated the last day of the month before the period, numbers
   following on) and name each assumption to the user. Fix obvious typos only in the lines you
   touch (a missing space).
3. **Preview**: `node oikos/tools/documents/cli.mjs replace <file.docx> --set "old=>new" [--set …]
   [--drop-row "text in the row"]` — each changed paragraph, before → after, and each table row
   that goes (a line that no longer applies: electricity this month). `--drop-row` must match
   exactly one row; text inside a dropped row is not replaced. Make each `old` long enough to be unique (`No. 12 of
   31 August`, not `12`). A match works across runs, not across a tab, a line break or two
   paragraphs; a pair that matches nothing stops the command and nothing is written.
4. **Write a new file** where the user keeps these documents — by default next to the source,
   named like its neighbours: the same command with `--out <new.docx>`. It refuses to overwrite
   the source or any existing file. A later fix to the file this task made: the same command with
   `--in-place` on it (the previous version is kept in the temp folder) — never on the source.
5. **Look at the result**: `node oikos/tools/documents/cli.mjs render <new.docx> --out-dir
   <scratchpad>` gives a PNG of the first page (`--format pdf` for every page); read it and
   compare with the source. Without LibreOffice `render` says how to get it (SKILL.md, Tools).

6. **Catalog**: if the task showed where a counterparty's or domain's materials are and the
   catalog does not know it yet, propose the `add` (skill `catalog`).

## Report

What changed, line by line; each assumption; the path of the new file. The source is never
modified. Sending the document is a separate step (`google`, `slack`), with confirmation.
