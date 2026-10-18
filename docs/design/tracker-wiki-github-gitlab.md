# Design — GitHub and GitLab as the tracker and the wiki (F7)

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
is accepted until the owner says so; accepted commitments then move to ADR blocks and the
implementation steps to [`_aitna/TASKS.md`](../../_aitna/TASKS.md).

**State:** Q1–Q12 decided by the owner (2026-10-18), all as leaned; implementation waits for
the owner's go. **How to resume:** read § Frame, then § Open points and § Phasing. API
claims marked **(TV)** are unverified; § To verify lists them, and phase 1 checks them live.

## Frame

- **Problem.** An installation that keeps its tasks in GitHub or GitLab issues and its wiki in the
  GitHub or GitLab wiki has no connector for `task-tracking` or `wiki` — both skills reach only
  Jira and Confluence.
- **Scope.** Four connectors: task-tracking over GitHub issues (+ Projects) and GitLab issues;
  wiki over the GitHub wiki and the GitLab wiki.
- **Constraints already decided.** A connector tool runs only where the installation lists it
  under `connectors:`; missing credentials are an error (exit 1, no silent dry run); every write
  is shown as `--dry-run` first and runs only as the exact confirmed command (write guard);
  credentials resolve `.local/.env` → `oikos.yaml` settings → environment; nothing naming an
  organization in the core; ES modules, Node 24, no new heavy dependency.
- **Good means.** The `task-tracking` and `wiki` skill bodies read the same for every connector
  (same command names where the meaning matches); an operation a platform lacks is said, never
  emulated; no network in the test suite; one real write per command verified live by the owner on
  a sandbox.

## Survey — the current code that shapes the design

1. **Write guard knows two tools.** `tools/hooks/write-guard.mjs` hard-codes
   `tools/(jira|confluence)/cli.mjs`; adding keys to `WRITES` (`tools/hooks/writes.mjs`) does
   nothing until the pattern is built from `Object.keys(WRITES)` (tool names with hyphens).
2. **The `WRITES` check has a hole.** `sync --check` loops over `WRITES` entries, so a new tool
   with `--dry-run` commands missing from `WRITES` is never checked; it must loop over every
   `tools/*/cli.mjs`.
3. **The guard reads one command word** after `cli.mjs`: command names stay flat (`create`, not
   `issue create`).
4. **Code-hosting is read-only by design.** `tools/github/cli.mjs` (`token()` with the `gh`
   fallback, `gh()` REST client, default org) and `tools/gitlab/cli.mjs` (`gl()` client, 401/404
   mapping) hold their clients as local functions; `skills/code-hosting` says `refuses: any write`.
5. **Tokens map to connectors by name** (`tools/setup/tokens.mjs`: `GITHUB_TOKEN.for: ['github']`
   with read-only help text, `GITLAB_TOKEN` with `read_api`); `setup status` hard-codes the whoami
   list `['jira','gitlab','github']`.
6. **Guards shape the wiki.** The secret guard blocks shell commands on folders under `.local/`, so
   a wiki working copy there is reachable only by the tool; the git guard sees only the agent's own
   shell, so a push inside a tool is gated by the write guard alone.
7. **The machine's git identity may belong to another organization** (DEVELOPMENT.md experience):
   wiki commits never use it.
8. **Precedent:** `jira` and `confluence` are two tools sharing `tools/common/atlassian.mjs`; every
   connector name equals its tool folder.

## Design

### Layout — one tool per service and skill, shared clients

`tools/github-issues/`, `tools/github-wiki/`, `tools/gitlab-issues/`, `tools/gitlab-wiki/`. The
clients move, without behaviour change, to `tools/common/github.mjs` (credentials, REST + GraphQL,
`repoName`, base URL) and `tools/common/gitlab.mjs`; the code-hosting tools import them. New pure
modules: `tools/common/sections.mjs` (markdown heading find / append / replace, shared by both
wikis) and `tools/common/gitwiki.mjs` (clone / commit / push with credentials in the environment).

### Connector names — equal to the tool folder

