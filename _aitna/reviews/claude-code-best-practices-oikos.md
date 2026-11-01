# Review — "Claude Code: Best practices for agentic coding", read for oikos

> **Point-in-time review, not a decision.** Source: Anthropic engineering post, published 2025-04.
> Written for the owner and architect of oikos, whose question is: *what in a coding-workflow
> guide helps people who do not program create and run agents with oikos?* Nothing here is a task
> until the owner says so. Role: learn.

## Verdict

The post is written for engineers: its safety net is git, its unit of work is a repository, and
its user can read a shell command. oikos's user is a CTO or manager whose work product is a
tracker comment, a message, a wiki page or a document, and who may never open a terminal. So most
of the post does **not** transfer as written. About a third of it transfers as a *principle*,
and the post is silent on the parts that matter most for non-programmers (below, § C).
The largest gap is the one the post never has to think about: its safety net, git, is present for
an engineer and may be absent for a manager. The owner's direction is to recommend a local git
repository at installation setup (B8, § C1).

The post contains **no evidence about non-programmers**. Every "for non-programmers" statement in
this review is my inference from oikos's design, marked as such, not a finding from the post.

The mechanics in the post (`/project:` commands, the `#` key, "ultrathink", `--allowedTools`)
describe the 2025-04 harness. Check current behaviour before using any of them.

## A. What transfers, as a principle

| Post | Reading for oikos | Where oikos stands |
|---|---|---|
| **Instructions are a prompt to be tuned.** The context file needs no format, should be short and human-readable, and should be iterated until the model follows it (1a, 1b) | The installation's `AGENTS.md` is that file, and it is the part a non-programmer writes. The post's advice to *check that it is followed* is the missing half | oikos says what the file holds, not how to know the agent obeys it. See B1 |
| **A repeatable procedure is a markdown template with an argument** (2c, `$ARGUMENTS`) | The lowest-ceremony way a non-programmer can make "the thing I do every Monday" repeatable, with no code | A skill is heavier: frontmatter, `surface`, `refuses`, triggers. There is no rung below it. See B2 |
| **Look first, plan, then act; save the plan so you can go back** (3a) | For oikos "act" is a write to a live service, which cannot be rolled back | The `desk` agent already does exactly this: a table of units, then drafts, then a confirmed write. It is the best in-house match, and a template for new agents. See B3 |
| **Specific instructions beat vague ones** (4a, the poor/good table) | The one change that most improves a non-programmer's results, and costs nothing to ship | oikos has trigger phrases but no worked "poor → good" examples for its own skills. See B4 |
| **Markdown checklists and scratchpads hold the working state** (4g) | Confirms `desk`'s rule "memory is the disk, not the context" | Covered. Cite it as outside support for ADR 0006 |
| **Write the expected result first, confirm it fails, then build** (3b, test-first) | The strongest idea for *creating* an agent without coding: write example requests and the behaviour you expect before the agent exists | Not present. See B5 |
| **A second instance with a clean context reviews the first's work** (6a) | A non-programmer cannot review a `SKILL.md` for faults; another agent can read it cold and try it | Not present for authoring. See B5 |
| **Teach a tool by name plus usage examples, or by `--help`** (2a) | How oikos's CLIs reach the agent | Covered: `SKILL.md` carries the command lines |
| **Shared project config for tool servers** (2b, `.mcp.json`) | `oikos.yaml` `mcp_servers` | Covered. The post's `--mcp-debug` has its counterpart in `setup status` |
| **Ask the agent about the system to learn it** (3e) | A manager can learn what is installed by asking | See B6 |
| **Headless runs from an event or a schedule** (5, 5a) | The route from a standing agent to a scheduled one: a morning digest, tracker triage | See B7 |

## B. Candidates

Ordered by value to a non-programmer. Each states the gate it passes through.

