# Scenario: team facts

The user asks about a team rather than a person — how large it is and who is on it, which
projects it runs and who leads them, what versions it released, who committed to its repositories
in a period. The result is a fact sheet about the team, for a lead's report, a review or a section of
a CV. It is not a ranking of people and not an assessment of anyone.

## Steps

1. **Purpose and the team's rule.** Ask what the facts are for, and pass it as `--purpose`. Then ask
   who counts as a member: the user's rule, written as `team.members` (emails or names, matched
   exactly, ignoring case) and the Jira projects of the team as `team.projects` (keys such as
   `PROJ`). The tool never guesses membership from the data. Without members the people listed are
   those seen in the period, not a team, and the report says so; say that to the user.
2. **Settings.** Put the rule in `.local/footprint/config.yaml` (the skill, § Places and settings),
   unless the user gives it for this run only:

   ```yaml
   team: { members: [ada@example.com, "Sam Example"], projects: [PROJ] }
   ```

3. **Sources.** Team is not in the default sources: it runs only with `--source team`. It reads the
   git clones under `--repos` (authors per repository in the period) and Jira where the `jira`
   connector is listed with its credentials (the projects, their leads, versions and assignees); a
   source that is not listed is named in the Notes. `sources` shows what the team source reads here.
4. **Collect.** Team facts are not a person's footprint, so give the store a folder of their own: pass
   `--person <team>` (the team's name). Without it the events are saved under the person of the other flags
   (`me` with `--me`), beside that person's own events, and the Notes say so.

   ```bash
   node oikos/tools/footprint/cli.mjs collect --since 2026-07-01 --until 2026-09-30 \
     --source team --repos ~/src --person "Team PROJ" --purpose "team composition for the lead's report"
   ```

   Add `--no-save` for a one-off run that should not be kept.
5. **Read it for the user.** The report's Team facts section, read as facts:
   - **the team** — the counting rule as the settings give it, the people listed by name with the
     members marked; the count of members is the rule's, not a measure of anyone;
   - **the projects** — each lead (a snapshot of now, not of the period), the versions released with
     a release date in the period, the people assigned to issues updated in the period;
   - **the repositories** — the authors in the period, marked the same way.
   Never rank people by a count — of lines, commits, issues or anything else — and never say who did the
   most: the tool lists people by name on purpose. If the user asks for a ranking, say what the facts cannot
   tell and offer the list by name instead.
6. **What the numbers leave out.** A person on the team with no issue updated in the period is not
   listed; assignment is what Jira shows at the time of reading, so a later run can differ; the issue
   scan is capped (a cut is named in the Notes) and the projects the account cannot see are skipped
   and named; git sees only what the clones hold, fetched first; a team member who commits under
   another address is listed unmarked unless the rule names that address.
7. **Save.** Write the report to `.local/footprint/team-<name>-<since>-<until>.md`, with the reading
   from step 5 at the end. Sharing it is a separate step through the `wiki`, `messaging` or
   `workspace` skill, with confirmation.
