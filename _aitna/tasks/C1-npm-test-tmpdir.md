# C1 · The test suite depends on where TMPDIR points

Detail for the [backlog](../TASKS.md) row `C1`.

## Observed

`npm test` in the core: with `TMPDIR` inside the user's home folder (this machine exports
`TMPDIR="$HOME/.tmp"` from `~/.bashrc`), 39 lines of `tests/handoff.test.mjs` fail; with
`TMPDIR=/tmp npm test` the same suite is green (measured: exit 0, 1077 tests, 1076 pass, 1 skipped,
273 s). The failing assertion is always the same shape — the test expects one refusal message and gets
another:

```
handoff: Refusing --from '<tmp>/claude-1000/<slug>/session-1/scratchpad/draft-review.md':
it resolves outside the installation, this installation's session scratchpad (…) or $OIKOS_SCRATCH;
not taken as a source root: the temporary folder <tmp> is, holds or lies in the home folder <home>.
Nothing was copied.
```

## Mechanism

- `tests/handoff.test.mjs` builds its fixture in the process temporary folder and fakes the Claude Code
  session scratchpad under it: `<tmp>/claude-<uid>/<slug>/<session>/scratchpad` (`tests/handoff.test.mjs:19-24`).
- `park --from` accepts a source from that scratchpad only while the temporary folder itself is a
  credible scratch root; `tools/handoff/cli.mjs:111` refuses a root that *is, holds or lies in* the home
  folder, and `:207` folds that refusal into the message above. The rule is deliberate: a scratch root
  that reaches the home folder would let a park take `~/.ssh/id_rsa`.

So the guard is right and the test is wrong about the environment — but the same pair is visible to a
user: on a machine whose `TMPDIR` sits under `$HOME`, **no** scratch file can be parked, whatever the
agent passes, and the only way out (`OIKOS_SCRATCH` elsewhere) is not said by the message.

## Where, how, when it runs

| | |
|---|---|
| Path | `tests/handoff.test.mjs` (the fixture root), `tools/handoff/cli.mjs` (the rule) |
| Runner | `npm test` → `node --test tests/*.test.mjs`; also CI's `oikos` job (`.github/workflows/akmon.yml`) |
| Trigger | every local check of a change, every push and pull request |
| Today | CI passes because a runner's `TMPDIR` is `/tmp`; a home-diverted `TMPDIR` is what a developer's own shell has |

## Decide, then fix

1. **The suite** must not inherit its scratch root from the caller's `TMPDIR`: give the fixture a
   temporary folder known to be outside the home (`mkdtemp` under `/tmp`, with the existing
   `tempDir` helper pointed at it), so the suite says the same thing on every machine.
2. **The guard** keeps its refusal; the open question is only whether the message names the way out
   (`OIKOS_SCRATCH=<folder outside the home>`), since that is the user's only route on such a box.
   Weakening `inside(path, home) || inside(home, path)` is not on the table without an owner decision.

## Done when

- `npm test` is green with the default `TMPDIR` of a shell whose `TMPDIR` is under `$HOME`, and with
  `TMPDIR=/tmp` — both runs, output pasted.
- The refusal message for a home-based temporary folder names `OIKOS_SCRATCH` as the way out, with a
  test for the wording.
- `npm run check` green; nothing staged or committed.
