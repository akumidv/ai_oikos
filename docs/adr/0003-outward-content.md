# ADR 0003 — Outward content: one check for what the tools write

Accepted commitments only. Design, alternatives and open points:
[docs/design/outward-content.md](../design/outward-content.md). Implementation state:
[`_aitna/TASKS.md`](../../_aitna/TASKS.md) (F16). Accepted by the owner, 2026-10-22, with the
design's open points O1–O5 decided as D03, D04 and D05 record.

## D01 — One common check for every guarded write that carries text
<a id="dec-0003-d01"></a>`Decision-ID: DEC-0003/D01`

- **Choice.** `tools/common/outgoing.mjs` holds the only content check: `outgoingFindings(text,
  rules)` (pure) and `guardOutgoing(texts, values)`, called by every command in
  `tools/hooks/writes.mjs` that sends text — titles, bodies, headings, a move's comment, a
  `--file`'s content, an image's name and alt text, a text attachment. The six `englishOnly` copies
  and the inline checks go; `nonLatinLetters` moves into the module.
- **Images and binary attachments are not text-checked.** An image (inline or attached) and an
  `attach` file of a binary type (PDF, docx, xlsx, pptx) are not read: only the file name — and an
  image's alt text or caption — is checked, and the dry run says the content was not. Text types of
  `attach` (`md`, `txt`, `log`, `csv`, `json`, `yaml`, `yml`, `svg`) are checked as text. Archives
  (`zip`) are not on `attach`'s type allowlist, so no container reaches the check unopened.
- **Rationale.** The copies already disagree (`jira transition` skips its comment in the dry run);
  the owner requires that nothing written to company systems names the assistant or a local path.
- **Consequences.** `project-init` and `repos` (they write only `oikos.yaml`) are not checked. What
  an office file or a PDF says, or an image shows, stays the agent's to look at before attaching.

## D02 — Five categories, built-in patterns plus the installation's words
<a id="dec-0003-d02"></a>`Decision-ID: DEC-0003/D02`

- **Choice.** `language` (non-Latin letters), `assistant` (`oikos`, `oikos.yaml`, `OIKOS.md`,
  `OIKOS_HOME`, `node oikos/tools/`, `skills/<skill>/`, `SKILL.md`), `path` (`/home/<name>/`,
  `/Users/<name>/`, `C:\Users\`, `/mnt/<drive>/Users/`, `\\wsl$`, `/tmp/`, `scratchpad`, `.local/`,
  `file://`), `secret` (GitHub, GitLab, Slack, Atlassian and AWS token prefixes, a private-key
  block, a JWT shape), `term` (the installation's own list). Skill names count only in path form.
- **Rationale.** Fixed patterns are testable; the words that differ per installation come from it,
  never from the core.

## D03 — Dry run shows, real run refuses, the override is in both
<a id="dec-0003-d03"></a>`Decision-ID: DEC-0003/D03`

- **Choice.** The dry run prints each flagged line with its number and category; a secret is
  masked there and in the text's preview. The real run refuses a finding not overridden: exit 3
  (the one "refused by a guard" code of DEVELOPMENT.md § Writing a tool), stderr starting
  `refused: content check:` and naming the categories — so it reads apart from a move's refusal
  (`refused: policy:`, ADR 0004 D03) and from the other guards' plain `refused:`. The override is a
  flag of the command, present in the dry run and the real run alike, so the confirmed command is
  the one that shows the findings. The flag is `--allow-flagged` (owner, 2026-10-22), beside
  `--allow-non-english`, which covers `language` only. It is **not** `--force`: on jira `comment`,
  `edit` and `description` `--force` already overrides the lossy-content refusal, and one flag
  carrying both overrides would let one silently carry the other.
- **Rationale.** The write guard compares the tokens without `--dry-run`; an override added only
  to the real run would be a different command, and the user would confirm something unseen.
- **Consequences.** A flagged dry run exits 3 with stderr starting `flagged: content check:`, so it
  reads as "would be refused" in every harness (owner, 2026-10-22). A `secret` finding is never
  overridden by `--allow-flagged`, only by an `allow:` entry (owner, 2026-10-22).

## D04 — The installation's words live in `.local/outgoing.yaml`
<a id="dec-0003-d04"></a>`Decision-ID: DEC-0003/D04`

- **Choice.** The installation's word list and allow-list live in `.local/outgoing.yaml` (owner,
  2026-10-22): `terms:` (fixed strings to keep out) and `allow:` (literal strings, no regular
  expressions: a finding whose line contains one is dropped, and the dry run counts what was
  allowed — owner, 2026-10-22). A missing file means built-in patterns only.
- **Rationale.** The terms are often another client's or a personal project's names; `oikos.yaml`
  may be shared with the organization in the installation's repository, which would leak them.
- **Reconsider if** an organization needs one allow-list for every member — then an `outgoing:`
  part of `oikos.yaml` for `allow` only.

## D05 — Routes no tool writes follow a rule in OIKOS.md
<a id="dec-0003-d05"></a>`Decision-ID: DEC-0003/D05`

- **Choice.** Text sent through the messenger connector, a mail draft, the shared browser or a
  shared vault note follows the same rule as prose in OIKOS.md; the agent may run a read-only
  `check --text|--file` (no `--dry-run`, not a guarded write) on such a draft first, a command of
  a new `tools/outgoing/cli.mjs` (owner, 2026-10-22).
- **Rationale.** These routes have no oikos tool to enforce the check; a rule plus a cheap check is
  what reaches them.