`github-issues`, `github-wiki`, `gitlab-issues`, `gitlab-wiki`. The connector guard stays 1:1
(tool `t` runs only if `t` is listed under some skill), and an installation that keeps only its
code on GitHub cannot write GitHub issues. `GITHUB_TOKEN.for` becomes
`['github', 'github-issues', 'github-wiki']`; the same for GitLab. The skill's "Which connector"
table maps the user's words ("on GitHub") to the right connector.

```yaml
connectors:
  code-hosting: [github]
  task-tracking: [github-issues]
  wiki: [github-wiki]
```

### task-tracking — GitHub (`github-issues`)

`--task` takes `owner/repo#12`, `repo#12` (with `GITHUB_ORG`) or a URL; `--user` takes a login.

| Command | GitHub | Notes |
|---|---|---|
| whoami | `GET /user`; scopes from `X-OAuth-Scopes` (TV) | fine-grained tokens expose no scope header (TV) |
| info | issue + comments (REST) or one GraphQL query with labels, assignees, milestone, project fields, parent / sub-issues (TV) | Projects fields need GraphQL anyway |
| context | info + project Status / Iteration + parent and siblings + warnings | parity with Jira |
| search | `GET /search/issues?q=…` in GitHub syntax, `is:issue` added | advanced-search migration and rate limit (TV) |
| mine | `GET /issues?filter=assigned&state=open`, or org-scoped (TV) | "me" is the token owner or the `gh` login |
| create | `POST /repos/{o}/{r}/issues`; optionally add to the project and set Status / Iteration | unknown labels refused unless `--create-labels` |
| edit | `PATCH …/issues/{n}`; labels by add / remove; bulk by `--query` with `--max` | |
| comment | `POST …/issues/{n}/comments` | markdown native |
| transition | § Status model | close / reopen refused |
| boards | the org's Projects v2 (GraphQL; `project` scope, TV) | |
| sprints / sprint | the project's Iteration field; milestones when there is none (stated) | |
| move-to-sprint | `updateProjectV2ItemFieldValue` with an iteration; `--backlog` clears it (TV) | |
| link | sub-issues (parent / child) and "blocked by" dependencies (TV) | other link types refused: "mention it in a comment" |
| attachment / attach | download best effort (TV); no upload API (TV) | upload refused (F2) |
| goals, goal, goal-comment | — | unsupported, stated |

### task-tracking — GitLab (`gitlab-issues`)

| Command | GitLab | Tier / notes |
|---|---|---|
| whoami | `GET /user` + `GET /personal_access_tokens/self` for scopes (TV) | warns when writes are configured but the scope is `read_api` |
| info / context | `GET /projects/:id/issues/:iid`, `…/notes`, `…/links` | epics later |
| search | list filters: `labels`, `milestone`, `state`, `search`, `assignee_username`, `iteration_id` (Premium, TV) | flags, not a query language |
| mine | `GET /issues?scope=assigned_to_me&state=opened` | |
| create | `POST /projects/:id/issues` | implicit label creation guarded (TV) |
| edit | `PUT …/issues/:iid` with `add_labels` / `remove_labels` (one call) | bulk with `--max` |
| comment | `POST …/issues/:iid/notes` | |
| transition | § Status model; `state_event=close\|reopen` refused | |
| boards | `GET /projects/:id/boards`, `/groups/:id/boards` (label lists free; others Premium, TV) | read-only |
| sprints / sprint | milestones, or iterations (Premium) by setting | |
| move-to-sprint | `milestone_id`; iterations via REST uncertain (TV) | |
| link | `POST …/issues/:iid/links` with `relates_to \| blocks \| is_blocked_by` (blocks tier, TV) | |
| attachment / attach | `POST /projects/:id/uploads` (multipart; `http.mjs` needs a `FormData` passthrough) | with F2 |
| goals | epics / OKRs (tiered, TV) | unsupported in F7 |

An operation a connector does not offer: the connector file has a "Not here, on purpose" section;
the tool exits 1 with one line and, where there is one, the route a person takes. The shared
SKILL.md gains one rule — "an operation a connector does not offer is said, not emulated" — and
the triggers `owner/repo#123` and issue URLs.

