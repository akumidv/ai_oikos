# draft-and-create — from the agreed table to tasks and messages

Starts only from a table the user has agreed (`plan.md`). One unit at a time, or a batch the user
names; every write passes the gates of the skill that owns it.

1. **Facts first.** For a unit that needs them — the existing tasks on the same subject, the page
   or the repository the text will mention — have a worker read them and write `facts-<n>.md` in
   the topic; what comes back is a few lines with links **from tool results**. Where the host has no
   workers, read them yourself and keep the output out of the notes.
   **A person a draft names** (an assignee, a mention) is the one the table already resolved: take
   the id from `node oikos/tools/people/cli.mjs find <alias> --account <tracker>`, not from memory.
   A person new since the table is resolved the way the digest does — the people file, then the
   connector's search, then `people add` as a preview, written only after the user's yes.
2. **Draft the text** in the project's shape into `draft-<n>.md` (never over an existing file):
   - a **task**: title, then *Goal*, *What to do*, *Done when* — English, "Done when" checkable;
     the project, type, assignee, epic and labels as the project's rules and the tracker connector
     ask ([task-tracking](../../task-tracking/SKILL.md)); a conditional follow-up as a section;
   - a **comment**: the text for the task it goes on, in the language of that task's thread;
   - a **message**: in the language and register of the channel, with the keys of the tasks it
     refers to — the keys exist only after those tasks are created, so a message is drafted last;
   - a **document**: where it goes (a wiki page, a file) and its outline, not the whole text,
     unless the user asked for the whole.
   Mark every guess `(?)`. Set the unit's status to `drafted` in `plan.md`.
3. **Show the draft to the user** and take corrections. Do not create anything yet.
4. **Dry run.** The create command of the connector with `--dry-run` — the content check (ADR 0003)
   runs here and may flag the text; fix the text or ask. Show the dry run as it is.
5. **On the user's yes, run the same command without `--dry-run`**, standalone, exactly as shown.
6. **Record it at once, per unit**: in `plan.md` the status `created` and the key; one line of
   the reason in the row's source column when it is not obvious. The draft is now redundant —
   the tracker holds the text — and compression does not wait for the topic to close. If the
   tracker and `plan.md` ever disagree, the tracker wins.
7. **Messages last.** Put the created keys into the message drafts, show each, and send only
   after its own confirmation (the dry run of the messaging connector, then the same command).
   A sent message is `sent` with its link.
8. **A failure** (the connector refuses, the content check flags, a key is unknown) is reported
   as it came, the unit stays `drafted`, and nothing is retried in another way.

A **status move** the user wants along the way ("and put it in Review") is not part of this
scenario: say that it goes through `move-task` under the project's rule, and do it only as that
scenario says. When every unit is `created`, `sent` or `dropped`, the topic can be closed — the
desk agent's *Closing a topic*.
