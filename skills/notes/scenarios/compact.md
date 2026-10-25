# compact — old topics become a card and a line

Old topics are kept short so they are found fast. Retention is by the topic's **last activity**
(its newest file): over 30 days — `card.md` and `summary.md` stay, the raw notes and drafts move to
`_archive/<YYYY-MM>/…`; over 90 days — one line stays in `INDEX.md`, the card and summary move too.
The thresholds are the `desk:` part of `oikos.yaml` (`warm_days`, `cold_days`) or the flags of the
command. **Nothing is deleted.** The agent offers this; it never runs it unasked.

1. **See the plan.** `node oikos/tools/desk/cli.mjs compact` shows, per topic, what would move or why
   it stays. Read the skips:
   - *has open units — stays hot*: an idea not yet turned into a task must not compress to nothing;
   - *needs card.md and summary.md*: the topic is done but not written up — see the next steps.
2. **Write what is missing.** A topic ready except for its `card.md` gets one (at most ten lines:
   outcome, keys, decisions, open items, paths; frontmatter `title`, `keys`, `tags`). A topic with
   no `summary.md` gets it from a **worker** that reads the topic folder and writes: the outcome,
   every key with a one-line **reason** for the decision (not the task text — the tracker holds
   it), the decisions, the links. A draft equal to a created task is redundant; the summary
   keeps the key and the reason, not the text.
3. **Show the plan again, then apply on the user's yes**: `node oikos/tools/desk/cli.mjs compact --yes`
   (the same flags as the plan). The tool moves the files, removes only the folders that the move
   emptied, and rebuilds the index.
4. **Finding it later.** `desk find <key|words>` searches the index and the live cards and
   summaries; `--archive` also searches the raw notes in `_archive/`. `desk reopen <topic> --yes`
   brings a compacted topic back, hot again.
