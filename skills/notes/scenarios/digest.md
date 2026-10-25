# digest — the table of units

The user asks for the summary ("what do we have", "sum it up", "make a digest"). The result is a
table, not texts: **nothing is drafted until the user has agreed it.**

1. **Read** the topic's `notes.md` (the cleaned text; the original when a guess matters). One
   topic, or — when the user asks — the open topics together.
2. **Group the pieces into units**. A unit is what one task, one comment, one message or one
   document will be; several notes that say one thing are one unit, one note that asks for two
   things is two. Each unit gets:

   | Column | What it says |
   |---|---|
   | unit | a short name in the user's words |
   | kind | `task`, `comment` (on an existing task), `message`, `document`, or `conditional task` (only if something is found) |
   | where | the project and the assignee, or the channel or person for a message — `(?)` where the notes do not say |
   | source | which notes it comes from (the time of the entry) |
   | open question | the one thing that blocks drafting it; empty when none |

   **Resolve a person before the table is shown.** A name or alias in the `where` column is looked
   up with `node oikos/tools/people/cli.mjs find <alias>` and, for the tracker the unit goes to,
   its account (`--account jira`). Several matches — ask which; none — ask the user, or search with
   the connector's own means, and when the person is found offer
   `people add "<name>" --alias <alias> --account <system>=<id>` (a preview; `--yes` after the
   user's yes). Say once that `.local/private.yaml` holds personal data on purpose and is git-ignored.
3. **Show the table and stop.** Say what you could not place and ask the open questions in one
   message, most blocking first. Do not offer texts "to save time".
4. **The user corrects the split** — merges, splits, drops, moves a unit to another project, changes
   a kind. Each correction updates the table; show the table again when it changed more than a row.
5. **When the user agrees the table, write it into `plan.md`** (every unit `open`, no key yet) and
   run `node oikos/tools/desk/cli.mjs index`. The agreed table is the input of `draft-and-create`.

A unit the user drops is marked `dropped` with the reason, not removed. A new note after the table
was agreed is captured as usual and joins the table at the next digest.