### Status model

| | GitHub | GitLab |
|---|---|---|
| Status source | the Projects v2 Status field when `GITHUB_PROJECT` is set, else labels | labels (`add_labels` + `remove_labels`, atomic); native work-item Status later (Premium, TV) |
| Policy | `GITHUB_AGENT_STATUSES` / `GITHUB_REVIEW_STATUSES` | `GITLAB_AGENT_STATUSES` / `GITLAB_REVIEW_STATUSES` |
| Default | `Todo, In Progress` | none: `transition` refused, the key named |
| Close / reopen | refused (exit 3, the link printed) — a person's move | same |

As with Jira: an agent moves only among the agent statuses; from review on only a person moves a
task. One pair of keys per connector, so one installation can hold two workflows.

### Wiki — GitHub (`github-wiki`): ephemeral git clone

The GitHub wiki has no REST API (TV); it is the git repository `<repo>.wiki.git`, which exists
only after the first page is made in the web interface (TV). Flat pages: `Page-Name.md`, `Home.md`,
`_Sidebar.md`, `_Footer.md`, and other formats.

- **Working copy:** a shallow clone per command in the OS temp folder, deleted after — nothing in
  `.local/`, nothing stale.
- **Credentials** only in the environment, never in argv, the URL or `.git/config`:
  `GIT_CONFIG_COUNT` / `http.extraHeader` (git ≥ 2.31, TV), `GIT_TERMINAL_PROMPT=0`.
- **Commit identity** per commit: the token owner's login and
  `<id>+<login>@users.noreply.github.com`, never the machine's.
- **Dry run:** clone, apply in memory, print page, base commit, current and new text; push nothing.
- **Write:** clone, apply, commit, push without force; a rejected push aborts with "the wiki
  changed since; run the dry run again" (exit 2), no automatic rebase.
- **Search:** wiki repositories are not indexed by GitHub search (TV), so the tool greps its clone
  (title and full text, with context).
- **create:** `--parent` refused (flat); refused when the page exists.
- **Token risk (high, TV):** fine-grained tokens may not reach wiki git; a classic `repo` token or
  the `gh` login probably does. Verified in phase 1.

### Wiki — GitLab (`gitlab-wiki`): REST API

`GET /projects/:id/wikis?with_content=1`, `GET …/wikis/:slug`, `POST …/wikis`, `PUT …/wikis/:slug`;
search through `GET /projects/:id/search?scope=wiki_blobs` (TV) plus a title filter. Reuses
`common/gitlab.mjs` and the channel diagnostics of `http.mjs` (proxy, Cloudflare Access), which
matter for self-hosted instances. `create --parent` maps to the slug path `parent/Title` (TV).
Group wikis later.

### Both wikis

- **Markdown is native:** the body is written as given. A page in another format is read as raw
  text; writes to it are refused.
- **`common/sections.mjs`:** headings outside fenced code; `replace-section` replaces up to the
  next heading of the same or higher level and keeps the heading; a missing or duplicate heading
  lists the page's headings and stops (as Confluence does).
- **Commands as Confluence:** `search`, `read`, `info`, `create`, `append`, `replace-section`;
  `--page` takes a name, slug or URL. The English-only guard and `--allow-non-english` carry over.

### Settings and credentials

| Key | Where | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | `.local/.env` | permissions = the union of the GitHub connectors listed |
| `GITHUB_ORG` | settings | default owner, Projects |
| `GITHUB_REPO` | settings, optional | default repository for `create` / `search` |
| `GITHUB_PROJECT` | settings, optional | org project number: Status field and iterations |
| `GITHUB_AGENT_STATUSES`, `GITHUB_REVIEW_STATUSES` | settings | § Status model |
| `GITHUB_WIKI_REPO` | settings, optional | default wiki repository |
| `GITHUB_API_URL` | settings, optional | GitHub Enterprise Server later; default `https://api.github.com` |
| `GITLAB_TOKEN`, `GITLAB_URL` | as today | writes need scope `api`; `read_api` is enough for reads |
| `GITLAB_PROJECT`, `GITLAB_GROUP` | settings, optional | defaults; the group for boards, milestones, iterations |
| `GITLAB_SPRINTS` | settings | `milestones` (default) or `iterations` |
| `GITLAB_AGENT_STATUSES`, `GITLAB_REVIEW_STATUSES` | settings | § Status model |
| `GITLAB_WIKI_PROJECT` | settings, optional | default wiki project |

