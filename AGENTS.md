# oikos — the core repository

This repository is **oikos**, an assistant for working with an organization's resources: skills,
connectors, tools and the rules for using them. It is not used from here. An **installation** —
one folder per organization or project — holds this repository as `oikos/` (a symlink or a git
submodule), imports [OIKOS.md](OIKOS.md) from its own `AGENTS.md`, and keeps the organization's
configuration, resources and secrets. Nothing about one organization or person is ever committed
here.

| To | Read |
|---|---|
| change oikos — its skills, connectors, tools, hooks, these files | [DEVELOPMENT.md](DEVELOPMENT.md), before changing anything |
| know how oikos is used (what an installation's agent follows) | [OIKOS.md](OIKOS.md) |
| set up an installation, or update oikos in one | [BOOTSTRAP.md](BOOTSTRAP.md) |

## Language

- Everything written into this repository is in **English**.
- Answer the user **in the language of their question**.

## Rules that always hold here

- **Nothing that names an organization or a person** — no hosts, projects, people, task keys,
  brand, internal paths. Examples use `ACME Corp`, `example.com`, `PROJ-123`. What differs per
  organization is read from the installation, never written into the code or the docs.
- **Writes need confirmation**, as in OIKOS.md: a changing action against a live service is shown
  first (`--dry-run`) and runs only after the user confirms; tests never post for real.
- **Git**: stage by name; push, merge or pull requests only on the user's explicit request.

## Dev layer — akmon (developing the project)

This project uses the akmon dev layer — one standard for how an assistant helps develop it.
Model & notation: [`MODEL.md`](_aitna/akmon/MODEL.md); attach/realign guide:
[`BOOTSTRAP.md`](_aitna/akmon/BOOTSTRAP.md); overview: [`README.md`](_aitna/akmon/README.md).

- **Archetype / language:** `package` / `javascript` — classify per
  [`ARCHETYPES.md`](_aitna/akmon/ARCHETYPES.md), then update this line, the guardrail imports
  below, and `attached_archetype` in `_aitna/.akmon.toml`.
- **Layers:** SHARED = `_aitna/akmon/` · LOCAL = `_aitna/{agents,skills,tools,memory}` +
  [`_aitna/TASKS.md`](_aitna/TASKS.md) · USAGE = root `skills/` (oikos's skills,
  which an installation loads through `oikos/`).
- **Agents (roles):** [review](_aitna/agents/review/README.md),
  [architect](_aitna/agents/architect/README.md), [engineer](_aitna/agents/engineer/README.md)
  → roles: [`_aitna/akmon/roles/`](_aitna/akmon/roles/).
  **Declare the active agent** before doing work and restate it on switch
  (`🧭 agent: <name> — <focus>`).
- **Delegation (always-on, direct):** **delegation is the default.** For every non-trivial
  task, before the first repository sweep, edit, or test run, decompose the work and delegate
  every independent mechanical sub-step to available subagents without waiting for an owner
  prompt. The orchestrator retains decomposition, routing, synthesis, and owner dialogue. Skip
  only when the task is atomic or the harness exposes no subagents; state the reason. This
  clause is direct because Codex does not expand nested `@` imports in `AGENTS.md`.
- **Owner authority (always-on — it overrides any task instruction):** the owner verifies
  consequential architecture, data-shape and math decisions recorded in ADRs; an assistant
  *drafts*, the owner *decides*. **D5** — the owner owns commits, tags, pushes, publishing and pin bumps; never
  `git add`/`commit`/`push` on the owner's behalf.
- **Guardrails and profiles (always-on):** the common guardrail and the project's language
  profile are **imported** (not just linked) so their rules load at session start; akmon is the
  single owner — do not restate them here. Import this project's language profile on its own
  line (e.g. `@_aitna/akmon/profiles/python.md`), and an environment profile where some of its code
  runs in one, per the ARCHETYPES map.

@_aitna/akmon/guardrails/_common.md
@_aitna/akmon/profiles/js.md

- **Domain profiles (opt-in by need):** none attached yet — link only those the project actually needs.
- **Pipelines:** [pre-commit](_aitna/akmon/pipelines/pre-commit.md) (tests mandatory),
  [review-flow](_aitna/akmon/pipelines/review-flow.md),
  [design-flow](_aitna/akmon/pipelines/design-flow.md),
  [code-flow](_aitna/akmon/pipelines/code-flow.md),
  [tasks](_aitna/akmon/pipelines/tasks.md) (backlog format), and the learn loop
  ([memory-distill](_aitna/akmon/pipelines/memory-distill.md) +
  [learning](_aitna/akmon/pipelines/learning.md)).
- **Memory:** read `_aitna/memory/` at session start — distilled project facts, indexed by
  [`_aitna/memory/README.md`](_aitna/memory/README.md).
- **Backlog:** [`_aitna/TASKS.md`](_aitna/TASKS.md) — one line per task, detail by reference;
  finished entries move to `TASKS_ARCHIVE.md`.
- **Secrets:** from `.env` (gitignored). Never in code, docs, tests, or commits.
