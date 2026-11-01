# Design — akmon in installations: developing agents and skills without being a developer (A10)

Living design concept ([design-flow](../../_aitna/akmon/pipelines/design-flow.md)). Nothing here
is accepted until the owner says so; accepted commitments then move to an ADR and the
implementation steps to [`_aitna/TASKS.md`](../../_aitna/TASKS.md) (A10).

**State:** the owner decided every `D-A10-*` point as recommended (2026-10-28, § Open points);
the next step is the prompt in § Appendix, run in an akmon session. It depends on akmon's
actor work (its ADR 0025 and ADR 0026, design `actors-agents-repertoire.md`: accepted in part, not
built). **How to resume:** read § Frame, § What akmon already has, § Design, then § Open points.
The prompt for an akmon session is in § Appendix.

## Frame

- **Problem.** oikos uses akmon's requirements, model and agents to develop its own core. The
  installations will develop their own agents (a desk-like standing agent, see
  [ADR 0006](../adr/0006-desk-agent.md)), skills and small tools as well. But the people in an
  installation are not developers: a manager or a CTO working with the organization's resources
  through an agent. A developer's attach is the wrong weight for them:
  - guardrails imported into `AGENTS.md`;
  - hooks that ask or deny on delegation volume, role declaration and gate audits;
  - decision codes, ADRs and a triad of roles.
- **Goal.** An installation can author and improve agents and skills **under akmon's standard**
  (the same contract, checks and quality bar for the artifact). The **process** around it is sized
  for a non-developer: plain words, few questions, and nothing to manage (no submodule, no pin, no
  hook tuning).
- **Constraints already decided.**
  - Operating oikos (skills, the desk) needs no akmon; only authoring does.
  - Nothing about an organization in the core.
  - Writes need confirmation (OIKOS.md).
  - Mounts (A9) must stay valid if an installation carries akmon (mounts design, D-A9-AKMON).
  - The owner owns commits and publishing, in the installation as in the core.
- **Acceptance.**
  - A user in an installation asks to "make a skill that …".
  - The agent drafts it to akmon's skill standard, runs the checks, and shows the result in plain
    words.
  - It asks only before an action with a consequence (publish, push, delete), explaining that
    consequence.
  - No akmon setup step was done by the user.
  - An installation that never authors carries no akmon wiring.

## What akmon already has (its own repository, read-only here)

- **Actors** (its ADR 0025 D01, accepted): who drives a run — `developer`, `autonomous`, `guided`
  (a non-developer). An actor is set at launch, fixed for the run, and is the **ceiling** of the
  permissions.
- **Repertoire** (D02, accepted): a permission is a set of allowed actions plus unconditional
  prohibitions. The proposed composition is `decision = min(ceiling(actor), max(default(actor),
  repertoire(agent, pipeline)))`. A `guided` run's confirmation explains the consequence in plain
  words before it asks.
- **Agents of the delivery chain** (its ADR 0026): development (roles architect, engineer, review),
  integration, release, publish, learning. A **project agent** (a standing session, a narrow
  executor) has the same contract.
- **Open on akmon's side:**
  - D-ACTOR-CARRIER: what carries the actor — an environment value, a user-level file, or both.
  - D-GUIDED-PROFILE: what a non-developer does unasked; which actions need an explanation; which
    surface they use; how much of the process (roles, ADR, decision codes) applies.
  - The final names (A72); the OPERATE group (its roadmap O1, "not yet formulated"); standing
    agents (its A69, drafted from this core's A7, "needs a second case").
- **Not there:** no actor in the hooks yet (they read only `permission_mode`); no global switch to
  turn the hooks off; nothing on non-programmer authoring.

So the owner's "another role" is, in akmon's model, mostly the **`guided` actor**: a ceiling and a
plain-language confirmation over the existing agents and roles. Two pieces are still missing and
belong to akmon: the **guided profile** and the **OPERATE group** (where oikos's desk sits). A new
role is needed only if authoring by a guided actor needs its own quality bar (D-A10-ROLE).

## Design

### Two kinds of work in an installation

| Work | Who | akmon |
|---|---|---|
| **Operate** — use oikos: skills, the desk, trackers, wiki | any user | none (OPERATE roster line only, as today) |
| **Author** — make or improve an agent card, a skill, a small tool for this installation | the same user, as `guided` | the soft attach below, switched on when first needed |

### The soft attach

- **Source: the core's akmon.** The installation uses the akmon the core pins
  (`oikos/_aitna/akmon`). It has no submodule or pin of its own, and it is updated with oikos.
  akmon's project-root finder takes the nearest folder with `AGENTS.md` and `_aitna/`, so the
  installation's root gets a small `_aitna/.akmon.toml` (no `akmon/` checkout). Whether akmon's
  tools accept a mount outside `<AITNA_ROOT>` is a question for akmon (Appendix).
- **One writer of the wiring: oikos `sync`.** The installation's `CLAUDE.md`, `AGENTS.md` and
  `.claude/settings.json` belong to oikos. `sync` adds akmon's guided wiring (hooks, skill
  pointers, a one-line guided preamble) from a manifest akmon ships. akmon's own `sync` never
  writes the installation's entry files. Removing the switch removes the wiring (the `sync.json`
  record, as for mounts).
- **Actor: `guided`, fixed.**
  - An installation session runs as `guided` unless the launcher says otherwise.
  - The carrier follows akmon's D-ACTOR-CARRIER; an installation file may narrow the actor, never
    widen it.
  - A developer who works in an installation (the owner) can launch as `developer`.