GitHub permissions (TV): fine-grained — repository Issues read/write, Metadata read, Contents
read (write for the wiki if reachable), organization Projects read/write; classic — `repo` +
`project`; `gh` — `gh auth refresh -s project` for Projects.

`setup`: the token help text and `for` follow the connectors in use (the read-only hint only when
`github` is the only GitHub connector); the `status` whoami loop follows the connectors in use
instead of a fixed list; whoami of the issue tools reports the visible scopes and flags "writes
configured, token read-only". OIKOS.md "Who me is" gains rows; the example `oikos.yaml` and the
`init` template gain commented lines.

### Write safety

```js
'github-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
'gitlab-issues': ['create', 'edit', 'comment', 'transition', 'move-to-sprint', 'link'],
'github-wiki':   ['create', 'append', 'replace-section'],
'gitlab-wiki':   ['create', 'append', 'replace-section'],
```

Dry runs follow Jira's frame (`--- DRY RUN (requested --dry-run) ---` … `DRY RUN — nothing
written to …`) and show: the resolved repository / project, every selected issue, field and label
changes, the transition `from → to` and its source (project field or labels), the target
iteration or milestone, the link `A —blocks→ B`, and for wiki writes the page, its base commit or
version, current and new text. Only `comment` and wiki `append` / `create` preview without
credentials. Extra guards: a `PUBLIC repository` banner on every GitHub dry run; @mentions listed
("will notify @x"); unknown labels refused without `--create-labels`; bulk capped by `--max`
(default 50); English only unless `--allow-non-english`. Not undoable: notifications, a created
issue (deleting needs admin, not offered); a wiki push is visible at once.

### Tests (no network)

- The `tests/connectors.test.mjs` pattern for every new tool: missing credentials and an unlisted
  connector exit 1 before any request; `setup status` rows.
- A canned-response fetch shim (URL or GraphQL operation → JSON) for reads, pagination (`Link`,
  `X-Next-Page`), transition refusals (exit 3), the atomic GitLab label move, `--max`, unknown
  labels, the PUBLIC banner, and "a dry run makes no non-GET call".
- `common/sections.mjs` unit tests.
- GitHub wiki over git offline: a local bare repository as the remote (through `GITHUB_API_URL` /
  the server URL) — clone, edit, commit identity, push, a rejected push, a missing wiki.
- Write-guard payload files for each new tool, both hosts' tool names; `npm run check` catches a
  `--dry-run` command missing from `WRITES`.
- **Live, with the owner:** whoami per token type, reads, every dry run, one real write per command
  on a sandbox repository, project and wiki the owner names; fine-grained token vs wiki git; GitLab
  tier behaviour on the owner's instance.

### Phasing

| # | Step | Size | Depends on |
|---|---|---|---|
| 0a | Write guard built from `WRITES`; `sync --check` over every tool | S | — |
| 0b | Clients moved to `common/github.mjs`, `common/gitlab.mjs` (code-hosting tests stay green) | S | — |
| 1 | `github-issues` reads; the fine-grained-token-vs-wiki spike alongside | M | 0b |
| 2 | `github-issues` writes (label transition), `WRITES`, tests | M | 0a, 1 |
| 3 | GitHub Projects v2: boards, sprints, Status transition, move-to-sprint | L | 2; `project` scope live |
| 4 | `common/sections.mjs` + `github-wiki` | M–L | 0a; the spike |
| 5 | `gitlab-issues` reads and writes, milestones, boards; iterations behind the setting | M–L | 0b, 2 |
| 6 | `gitlab-wiki` (API) | S–M | 4, 5 |
| 7 | With each step: skill tables and triggers, connector files, OIKOS.md, `setup`, example `oikos.yaml` | S each | — |

The connector guard is delivered before F7, as its own change.

## Open points

| # | Point | State | Options → decision |
|---|---|---|---|
| Q1 | Connector names | **decided** (owner, as leaned) | shared `github` / `gitlab` vs `github-issues`, `github-wiki`, `gitlab-issues`, `gitlab-wiki` → **distinct names** (guard and tokens 1:1; code-only installations stay isolated) |
| Q2 | GitHub status source | **decided** (owner, as leaned) | Projects only / labels only / Projects when `GITHUB_PROJECT` is set, else labels → **the last** |
| Q3 | May the agent close or reopen | **decided** (owner, as leaned) | never / "not planned" only / under a setting → **never** (as Jira's done statuses) |
| Q4 | What "wiki" means on GitHub | **decided** (owner, as leaned) | the Wiki feature / a docs folder in a repository / both → **the Wiki feature**; a docs repository is its own connector later |
| Q5 | GitHub wiki working copy | **decided** (owner, as leaned) | ephemeral clone / cache under `.local/` → **ephemeral**; revisit when a command takes more than about 5 s |
| Q6 | Token model | **decided** (owner, as leaned) | one token per service / a separate write token / classic token for the wiki → **one per service**, permissions shown per connector; GitLab writes accept `api`; classic or `gh` for the wiki if the spike requires |
| Q7 | GitLab "sprint" | **decided** (owner, as leaned) | milestones / iterations / auto-detect → **`GITLAB_SPRINTS`, default milestones** |
| Q8 | Writes to public repositories | **decided** (owner, as leaned) | banner only / refused unless listed → **banner, and refused unless the repository is listed** in a setting |
| Q9 | GitHub Enterprise Server | **decided** (owner, as leaned) | now / later → **`GITHUB_API_URL` in the client now, untested** |
| Q10 | Scope cuts | **decided** (owner, as leaned) | goals, attachment upload, epics / OKRs, wiki `search --mine` → **all out of F7**, stated |
| Q11 | One feature or two | **decided** | GitHub and GitLab together in F7 (owner) |
| Q12 | Connector guard | **decided** | a separate prerequisite, delivered before F7 |

## Rejected (candidates)

| Branch | Why | Revisit if |
|---|---|---|
| Extend `tools/github`, `tools/gitlab` with issue and wiki commands | breaks the guard's one-word match and the skill isolation; merges a read-only tool with a writing one | the number of tools becomes a burden |
| One `TRACKER_AGENT_STATUSES` | cannot hold two workflows in one installation | never |
| `--base <sha>` pinning for wiki writes | the command text would differ between the dry run and the write | the write guard learns "same command except pinned fields" |
| GitLab wiki over git | loses the channel diagnostics | lost updates seen over the API, or `api` refused while `write_repository` is accepted |
| Wikis through the shared browser | fragile, no diff preview | no token reaches the wiki |

## To verify

- **GitHub:** no REST wiki API; the wiki git URL and its first-page creation; fine-grained,
  classic and `gh` access to wiki git; `http.extraHeader` through `GIT_CONFIG_*`; issue search
  (advanced search, `is:issue`, rate limit); `GET /orgs/{org}/issues`; issue types; sub-issue and
  dependency endpoints; Projects v2 scope and mutations, default Status options; `X-OAuth-Scopes`
  per token type; `user-attachments` download, no upload API; implicit label creation; wiki file
  names; the GraphQL path on Enterprise Server.
- **GitLab:** `GET /personal_access_tokens/self`; `scope=wiki_blobs` without Advanced Search; a
  conflict parameter on wiki `PUT`; nested pages from a title with `/`; group wikis and tier;
  `blocks` links and tier; iterations through REST; native work-item Status and tier; epics
  deprecation; the uploads download path; implicit label creation; `write_repository` for wiki git.