**B1 — Make "is the agent following my instructions?" answerable.** A non-programmer who edits
`AGENTS.md` has no way to see whether the change worked except by trying and hoping. Offer a small
check: a short list of sample requests with the expected behaviour (for example "asked to post,
shows a draft and stops"), run on demand, reported in plain words. Gate: architect, since it
touches the installation contract. Inference: this matters more for people who cannot read the
agent's prompt than for the engineers the post addresses.

**B2 — A recipe rung below the skill.** A plain file in `.local/` — a title, numbered steps, one
argument — that the agent can run, and that is promoted to a skill when the user (or the shared
experience step in OIKOS.md) finds it general. This is "reach a result, then refine" applied to
authoring. Open questions: whether the host lists `.local/` files as invocable, which the sync
tool would have to be probed for; and what a recipe may never do (it carries no write that a
skill's own gate does not already cover). Gate: architect; it is the same decision as akmon's
D-AGENT-AUTHORING and D-AGENT-LEARN, so take it there, not separately.

**B3 — Make `desk`'s shape the template for any new agent.** The plan-then-confirm structure
(show the split, agree it, then write) is what the post calls "steps 1–2 are crucial". Name it as
the default skeleton for an agent a non-programmer creates, with the never-list ("refuses") as a
required part. Gate: part of oikos's agent-authoring guide; a second standing agent would confirm
which parts are general and which are `desk`'s own.

**B4 — Worked "poor → good" requests in the installation guide.** A handful for the real skills,
for instance a vague "sort out the thread" against "summarise the thread of PROJ-123, list the
decisions and open questions, draft one status comment, do not post it". Cheap, immediate,
and no design decision. Gate: none beyond the owner's wish.

**B5 — "Examples first" and an independent reader, as the way a non-programmer builds and
checks an agent.** Adapting the post's test-first and writer/reviewer patterns: (1) the user
states three to five example requests and what the agent must do and must refuse; (2) the agent
is drafted from them; (3) a second agent with a clean context reads the draft and tries the
examples, reporting plainly where it fails. No code is written by the user at any step.
Gate: architect, as the creation flow of a standing agent; the examples become the agent's
check from B1. This is the one idea in the post that I think changes what oikos can offer.

**B6 — "Ask me what is installed."** A short entry (or a skill) so a new user can learn by
asking: which skills exist, what each may write, what is still unset. Everything it needs is in
`oikos.yaml`, `LANDSCAPE.md` and `setup status`. Low cost; no new mechanism.

**B7 — Scheduled, draft-only runs.** The post's issue-triage example is a run nobody is
watching. For oikos the safe form is narrow: a scheduled run that **reads and drafts, never
sends**, leaving results where the user will look. Two facts constrain it: a headless run cannot
answer a permission prompt, and the post notes it does not persist between sessions. Gate:
architect, and only with the OPERATE decisions in akmon's ROADMAP § O1, since propose ≠ execute is
the line it must hold. Do not start before the draft-only rule can be enforced, not just stated.

**B8 — Recommend a local git repository when the agent is initialized (owner's direction).** The
post's recovery tools all rest on git (§ C1), and a non-programmer has none by default. So the
installation setup should check whether the installation folder is under version control and, if
not, **recommend creating a local repository and offer to do it**, explaining in plain words what
it gives: every change to the agent's own files can be seen and undone. Proposed shape, for the
architect to settle:

- **Where it is offered.** In `tools/setup` (and visible in `setup status` as "history: on/off"),
  not as a manual step the user must know about. Declining is allowed and is recorded, so the
  recommendation does not repeat on every run.
- **What it covers.** The installation's own files and `.local/` (agent memory, notes, recipes,
  drafts), so an agent that rewrites its memory or a recipe can be rolled back. It does **not**
  roll back an external write; that stays behind the confirmation gate (§ C1).
- **What it must exclude.** The dot-named stores (`.env`, `.secrets/`, `.browser/`) go into the
  ignore file in the same step, before the first snapshot. `.local/` holds personal material, so
  the repository is local only: no remote, no push, and nothing in setup that suggests one.
- **Who writes the history: semi-automatic, never automatic (owner's decision).** The agent
  proposes a commit and **asks the user** whether to record the change in the history; the user
  never types git. Before the question, a simple but **independent** review of the change runs (a
  separate clean-context reader, not the agent that made the change), and the question carries its
  plain-words result. The commit is made by an oikos CLI step, not by the agent running raw git
  commands; it stages named paths only, never the dot-named stores. Push, merge and tag stay out of
  reach. Open: whether the same step offers "undo the last change" in plain words. The relaxation
  of akmon's commit rule that this needs is E3 below; the akmon side is its review's E9.
- **Git itself may be missing.** `setup status` should say so and give the install step for the
  user's system, rather than failing; without git the installation still works, as it does today,
  and the gate in B7 and E1 remains the only safety.
- **Interaction with `oikos/` as a symlink or submodule.** The repository belongs to the
  installation folder, not to the shared `oikos/` checkout, whose history is the maintainers'. Check
  how the existing layouts nest before writing the setup step; I have not verified it.

Gate: architect, since it adds a setup step and a default to the installation contract, and it
meets two rules (E3 below). Portable by construction: git and the oikos CLI are the floor, so no
harness feature is needed (§ D).

## C. What a non-programmer needs that the post assumes away

These are the reasons the post cannot be copied wholesale. They are my reading of oikos, not
statements from the post.

1. **No git means no undo.** The post's recovery tools (commit as checkpoint, revert, worktrees,
   double-Escape to a prior state) all rest on version control. A manager's `.local/` and
   documents may have none, and an external write (a sent message, a posted comment) cannot be
   reverted by anyone. This is why the confirmation gate before every write is the design, and why
   it must not be loosened to speed things up. Two protections are then needed, and they are
   different: the **gate** for what leaves the machine, and a **local history** for what stays on it.
   The owner's direction is to recommend a local git repository at initialization (B8) so the second
   exists by default. It also helps in a second way: a user who edits `AGENTS.md` (B1) can see and
   undo what they changed.
2. **Permissions are not a user-level concept.** The post asks the user to curate an allowlist in
   the form `Bash(git commit:*)` and to pick between "always allow" and "skip all permissions".
   A non-programmer cannot judge that. If oikos presets permissions it should do so in the
   installation setup, per skill, and describe them as actions ("read mail", "post to the
   tracker"), not shell patterns.
3. **The "safe YOLO" advice does not apply.** Skipping permission checks inside a container
   without internet is workable for an engineer on lint fixes. oikos's work is reading live mail,
   chats and the web and writing to live services: the case where the post's own warning, data
   exfiltration by prompt injection, bites hardest. The post gives no remedy for that case. Check
   that OIKOS.md and the skills treat pasted or fetched material as data, not instructions;
   I did not find that stated in OIKOS.md's first 70 lines, and have not read the whole file or
   every skill.
4. **Context management should not be the user's job.** The post teaches `/clear`, interruption
   and history editing. A non-programmer should not have to. Standing agents that keep their
   state on disk (`desk`) are the right answer; the open work is the resume step, not a user habit.
5. **The unit of work is not a pull request.** The post's loop ends in a commit and a PR. oikos's
   loop ends in a confirmed write or a saved draft. The post offers nothing on approval by someone
   other than the user, on who may create an agent for a team, or on retiring one.
6. **Git, GitHub, Jupyter and iTerm tips** (3f–3h, 6b, 6c) do not apply.

## D. Harness portability

oikos is delivered through plain files and per-harness pointers (`.claude/skills/`,
`.qwen/skills/`, and the `CLAUDE.md`, `QWEN.md`, `GEMINI.md`, `AGENTS.md` entry files), so
an idea is portable when it lives in a file or in an oikos CLI, and harness-specific when it
needs a hook, a named subagent or a slash command. akmon's measured per-carrier state is in its
`CAPABILITIES.md`; two of its facts matter here: Codex does not expand `@` imports in
`AGENTS.md` (by akmon's measurement of the same `@` form, OIKOS.md would reach it as literal text unless the installation inlines it; not re-measured for oikos), and the
commit guard that denies at the tool boundary is shipped on Claude Code only.

| Item | Tier | Per-harness note |
|---|---|---|
| B1 adherence check | floor | The examples are plain data. Running them needs a headless run on **the harness the user actually uses**, since behaviour differs. Writes go through oikos's `--dry-run`, so a check never posts |
| B2 recipe | floor source, per-harness pointer | One markdown file; `tools/sync` writes each harness's own pointer. Probe per harness whether an argument reaches the recipe; the fallback is "the text after the name" |
| B3 `desk` template | floor | Prose. A standing agent assumes a long-open session, which not every harness resumes the same way; disk memory is what makes it portable |
| B4, B6 worked examples, ask-what-is-installed | floor | None |
| B8 local git at setup | floor | Git and an oikos CLI step; no harness feature. The history is written by the oikos step, so it is the same on every harness and does not depend on a harness's own checkpoint or rewind. The Codex hook-trust-by-root point in the akmon review does not apply, since nothing here is a hook |
| B5 examples-first plus an independent reader | floor, plus a headless run | The independent reader is a **separate process with a clean context**, which works on any harness with a non-interactive mode. A harness-native subagent is an optional accelerator, not the mechanism |
| B7 scheduled draft-only runs | trigger outside the harness, run per harness | **Put the draft-only gate in oikos's own CLIs** (a write refuses without the confirm step), not in a harness permission. Hook-based denial exists on Claude Code only; a gate in the tool holds on every harness |

### Claude-only features in the post worth a port

| Feature | Port idea | Worth it? |
|---|---|---|
| Slash commands with `$ARGUMENTS` (2c) | B2: one recipe file, a pointer per harness | **Yes** — the most useful single idea for non-programmers |
| Permission allowlists and modes (1c) | A per-skill permission preset written by `tools/setup`, rendered per harness and described as actions, not shell patterns | **Yes** — see C2 |
| Nested context files loaded on demand (1a) | Keep the installation's always-loaded `AGENTS.md` short; push skill detail to files read on demand. Also the answer to the Codex `@` gap | **Yes**, after a per-harness probe |
| Rewind / double-Escape / undo (4e) | Not portable; the substitute is the local git history set up at initialization (B8, C1), which works on every harness | **Yes, as the substitute** |
| Headless `-p` (5) | Each harness has its own non-interactive form; B1, B5 and B7 all need one. A single oikos wrapper that hides the per-harness flags would spare a non-programmer from ever seeing them | **Yes** — akmon already keeps a carrier table for this |
| `/clear`, "think" keywords, `#` memory key, image paste | Not for a non-programmer; the agent should manage its own context | **No** |

## E. Where the post runs against oikos's rules

Flagged separately: a row is a disagreement to decide, not advice to take. No rule is changed here.

| # | Post | Our rule | Kind | Reading |
|---|---|---|---|---|
| E1 | **Auto-accept and "skip all permissions"** (3d, 4e) | OIKOS.md: a changing action against a live service is shown first and runs only after the user confirms; the dot-named stores (`.env`, `.secrets/`, `.browser/`) are closed to the agent's file tools | **Direct** | The post's unattended mode would remove the gate and open the stores. The rule is right for oikos: its writes are not reversible and its input is mail, chat and web. It means oikos has no unattended mode today, so B7 depends on a gate inside the tools (§ D) |
| E2 | **Plans and checklists in a GitHub issue; agent opens PRs and pushes** (3a, 3g, 4g) | AGENTS.md: stage by name; push, merge or pull request only on the user's explicit request. An installation's own files hold only what agents read, never drafts or working material | **Direct** | Neither practice fits. In oikos the equivalent plan lives under `.local/desk/`, and a draft sent to a tracker is a write behind its own confirmation |
| E3 | **The agent does 90% of git, including commits** (3f) | The akmon layer imported here: never `git add`/`commit` on the owner's behalf unless told; the owner stages and commits. A hook asks or denies a commit on the default branch | **Direct, and B8 makes it live** | **Owner's decision:** for akmon's own development the rule stays; a developer commits. Projects built on oikos with akmon as a dependency (for example a manager's own working installation) need a **different mode** in which it is relaxed, and only to **semi-automatic**: the agent asks the user whether to record the change, after a simple independent review of it, never on its own. The relaxation is **initialized from oikos** (setup turns it on, B8); how akmon supports it is a design question and is taken as E9 in the akmon-side review, where the open points are listed. Still unchanged in that mode: no push, merge or tag by the agent, no AI co-author trailer, no staging of the dot-named stores. Not decided here: the commit's branch (a fresh installation repository has only a default branch, which today's commit guard treats as an ask) and the language of the commit message, since akmon requires English for persistent artifacts and the user may not write it |
| E4 | **Several parallel sessions on worktrees** (6b, 6c) | None in oikos. The inherited akmon layer has the worktree limit recorded in its ADR 0022, and the owner has asked to take worktrees back to discussion | **No rule** | For oikos the parallel-session case is different: two agents writing to the same tracker or `.local/desk/` at once. Decide that with akmon's worktree discussion, not apart from it |
| E5 | **Pass data by piping logs and files, give URLs freely** (4d, 4h) | OIKOS.md: knowledge comes from the named knowledge base, not memory; a link or key no tool result or the user gave is refused (in `notes`) | **Tension** | Free URLs are fine for reading. The risk is fetched content steering the agent; the post does not address it, and § C3 says so |
| E6 | **Subagents and several instances that talk through scratchpads** (6a) | `.local/` holds personal working material under this machine's user; nothing in oikos or its notes may name people or organizations | **Tension** | A scratchpad shared between agents is personal data by design in oikos (the people file, notes). It stays under `.local/`; an independent reader (B5) should be given only what it needs |

### What to bring to the owner

1. **E1 and E4 first.** E1 decides whether unattended runs exist at all; E4 meets the worktree
   discussion that is open on the akmon side.
2. **B8 with E3: local git at setup, semi-automatic commits.** Direction is set by the owner:
   akmon's rule stays for akmon, and an oikos-initialized mode relaxes it to ask-after-independent-
   review. What remains for oikos is the setup step, the plain-words question and the commit
   branch; the akmon-side support is E9 there. E2 is settled by oikos's own rules; no change
   suggested.
3. E5, E6: confirm that OIKOS.md says fetched and pasted material is data (C3).

## F. Where this feeds akmon's open decisions

oikos is the first real case behind akmon's A69 (standing agents). The relevant requests are
D-AGENT-AUTHORING (B2, B3, B5), D-AGENT-LEARN (B2) and D-AGENT-ARCHETYPE (B7). The akmon-side review
of the same post is `meta/reviews/claude-code-best-practices-akmon.md` in the akmon repository.

## G. Open points found during the review

Findings that surfaced while reading the post against oikos, collected in one place. They are
**not tasks, designs or decisions**; nothing here is implemented or chosen. Each says what was
seen, what is not known, and how well the seeing is backed: **read** (in the tree), **inferred**
(reasoning from oikos's design, no check) or **not checked**. The discussion is in the section named
in the last column. The akmon-side points are numbered G1–G22 in the akmon review and are cited
here as `akmon G<n>`.

| # | Found | Not known | Backing | See |
|---|---|---|---|---|
| G1 | The post has no evidence about non-programmers | Whether anything said here about them holds for real users | **inferred** throughout; no user was observed | Verdict, C |
| G2 | A manager's installation may have no git, so the post's recovery tools (checkpoint, revert, rewind) are absent | How many installations have no git; the post's tools were not tried on a non-programmer | **inferred** | C1, B8 |
| G3 | A local git repository at setup is recommended (owner's direction) | How the existing layouts nest: `oikos/` as a symlink or as a submodule inside the installation folder; where the record of a declined offer lives; what the ignore file must hold on a machine with its own stores; what to say when git itself is missing | direction set; the nesting **not checked** | B8 |
| G4 | The agent may not commit under akmon's rule, yet a non-programmer cannot stage and commit; the owner's direction is a semi-automatic mode (the agent asks, after an independent review, never automatic), initialized from oikos | What the setup step sets; the commit's branch (a fresh repository has only a default branch); the language of the commit message; how the question is put in plain words; whether an "undo the last change" offer exists; the akmon side is `akmon G9` | direction set; no design | B8, E3 |
| G5 | Which model reads a change independently before the commit question, and with what context | Whether a same-family reader is acceptable for a low-risk change; what it may see of personal material | not decided | B5, E3, E6 |
| G6 | oikos has no unattended mode; B7 (scheduled draft-only runs) depends on a gate inside the tools, not on a harness permission | Whether every write in oikos's CLIs refuses without a confirm step; whether `--dry-run` covers all of them | **not checked** across the CLIs | B7, E1 |
| G7 | Pasted or fetched material is data, not instructions: I did not find this stated in the first 70 lines of OIKOS.md | Whether it is stated elsewhere in OIKOS.md or in any skill | **not checked** beyond line 70 | C3, E5 |
| G8 | OIKOS.md reaches Codex as literal text if the installation does not inline it, by akmon's measurement of the same `@` form | Whether the same holds for oikos's own entry files | akmon-measured; **not re-measured** for oikos | D, `akmon G13` |
| G9 | A recipe below the skill needs the host to list `.local/` files as invocable and to pass an argument | Whether `tools/sync` can do it on each harness; what a recipe may never do | **not checked**; `akmon G14` | B2, D |
| G10 | The adherence check (B1) and the independent reader (B5) need a headless run on the harness the user actually uses | Which harnesses give a stable non-interactive form and result shape | not checked for oikos; `akmon G15` | B1, B5, D |
| G11 | Permissions as actions ("read mail", "post to the tracker"), preset per skill at setup | Whether such a preset can be rendered on every harness, and with what effect (`deny`, `ask`, `advisory`) | **not checked**; `akmon G16` | C2, D |
| G12 | Parallel agents may write to the same tracker or `.local/desk/` at once | What guards the shared state; how this meets the worktree discussion (`akmon G1`) | **not checked** | E4 |
| G13 | A scratchpad shared with an independent reader is personal data by design in oikos | What a reader should be given, and what it must not | not decided | E6, B5 |
| G14 | `desk` is the only standing agent; its charter mixes a general shape with its own topics and units | Which parts are general; `akmon G20` | read | B3, F |
| G15 | The word `desk` names the agent, its `.local/desk/` folder, its tool and its ADR, and the owner notes it collides with the current work session's name | Whether the agent, the folder and the tool should carry separate names; `akmon G21` | owner's observation; **not checked** | B3, F |
| G16 | The post is silent on approval by someone other than the user, on who may create an agent for a team, and on retiring one | oikos has no decision on any of them | not decided | C5 |
| G17 | The post's own mechanics may be stale (2025-04) | Which of them apply in the current harnesses; `akmon G22` | **not checked** | Verdict |
