# Design — outward-content hygiene (what the tools write into the organization's systems)

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
is accepted until the owner says so; accepted commitments then move to ADR blocks and the
implementation steps to [`_aitna/TASKS.md`](../../_aitna/TASKS.md).

**State:** accepted by the owner (2026-10-22); commitments in
[ADR 0003](../adr/0003-outward-content.md), implementation in `_aitna/TASKS.md` (F16). O1–O5 are
decided (owner, 2026-10-22). **How to resume:** read § Frame, § Design, then § Open points.

## Frame

- **Problem.** Text the agent writes into the organization's systems — a tracker comment, a task
  description, a wiki page — can carry what belongs to the user's machine and assistant: a mention
  of oikos or `oikos.yaml`, a command line `node oikos/tools/...`, a local path (`/home/<user>/`,
  the session scratchpad, `.local/`), or a pasted token. The owner requires that nothing written to
  company systems mentions oikos or local paths. Today the tools check only the language.
- **Goal.** Every guarded write checks its outgoing text once, in one place, for language and
  hygiene; the dry run shows each flagged line; the real write refuses unless the user overrides
  it knowingly.
- **Constraints already decided.**
  - Writes need confirmation: a real write runs only as the confirmed dry-run command, the tokens
    compared without `--dry-run` (`tools/hooks/write-guard.mjs`).
  - Nothing about an organization in the core: per-organization words come from the installation.
  - The check judges text by patterns; it does not judge meaning (that stays the agent's).
- **Acceptance.** A comment holding `/home/ada/notes.md` or `oikos.yaml` is shown flagged in the
  dry run and refused in the real run; the same command with the override posts; no tool keeps its
  own copy of the check; a test covers each category.

## Survey — the current code

- `tools/common/cli.mjs` — `nonLatinLetters(text)`: the non-Latin letters of a text, sorted.
- Six copies of a per-tool `englishOnly(v, ...texts)` that throw unless `--allow-non-english`:
  `tools/jira/cli.mjs` (one function and one inline check in `comment`), `tools/confluence/cli.mjs`
  (function and an inline check), `tools/github-issues/cli.mjs`, `tools/gitlab-issues/cli.mjs`
  (function and an inline check), `tools/github-wiki/cli.mjs`, `tools/gitlab-wiki/cli.mjs`.
  Behaviour differs: `jira comment` warns in the dry run and refuses in the real run;
  `jira transition` checks `--comment` only in the real run (`if (v.comment && !dry)`).
- `jira comment` / `edit` / `description` already take `--force`, with another meaning: overwrite
  content markdown cannot carry (the lossless guards). A second meaning on the same flag would let
  one override silently carry the other.
- `jira attach` uploads local files under the image lines' path rule (inside the installation or
  the markdown file's folder, never a closed `.local/` store or a `.env*` file), a type allowlist
  and 10 MB per file. Archives (`zip`) are not on the allowlist. Jira also uploads the images a
  comment's or description's markdown names.
- Every guard refusal today exits 3 and prints `refused: …` on stderr (DEVELOPMENT.md § Writing a
  tool: 0 ok, 1 usage, 2 remote error, 3 refused by a guard).
- `tools/hooks/leaks.mjs` — the opposite direction: the organization's words must not reach the
  public core; terms in `~/.config/oikos/private-terms`, checked on the core's staged tree. Those
  terms are expected in company systems, so that list is not reused here.
- `tools/hooks/write-guard.mjs` records a dry run at PreToolUse, before it runs: its exit code does
  not affect the confirmation.
- No token patterns exist anywhere in `tools/` today.

## Design

### One check, in `tools/common/outgoing.mjs`

- `outgoingFindings(text, rules)` — pure: `[{ line, category, match }]` for one text. Categories:

  | Category | What matches (case-insensitive unless noted) |
  |---|---|
  | `language` | non-Latin letters (`nonLatinLetters`, moved here) |
  | `assistant` | the word `oikos`, `oikos.yaml`, `OIKOS.md`, `OIKOS_HOME`, `node oikos/tools/`, `skills/<skill>/`, `SKILL.md` — skill names only in these forms, since `wiki` or `documents` are ordinary words |
  | `path` | `/home/<name>/`, `/Users/<name>/`, `C:\Users\`, `/mnt/<drive>/Users/`, `\\wsl$`, `/tmp/`, `scratchpad`, `.local/`, `file://` |
  | `secret` | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` + 36 characters, `github_pat_`, `glpat-`, `xox[abprs]-`, `ATATT`, `AKIA` + 16 (case-sensitive), `-----BEGIN … PRIVATE KEY-----`, a JWT shape `eyJ….eyJ….…` |
  | `term` | each word of the installation's own list (O1), as a fixed string |

- `guardOutgoing(texts, values)` — the one call each write command makes with every text it sends
  (title, summary, body, heading, section, `--comment`, a `--file`'s content, a text attachment):
  - **dry run** — prints a `CHECK` block: each flagged line with its line number and category,
    the match masked for `secret` (`ghp_…` and the length, never the token); the preview of the
    text masks it too, since the dry run's output lands in the transcript;
  - **real run** — refuses when a finding is not overridden: exit 3, stderr starting
    `refused: content check:` and naming the categories. The exit code stays the one guard code;
    the prefix tells it from a move's refusal (`refused: policy:`, ADR 0004 D03) and from the
    other guards' plain `refused:`, since the next step differs (fix the text, or override);
  - the override flag `--allow-flagged` (O3) is part of the command, so it is in both the dry run and the real run
    (the guard's signature is the tokens minus `--dry-run`): the user confirms a dry run that shows
    the findings *and* the override, never a different command.
- `--allow-non-english` keeps its meaning and covers `language` only.
- The six `englishOnly` copies and the inline checks go; `nonLatinLetters` moves with them (its
  importers change in the same step).

### What is checked

- Every command in `tools/hooks/writes.mjs` that carries text: jira `comment`, `transition
  --comment`, `create`, `edit`, `description`, `goal-comment`; confluence `append`, `create`,
  `replace-section`; github-issues and gitlab-issues `create`, `edit`, `comment`, `transition`;
  github-wiki and gitlab-wiki `create`, `append`, `replace-section`. `project-init` and `repos`
  write only the installation's `oikos.yaml` and are not checked.
- Uploads: an image (inline or attached) is not read — its file name and alt text or caption are
  checked. An `attach` file of a text type (`md`, `txt`, `csv`, `json`, `yaml`, `yml`, `log`, `svg`)
  is checked as text; a binary type (PDF, docx, xlsx, pptx) is not read — its name only, and the
  dry run says the content was not checked. No container is opened: `zip` is not on `attach`'s
  allowlist. What an office file, a PDF or an image carries stays the agent's to look at.
- Link targets in markdown are part of the text: `[notes](file:///home/...)` is a `path` finding.

### Out of the tools' reach — a rule in OIKOS.md

Slack (the claude.ai connector), a mail draft, a form filled in the shared browser, a vault note
that is later shared: no oikos tool writes them. OIKOS.md § "Writes need confirmation" gains one
rule: text going to the organization names no assistant, no local path and no secret. Option: a
read-only `check` command (`--text`/`--file`, no `--dry-run`, so not a guarded write) the agent runs
on such a draft before showing it (O5).

## Options considered

- **A — one common check, language + hygiene, refuse unless overridden.** Chosen direction (owner).
- **B — a hook that scans every guarded write's command line.** Rejected: the text is often in a
  `--file` or is markdown turned into ADF; the hook sees only the tokens.
- **C — warn only, never refuse.** Rejected: a warning in a long dry run is missed, and a posted
  comment is hard to take back.
- **D — reuse `private-terms` for the `term` category.** Rejected: that list holds the
  organization's own names, which are expected in its systems.
- **E — keep per-tool copies, add hygiene to each.** Rejected: six copies already disagree on when
  they run.

## Open points

| # | Point | State |
|---|---|---|
| O1 | Where the installation's word list and allow-list live | decided (owner, 2026-10-22) — `.local/outgoing.yaml` (`terms:`, `allow:`): the terms are often another client's or a personal project's names, and `oikos.yaml` may be shared in the installation's repository with the organization, so listing them there leaks them. Alternative: an `outgoing:` part of `oikos.yaml` for an organization-wide `allow` only |
| O2 | Allow-list for false positives | decided (owner, 2026-10-22) — literal strings in `allow:`; a finding whose line contains an allowed string is dropped and the dry run counts what was allowed. No regular expressions in the file |
| O3 | The override flag | decided (owner, 2026-10-22) — `--allow-flagged` (beside `--allow-non-english`); not `--force`, which already means "overwrite lossy content" on jira `comment`, `edit`, `description` |
| O4 | Whether a flagged dry run exits non-zero | decided (owner, 2026-10-22) — exit 3 with the `refused: content check:` prefix's dry-run form (`flagged: content check:`): the result reads as "would be refused" in every harness, and the guard has recorded the dry run before it runs |
| O5 | A `secret` finding: overridable, and a read-only `check` command for routes no tool writes | decided (owner, 2026-10-22) — a secret is never overridden by the flag (only an `allow:` entry); `check` as a command of a new `tools/outgoing/cli.mjs` |

## Rejected (candidates)

- **Checking skill names as bare words** — `wiki`, `documents`, `browser` are ordinary words; only
  path-shaped forms are checked. Revisit-if: a leak by bare skill name is seen.
- **Masking instead of refusing** (rewrite the path to `<path>`) — the tool would change the user's
  text after the confirmation. Revisit-if: never.
- **A distinct exit code for the content check (exit 4)** — would split the one "refused by a
  guard" code every skill reads as "the next step is the user's"; the `refused: content check:`
  prefix tells the cases apart. Revisit-if: a caller must branch on the code without reading stderr.
- **Entropy-based secret detection** — noisy on hashes and ids common in tracker text. Revisit-if:
  a token type with no fixed prefix appears.

## Points for the implementation

- Module `tools/common/outgoing.mjs`: `outgoingFindings` (pure), `guardOutgoing`, the rules loaded
  once at the entry point and passed down (installation file + built-in patterns).
- Each tool: replace `englishOnly` and the inline checks with one `guardOutgoing` call per command
  that writes text, in both runs; add the override option to each such command, so the sync check
  of `--help` stays consistent.
- `jira transition`: check `--comment` in the dry run too.
- Tests: one per category, the allow-list, masking in the dry-run output, the override in both
  runs, refusal exit code and prefix, a `--file` with a path inside a markdown link, a binary
  attachment reported as not checked.
- DEVELOPMENT.md § Writing a tool: the exit-code line names the documented refusal prefixes
  (`refused: content check:`, `refused: policy:`).
- Docs: OIKOS.md rule for routes without a tool; DEVELOPMENT.md § Writing a tool names the call;
  the connectors' docs drop "English-only" wording in favour of the one check.
