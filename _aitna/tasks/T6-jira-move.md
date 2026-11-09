# T6 · `jira move`: issues to another project

Detail for the [backlog](../TASKS.md) row `T6` (bulk move by keys or JQL).

Jira Cloud `POST /rest/api/3/bulk/issues/move` + `GET /rest/api/3/bulk/queue/{taskId}` (public
v3 spec, "an early version … no full parity with the Bulk Move UI"; ≤1000 issues incl. subtasks;
one target project per request; epics and their children in separate requests, the children with
the epic as target parent; subtasks follow with `inferSubtaskTypeDefault`; failures per issue in
`failedAccessibleIssues`). Read-only probe on a live Cloud site: the bulk queue answers (404 "task
could not be found", not a missing route), Bulk change / Move / Create permissions held. No REST
move on Data Center. Step 1 (research) done; step 2 design shown to the owner. Open decisions:
D-T6-NAME (verb name: `move` or `move-to-project`, beside `move-to-sprint` and "move" = transition
in the skill), D-T6-CONFIRM (preview by default + `--yes`, which needs a write-guard change, or the
tools' `--dry-run` convention), D-T6-HIERARCHY (epic + children in two phases; a child whose epic
stays behind), D-T6-NOTIFY (`sendBulkNotification` off by default), D-T6-SANDBOX (throwaway
projects for the live check). Unconfirmed until the sandbox run: team-managed → company-managed
through the API, a parent kept for a non-subtask, sprint/version/component loss, JQL and
`GET /issue/<old key>` on an old key. Also: bare task numbers bound to a project (D11
`number_repos`) do not follow a moved key — the installation's config needs the new project.
