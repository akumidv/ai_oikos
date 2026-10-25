# Scenario: reviewing a task's result

The user (or the desk agent) names a task and asks whether its result meets what was asked: "is
PROJ-123 done", "review what came in for PROJ-123", "judge these before I move them". The output
is a **verdict**, then — only on the user's yes — a comment to the assignee or a proposal to move.
Moving itself is [move-task.md](move-task.md); this scenario is what comes before it.

Reading a task, its attachments and its pull requests is each connector's own (Jira —
[connectors/jira.md](../connectors/jira.md) § Read; the issue trackers' files list the same
`info`, `context` and `attachment`). Nothing here writes until the last step.

## Steps

1. **Read the ask.** `context` (or `info --extended`) for the task: its "Done when", the comments
   (the narrowing often lives there), the links, the attachments and the pull requests. A task with
   **no "Done when"** (an older one) is judged against its description, and the verdict says so.
   Fetch every attachment that may hold the result or the ask, and read it.
2. **Find the result.** It is one of three, and may be several:
   - a **document** — a wiki page, a file on the drive, an attachment: read it as it is now
     (the `wiki` or `workspace` skill, or the attachment);
   - a **comment** — the assignee wrote the outcome out: read what it claims and what it links;
   - **code** — a pull request found by the tool (its dry run lists the pool's search, then the
     commits): read its title, description, state and checks through `code-hosting`. A pull request
     that is about another task (a typo in a prefix) is left out, as in move-task.
   Link only what a tool result or the user gave; anything else is marked `(?)`.
3. **Judge each "Done when" item** as met, partly met, not met or **cannot tell**, with the evidence
   for it (a link or a quoted line). A result that exists but cannot be read by the agent (a
   private page, a binary) is `cannot tell`, never `met`. Do not review the code's quality here:
   the question is whether the task's ask is satisfied; a code review is the review skill's.
4. **Write the verdict** — the item table, a one-line overall (`meets`, `partly`, `does not`,
   `cannot tell`) and the open questions — into a desk topic: `node oikos/tools/desk/cli.mjs new
   review-<key>` for a task the desk did not open, else the task's own topic. Show it in the chat.
5. **Offer the next step, and do nothing without a yes.** Either:
   - a **draft comment to the assignee** (what is missing, mention the assignee as the connector
     file says): `comment --dry-run`, shown, written only on the user's yes; or
   - a **proposal to move**: the move goes through `move-task` with the mode of the project's rule.
     `confirm` is the most the agent may do; a rule of mode `person`, or a `person_only` policy,
     refuses the move as it refuses anyone. The verdict is the evidence for the question there.
   A verdict other than `meets` is never a proposal to move forward.

## A pass over many tasks

Read each task with the same steps and show **one table** (key, result, overall, next step), then
ask once. A task whose result cannot be judged is listed, not guessed. A move for several tasks
follows move-task's own pass over many.

## Not this scenario's

Code review of a pull request, and anything that writes into an outside project (a later phase,
after the mounts design), and moving without the verdict.
