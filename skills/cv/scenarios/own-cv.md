# Scenario: the user's own CV, kept from facts

The user keeps their own CV and wants it true and current: every claim backed by a fact with a
source, refreshed from the systems rather than from memory, and written so it does not read as
generated. The CV is written only from a facts table; the table is what is maintained.

## Where it lives

In the installation's `.local/` — e.g. `.local/cv/`: `facts.md` (the table), `cv.md` (the current
CV), and the previous versions kept beside it (`cv-<date>.md`) for a diff. Nothing of it goes to the
knowledge base, a wiki or a shared note unless the user asks.

## The facts table

One row per fact a bullet may rest on:

| Fact | Value | Source | Date | Status |
|---|---|---|---|---|
| Merged pull requests, 2026 | 142 | `footprint collect --me --since 2026-01-01`, github | 2026-10-21 | ok |
| Led the move to the new billing service | — | the user | 2026-10-21 | user |
| Cut report generation from 2 days to 3 hours | — | the knowledge base, page on the report service | 2026-09-30 | open |

- **Value** — the number or the statement, as short as it can be.
- **Source** — where it came from: a `footprint` query (its command), a document, a page in the
  knowledge base, the user's own word.
- **Date** — when it was last checked.
- **Status** — `ok` (checked against the source), `user` (the user's word, not checkable in the
  systems), `no` (checked and not true, or not supported: it does not go into the CV), `open`
  (not checked yet).

Facts about the products and the organization's work (what a system does, its scale, its users)
are cited from the knowledge base the installation names in its `AGENTS.md`, not from memory.

## Steps

1. **Write only from rows.** Each bullet of the CV rests on one or more rows with status `ok` or
   `user`; a claim with no row gets a row first (`open`), and is checked before it goes in.
2. **Refresh.** Re-run the `footprint` queries the rows name (the `footprint` skill,
   [period-report](../../footprint/scenarios/period-report.md)) and update value and date; then
   go through the CV bullet by bullet — does each still rest on its rows, does each number match.
   A row whose source no longer supports it becomes `no`, and its bullet is rewritten or dropped.
3. **Regenerate** the changed bullets by the rules of [ai-signs.md](ai-signs.md) § Rewriting the
   user's own CV: one verb, a concrete outcome with its number, plain hyphens, the referent named.
   Then check the new text against the signs in that scenario.
4. **Keep the previous version** (`cv-<date>.md`) and show the user the diff: which bullets
   changed, which rows they rest on now.
5. **Files.** A .docx or PDF of the CV is made with the `documents` skill; sending it anywhere goes
   through `messaging` or `workspace`, with confirmation.