- **What applies, and how it shows** (the oikos side of akmon's D-GUIDED-PROFILE):

  | akmon element | Under `guided` in an installation |
  |---|---|
  | The artifact standard — skill format, agent card, checks | applies in full: the result is the same as a developer's |
  | Prohibitions (privilege escalation, secrets) | apply in full |
  | Roles (architect, engineer, review) | run behind the scenes; the user sees "drafting", "checking", "ready"; no role banner |
  | Delegation, tier floor, gate audit | the agent's own business: a `note`, never an `ask` or a block shown to the user |
  | Decision codes, ADRs | none in the chat: a consequential choice is one plain question with a recommendation; the record is kept in the installation's `.local/` when one is needed |
  | Analysis before mutation | applies as "show, then write after a yes" — the same rule as oikos's writes |
  | Commits, push, publish | the agent commits on its own branch, reported; push, merge to the default branch, publish and delete are asked, with the consequence in plain words |
  | Tests | the checks of the artifact (skill and card validation, a dry run of the skill); unit tests only for a tool |

- **Where the artifacts live**, the same split as mounts' D-A9-WHERE:
  - shared ones (for the organization's team) in the installation's own `skills/` and `agents/`;
  - personal ones under `.local/`.

  `sync` makes pointers for both, next to oikos's own, with an origin. A skill that is useful
  beyond one organization is proposed to the core through the existing core-handoff route,
  stripped of organization data.
- **Switching it on.** `setup author enable`, or the first "make a skill" request, which proposes
  it. It writes the installation's `_aitna/.akmon.toml`; `sync` writes the guided wiring. Nothing
  is attached before.

### Relation to the other work

- **Mounts (A9):** a mount's exclusion wiring and the guards do not change; a development root
  keeps its own framework. If the installation carries `_aitna/`, a session opened in a mount
  still loads none of it (mounts item 2 covers the installation's `CLAUDE.md`, which is the entry
  point).
- **Desk (A1–A8, ADR 0006):** the desk is the first installation agent. Its card format moves to
  akmon's standing-agent standard when akmon has one (ADR 0006 D01/D05 keep it interim). Authoring
  a second agent in an installation is akmon's "second case" for A69.

## Plan

| Slice | What | Who | Waits on |
|---|---|---|---|
| S0 | Owner decisions `D-A10-*`; the prompt (§ Appendix) run in an akmon session | owner, orchestrator | — |
| S1 | akmon: guided profile, actor carrier, a guided wiring manifest, the OPERATE group | akmon session | akmon A72, C173 |
| S2 | oikos: `setup author enable`, the installation's `_aitna/.akmon.toml`, `sync` writes the guided wiring from the manifest, installation `skills/` and `agents/` pointers with origin | k_implementer | S1, A9 S1 (the `sync.json` record pattern) |
| S3 | A first authored skill in a test installation, end to end, as the acceptance | k_validator, owner live | S2 |
| S4 | The promotion route: an installation skill proposed to the core | k_mechanic | S3 |

## Open points

| # | Point | State | Options → recommendation |
|---|---|---|---|
| **D-A10-SOURCE** | Where an installation's akmon comes from | **decided (owner): A** | The core's pinned akmon through `oikos/`: the user manages nothing, and one pin serves core and installation. Rejected: B, its own submodule or package pin. |
| **D-A10-WHEN** | Attach every installation, or on demand | **decided (owner): A** | On demand, at the first authoring: an installation that only operates stays unchanged. Rejected: B, always. |
| **D-A10-WRITER** | Who writes the installation's wiring | **decided (owner): A** | oikos `sync`, from a manifest akmon ships: the entry files have one owner. Rejected: B, akmon's `sync` beside oikos's. |
| **D-A10-WHERE** | Where authored skills and agents live | **decided (owner): A** | Shared in the installation's `skills/` and `agents/`, personal in `.local/`, mirroring D-A9-WHERE. Rejected: B, only `.local/`. |
| **D-A10-ROLE** | Is authoring by a non-developer a new role? | **decided (owner): A** | No: the `guided` actor over the existing development agent, with plain-language output. *Revisit if* the guided quality bar differs from the developer's (then B, an `author` role). |
| **D-A10-PROFILE** | The table in § The soft attach as oikos's input to akmon's D-GUIDED-PROFILE | **decided (owner): accepted** | Sent to akmon as it stands, through § Appendix. |

## Rejected (candidates)

- **A developer's attach in every installation.** The process weight (decision codes, gate audits,
  delegation asks) lands on people who cannot act on it. *Revisit if* installations are run by
  developers.
- **No akmon in installations; oikos keeps its own authoring rules.** That is a second standard for
  the same artifacts, and it drifts from akmon's.

## Appendix — prompt for an akmon session

> oikos (a consumer of akmon) needs a `guided` attach for its installations: folders where
> non-developers operate an assistant and sometimes author agents and skills. oikos proposes:
>
> - The installation uses the akmon its core pins; it has no checkout of its own, so akmon's root
>   finder must accept `_aitna/.akmon.toml` with the akmon mount outside `<AITNA_ROOT>`.
> - oikos's `sync` writes the installation's entry files and settings. akmon ships a **guided
>   wiring manifest**: the hooks, skill pointers and preamble for a `guided` actor, which a
>   consumer's own sync applies.
> - Under `guided`:
>   - artifact standards and prohibitions apply in full;
>   - roles, delegation, the tier floor and the gate audit are notes, never asks;
>   - there are no decision codes or ADRs in the chat; a consequential choice is one plain question
>     with a recommendation;
>   - the agent commits on its own branch, reported; push, merge to default, publish and delete
>     are asked with the consequence in plain words.
> - The OPERATE group gets formulated, with oikos's desk as its first agent.
>
> Please fold this into D-GUIDED-PROFILE, D-ACTOR-CARRIER, A72 and A69. Say which parts akmon
> accepts, which it changes, and what the consumer-side contract (manifest format, actor carrier)
> will be.
