# capture — a note arrives

Cheap, and done many times a day: no tracker call, no messenger call, no drafting.

1. **Find the topic.** `node oikos/tools/desk/cli.mjs list` — an open topic the text belongs to,
   or the user's own words ("this is for the API review"). A new subject: `desk new <slug> --title …`
   (a lowercase slug of letters, digits and `-`). When two open topics fit, ask which; do not guess.
2. **Classify each piece** of the text, one of:
   - *instruction* — the user tells the agent what to do now (do it, or ask what is unclear; it is
     not a note);
   - *note* — something to keep;
   - *own task* — something the user will do themselves (kept as a unit of kind `task`, where = the user);
   - *question* — the user wants an answer, not a record (answer it; keep only what matters);
   - *unclear* — one question to the user, nothing more; the piece waits in the notes as `(?)`.
3. **Append to `notes.md`** with the time (`## 14:05`), the original text exactly as it came, and
   beside it the cleaned text — typos and fragments fixed, every guess marked `(?)`. Never rewrite an
   earlier entry; a correction is a new entry that says what it corrects.
4. **Answer in one line**: what was kept and where (`topic api-review, 3 notes`), and the one
   question if there is one. Do not recite the text back.

What is *not* done here: grouping into units (digest), looking anything up (draft-and-create),
or deciding where a thing goes. A key or a person named in the text is written as the user wrote it;
it is looked up when the text for it is drafted.
