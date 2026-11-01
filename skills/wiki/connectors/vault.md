# Connector: vault

The notes of a **vault** — a git repository the installation mounts as a wiki (`use: [wiki]` of a
mount in `oikos.yaml` or `.local/mounts.yaml`; ADR 0007) — for the skill `wiki`. One tool:
`node oikos/tools/vault/cli.mjs <command>`; `--json` gives the raw payload of `search` and `read`.

The connector is **derived from the mounts**: any wiki mount without a problem makes it available,
no `connectors:` line is needed, and it is never the default wiki connector — a knowledge question
still goes to the knowledge base first. A request that names a vault or a note ("in my vault", "the
note about …", a path of a note) selects it. `node oikos/tools/landscape/cli.mjs mounts` lists the
mounts, each wiki with its name; a mount with a problem is not used (`sync --check` says why).

This tool is **the one route that writes into a mount**: the file tools and the shell never write
there (the guards deny it, with "open a session in `<mount>` to change it"). Committing the vault is
the user's — in their git client, or in a session opened in the vault; the tool never commits.

## Which vault

- `--wiki <name>` names a vault (its `wiki.name`, default its path in the mount list).
- Without it `search` runs over every wiki and names the vault of each hit; `read`, `append` and
  `replace-section` take the vault that has the note; `create` goes to the default wiki
  (`default: true`), else to the only one, else asks — name one with `--wiki`.
- `--note` is a path from the vault's root (`inbox/idea.md`, `.md` optional) or a note name
  (`idea`); a name that several notes have lists them.

## Find and read

```bash
node oikos/tools/vault/cli.mjs search --title "release" [--wiki own]
node oikos/tools/vault/cli.mjs search --query "importer" [--limit 25]   # lines, with a line of context
node oikos/tools/vault/cli.mjs read --note inbox/idea.md [--wiki own]
```

`search` matches titles (the file name and the front matter `title`) and every line, ignoring case.
Dot folders (`.obsidian/`, `.git/`), links and rule files are not searched.

## Write — dry-run, show, confirm, write

```bash
node oikos/tools/vault/cli.mjs create --title "Onboarding" [--folder inbox/ideas] [--wiki own] --file <scratchpad>/note.md --dry-run
node oikos/tools/vault/cli.mjs append --note idea --heading "Next steps" --file <scratchpad>/section.md --dry-run
node oikos/tools/vault/cli.mjs replace-section --note idea --heading "Rollout" --file <scratchpad>/section.md --dry-run
```

- **`create`** writes `<title>.md` into `wiki.inbox`, or into `--folder` — a folder below the
  vault's root. It starts from the vault's `wiki.template` (`{{title}}`, `{{date}}`; the text given
  goes where `{{body}}` stands, else after it). The text given may start with its own front
  matter; its keys are set in the template's. The front matter is checked against the vault's note
  rules (`wiki.rules`, below); an existing note is never replaced.
- **`append`** and **`replace-section`** change only an existing `.md` note, as the other wiki
  connectors do (`--heading-level`, `--at-start`; a missing or repeated heading lists the note's
  headings). A note is read as it is now: run `read` first.
- The dry run shows the vault, the note, the check and the text; the real run is the same command
  without `--dry-run`, after the user's yes. Show the dry run, write only after the user confirms.
- The body, written as given, is in English unless the user says otherwise.

## Where a note may go

A note goes only into the vault's `wiki.inbox` or a folder below its root, and never

- under any mount's `skills.from`, or as a `SKILL.md`;
- in a folder or as a file whose name starts with a dot (`.git/`, `.claude/`, `.obsidian/`), or as
  a rule file (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `QWEN.md`, `GEMINI.md`);
- in a nested repository, or as the vault's own `wiki.rules` or `wiki.template`;
- through a link that leaves the vault, or onto a file with more than one hard link.

The path is judged as it really is on disk (every link followed), and the note is written through
a temporary file in its folder, renamed into place. A refusal exits 3 (`refused: vault target`).

## The vault's note rules

`wiki.rules` names a file in the vault (`NOTES.md`) whose YAML front matter is the vault's schema,
read as data by this tool — never loaded as rules for the agent:

```yaml
---
required: [title, tags]     # front matter keys a new note must have; a missing one refuses the create
language: en                # the note is English: the language check is on (without it, off)
allow: [remote-embed]       # kinds of executable content the vault allows (below)
---
```

## The content check

Every write goes through the one content check (OIKOS.md, *What goes out*), in a shared and in a
personal vault alike, over the note's title and path, its front matter and its body (headings
included; the template's text too). It flags a local path, a secret, a term of
`.local/outgoing.yaml`, the installation's own derived terms (its root, this machine's home,
the names in `.local/`), the terms of its linked installations, and the assistant — unless the
mount sets `mention_assistant: allow`. In a personal vault (`.local/mounts.yaml`) also the
organization's markers: its email domain, its connectors' hosts, its task keys. Text is matched
after normalising (NFKC, HTML entities such as `&nbsp;` and `&#x20;` decoded, zero-width characters
and emphasis markup removed, runs of spaces of any kind made one, words split over a line break
joined), so a word split by `**` or a line break, or a term of two words spaced differently, is
still caught. A linked installation whose `.local/outgoing.yaml` cannot be read makes every check
refuse (naming the file) until it is fixed: its terms would otherwise be left out.

It also refuses **executable or fetching content** that Obsidian would run or load outside every
guard: a `dataviewjs` block (`dataviewjs`), an inline `` `$=` `` query (`inline-js`), a `<%` template
tag (`template-tag`), a `<script>` element or `javascript:` link (`script`), an `<iframe>`
(`iframe`) and an embed of a remote resource (`remote-embed`: an image or element whose `src`,
`href`, `data`, `poster` or `srcset` is a remote address, a reference-style image whose definition is
remote, CSS `url()`, `image-set()` or `@import` of one — also when the tag is split over lines) —
unless the vault's `wiki.rules` lists that kind under `allow:`. An `allow:` line of
`.local/outgoing.yaml` does not lift these; only `wiki.rules` does.

- A finding refuses the write (exit 3, `refused: content check:`, the places named); a flagged dry
  run prints its preview and exits 3 (`flagged: content check:`). **There is no `--allow-flagged`**:
  the one way past a finding is an `allow:` line in `.local/outgoing.yaml`, a file the agent cannot
  change — tell the user what to add and let them edit it. A secret passes only an entry that
  contains it. A dry run lists every line an `allow:` entry let pass, with the entry.
- The check is a net for accidents, not a barrier: look-alike letters and encodings are not undone.
- The text is checked again in the real run, but the write guard binds the command, not the text: a
  `--file` changed between the dry run and the real run is checked, though nobody saw it.

## Not here, on purpose

- **Delete, rename or move a note, or change a vault's front matter in place** — the user, in their
  vault; this tool creates and appends.
- **Write outside a vault, or into a mount that is not a wiki** — an installation writes only into
  itself (ADR 0007 D02).
- **Commit, push, pull** — the user's.
