# opencode-debug-harness — Specification

- **Status:** Accepted 2026-11-23 (spec only; nothing is implemented)
- **Date:** 2026-11-19
- **Target runtime:** OpenCode 1.19.0, `@opencode-ai/plugin` 1.19.0 (Bun runtime, `bun:sqlite`)
- **Sibling:** `jflowers/opencode-research-harness` (same shape: plugin-enforced discipline, ledger, gate, ratchet, export). Hook facts below are taken from that spec's §3.4, which was checked against 1.19.0.
- **Requires:** a git work tree (v1).

This document has four parts: **Part 1 — ADR-001**, **Part 2 — PRD**, **Part 3 — Technical specification**, **Part 4 — Decisions** (D1–D9, accepted 2026-11-23).

---

# Part 1 — ADR-001: Plugin-enforced scientific debugging loop

- **Status:** Accepted 2026-11-23

## 1. Context

A coding agent debugging a failure tends to do the things a tired person does, faster:

- **Edits before it can reproduce.** It changes code based on a reading of the stack trace, then runs something that isn't the original failure.
- **Stacks experiments.** Change A doesn't fix it, so change B goes on top of A. When B "works" nobody knows whether B alone works, whether A+B is needed, or whether A broke something else. This is the *lost causal attribution* and *speculative poisoning* problem from the "Agents Don't Get Bored" draft, inside a single investigation.
- **Grades its own result.** "I ran the tests and they pass now" is the actuator reporting on itself. Sometimes it ran a different command, a subset, or nothing.
- **Never undoes.** Debug logging, a commented-out check, a changed timeout and a bumped dependency all survive into the final diff.
- **Declares victory on one green run.** No evidence the change is *why* it went green, and no check that it didn't break something else.
- **Loops.** Same error, slightly different guess, ten times.

The loop that works is old: hypothesis → experiment → observation → conclusion, with the system put back to a known state between experiments, and a fix accepted only when toggling it toggles the failure. A prompt can describe that loop. It can't make the agent follow it, and the parts that matter most (reset, independent observation, the toggle) are exactly the ones an agent skips when it's confident.

## 2. Decision drivers

- **The harness observes, not the model.** Every observation that counts as evidence is a repro run the harness executed and recorded. The model interprets; it never reports outcomes.
- **Reset is verified, not trusted.** After an experiment the work tree is restored *and* the repro is re-run and must match the baseline failure again. A reset that doesn't re-break the system didn't happen.
- **Repeatable repro before any change.** No edits until the failure has been reproduced the same way N times on the untouched tree.
- **One variable at a time.** Experiments start from the baseline, not from the previous experiment.
- **Fixed means toggled.** Red → apply → green → revert → red → reapply → green, with the existing checks no worse than at baseline.
- **Works in any repo.** Debugging happens wherever the bug is, so the harness can't depend on a project layout, and its own state must live outside the tree it resets.
- **Zero server footprint, no model calls, no side sessions.** Same constraints as the research harness. Coexist with the supervisor.

## 3. Options considered

1. **Skill only** (a `debug-loop` skill describing the method). Rejected as the whole answer: nothing stops edits before a repro, stacked experiments or unverified resets. Kept as the companion skill.
2. **Supervisor directive only.** Rejected as the whole answer: the supervisor audits after the fact. It can say "you didn't reset" but can't undo the stacked change. Kept as a second line (Part 3 §3.10).
3. **Extend `opencode-research-harness` with a debug mode.** Rejected: that plugin is project-scoped to the research repo's `topics/` layout and its claims are about sources, not about a mutable work tree. The modules that carry over (double-load guard, tool-output shape handling, ledger/gate patterns, status injection) are shared by copy first and extracted later (D7).
4. **Separate plugin, `opencode-debug-harness`, loaded globally and inert until an investigation is opened.** **Accepted.**

## 4. Decision

Build `opencode-debug-harness`. It owns a per-investigation state machine and enforces it with hooks:

- `debug_open` locks a repro and confirms a consistent baseline failure.
- Edits are rejected unless an experiment is open, and are confined to the experiment's declared scope.
- Each experiment starts from the baseline snapshot, its diff is saved as a patch, and ending it restores the snapshot and re-verifies the baseline failure.
- The harness runs the repro; observations carry the harness's record, not the model's account.
- `debug_conclude` gates `fixed` on a full toggle plus guard checks, and `understood` on a confirmed prediction.
- A circuit breaker forces a step back after repeated refuted hypotheses.

## 5. Consequences

- **Slower first minutes.** The agent must write a repro before touching code. That is the point; the cost is front-loaded and every later step gets cheaper and more trustworthy.
- **The repro must be scriptable.** Bugs without a scriptable repro get a weaker, explicitly labeled path (D3).
- **Bash can't be fully contained.** Edit tools are gated precisely; shell commands are classified by pattern. Anything a command changes that the snapshot doesn't cover is caught by the post-reset re-verification, not prevented.
- **Global plugin.** It loads in every session, so every hook must return immediately when the session has no open investigation.

---

# Part 2 — PRD

## 1. Objective

Make an agent debug the way a careful engineer does: reproduce first, change one thing, observe independently, put it back, and accept a fix only when it demonstrably toggles the failure. End every investigation with a durable record of what was tried, what was learned and why the fix works.

## 2. Users and use

- **Jay**, in opencode, in any git repo, says "debug X" or runs `/debug <symptom>`. The `debugger` agent (or any agent with the skill) drives the loop.
- **The supervisor**, auditing the session, sees harness rejections as tool failures and checks the discipline directive.
- **Later sessions**, via the investigation report and (when the repo has a Dewey vault) a Dewey learning.

## 3. Functional requirements

### FR-O: Open and baseline (module `investigation`)

- **FR-O1** `debug_open({ symptom, repro, guard?, scope?, runs? })` creates an investigation bound to the session and the work tree (`ctx.worktree`). Only one open investigation per work tree, across sessions and processes (lock in the state dir); a second open is rejected and names the holder.
- **FR-O2** `repro` is `{ cmd, cwd?, timeoutSec?, env?, failSignature? }`. `cmd` runs via `bash -lc` in the work tree. `failSignature` is an optional regex identifying *this* failure (e.g. `TypeError: Cannot read properties of null \(reading 'total'\)`).
- **FR-O3** The harness snapshots the work tree as-is (**baseline snapshot**; uncommitted changes are part of the baseline) and runs the repro `runs` times (default 3) on it.
- **FR-O4** Outcomes are classified per run: **red** (fails and matches the fingerprint), **green** (exit 0 and signature absent), **other** (fails differently, times out, or exits 0 with the signature present). The baseline must be red on every run. If runs disagree the investigation is **flaky** (FR-O6). If none are red, `debug_open` fails with the observed outcomes: "can't reproduce, refine the repro".
- **FR-O5** The **fingerprint** is the exit code plus the `failSignature` match, or, when none is given, the first error-looking line of output normalized (timestamps, hex addresses, durations, temp paths and PIDs replaced by placeholders). It is shown to the model and may be tightened later with `debug_refine_repro` (which re-runs the baseline).
- **FR-O6** Flaky mode: every later observation runs the repro `flakyRuns` times (default 5). Red = failure rate not significantly below baseline (default: ≥1 failure when baseline rate ≥ 60%); green = 0 failures across all runs. Reports state the run counts. A flaky investigation can't conclude `fixed` with fewer than `flakyFixRuns` (default 10) consecutive greens.
- **FR-O7** `guard` (optional) is the pass-to-pass check, e.g. the package's test suite minus the repro. It runs once at baseline and its pass/fail per test (when the output is TAP/JUnit/`bun test`/`go test -json`/`pytest` parseable) or overall exit code is recorded.
- **FR-O8** **Locked files.** Files the repro reads that the agent names (`repro.locks`, default: any test file mentioned in `cmd`) are hashed at open. Experiments may not modify them (the model doesn't get to edit the test to make it green). Changing the repro goes through `debug_refine_repro`, which re-baselines and is recorded.

### FR-H: Hypotheses (module `ledger`)

- **FR-H1** `debug_hypothesize({ statement, mechanism, prediction, falsifier })`. `prediction` is structured: `{ intervention: string, expect: "green" | "red" | "other" | { outputMatches: regex } | { outputLacks: regex } }`. `falsifier` says what observation would refute it.
- **FR-H2** Rejected when the prediction can't be checked by a repro run (no `expect`), when `statement` duplicates an open or refuted hypothesis (normalized text), or when the circuit breaker is tripped (FR-B).
- **FR-H3** Status: `open → supported | refuted | inconclusive`, set only by the harness from experiment outcomes (FR-X5). `debug_hypothesis_note` appends interpretation without changing status.

### FR-X: Experiments and reset (modules `experiment`, `snapshot`)

- **FR-X1** `debug_experiment_start({ hypothesis_id, kind, scope, touches? })`. `kind` is `intervention` (change predicted to flip the outcome), `probe` (instrumentation; prediction is about output), or `toggle` (remove or reinstate the suspected cause). `scope` is a list of path globs the experiment may edit. `touches` declares non-git state with a reset command each (`{ what: "local postgres schema", reset: "make db-reset" }`).
- **FR-X2** Precondition (**reset ratchet**): investigation state is `ready` (the last reset was verified, or nothing has been changed since open). Otherwise rejected with the exact recovery step.
- **FR-X3** While an experiment is open, edit tools may write only inside `scope` and never to locked files. Outside an experiment, edit tools are rejected outright. Bash commands that match the mutating pattern are allowed during an experiment (logged) and rejected outside one; history-changing git commands are always rejected during an investigation (§3.6).
- **FR-X4** `debug_run()` runs the repro (and with `{ guard: true }`, the guard) on the current tree. Output is written to the state dir; the model gets a summary: outcome, fingerprint match, run counts, the signature line, the last 20 lines, and a `log_ref` path (claim check). Usable any time an investigation is open.
- **FR-X5** `debug_experiment_end({ interpretation })`:
  1. Runs the repro on the experiment tree (unless a `debug_run` already ran on the identical tree) and compares to the prediction. Verdict: **supported** (matches `expect`), **refuted** (contradicts it), **inconclusive** (`other`, timeout, or flaky disagreement).
  2. Saves the experiment's diff against the baseline snapshot as a patch, plus copies of any edited ignored files (§3.5).
  3. **Resets**: restores the baseline snapshot, runs each `touches[].reset`, then **re-verifies**: the repro must be red with the baseline fingerprint and the tree must equal the baseline snapshot (§3.5). On success the state returns to `ready`. On failure the state is `diverged` (FR-X7).
  4. Records the verdict on the hypothesis and an event in the ledger.
- **FR-X6** `debug_experiment_abort()` resets without a verdict (verdict `aborted`; the hypothesis stays `open`).
- **FR-X7** **Diverged**: every tool except `debug_status`, `debug_reset` (retry), `debug_rebaseline` and `debug_close` is rejected for this session's edits and new experiments. The rejection lists what differs (files, fingerprint) so the agent or the user can fix it.
- **FR-X8** `debug_rebaseline({ reason, from_experiment? })` makes the current tree, or a past experiment's patch applied to the baseline, the new baseline (e.g. keep instrumentation for several experiments). Re-runs the baseline check (must be red). Recorded; the conclusion report lists every rebaseline, and `fixed` is checked against the **original** baseline (FR-C2).
- **FR-X9** `debug_bisect({ good, bad? })`: built-in experiment kind. Runs `git bisect run` with the repro classifier (red → bad, green → good, other → skip) in a temporary worktree so the investigation tree is untouched. Records the first bad commit as an observation.

### FR-C: Conclusion gate (module `gate`)

- **FR-C1** `debug_conclude({ kind: "fixed" | "understood" | "abandoned", summary, root_cause, hypothesis_ids, fix_experiment? })`.
- **FR-C2** `fixed` requires `fix_experiment` (an intervention whose verdict was supported). The harness then runs the **toggle proof** starting from the *original* baseline:
  1. baseline → red (fingerprint matches),
  2. apply fix patch → green, and guard no worse than at baseline (no test that passed at baseline now fails),
  3. revert → red,
  4. reapply → green.

  Any step failing rejects the conclusion with the step and the outcome. On success the fix is **left applied and uncommitted** (the only time the harness leaves changes), and the investigation closes.
- **FR-C3** `understood` requires at least one `supported` hypothesis among `hypothesis_ids` and records evidence strength: **toggled** (a `toggle` experiment showed cause removed → green and a second showed cause reinstated → red), **predicted** (a non-trivial `outputMatches`/`outputLacks` prediction was confirmed), or **bisected** (FR-X9 found a commit, and reverting that commit's change in a `toggle` experiment turned it green). The report states which.
- **FR-C4** `abandoned` is always allowed and requires `summary`. Honest "we didn't find it" is a valid outcome.
- **FR-C5** Every conclusion lists hypotheses still `open` as "untested" in the report. Conclusions are rejected while an experiment is open or the state is `diverged`.

### FR-B: Circuit breaker (module `ratchet`)

- **FR-B1** After `breakerThreshold` (default 3) consecutive experiments with verdict `refuted` or `inconclusive`, `debug_hypothesize` and `debug_experiment_start` are rejected until `debug_step_back({ assumptions_checked, new_observations, plan })`.
- **FR-B2** The rejection text suggests concrete moves: narrow the repro (`debug_refine_repro`), add a `probe`, `debug_bisect` if a known-good ref exists, or re-read the baseline log (`log_ref`).
- **FR-B3** Also tripped when the same `statement` is re-proposed in different words (similarity above threshold against refuted ones) — warn only in v1.

### FR-R: Record and export (module `export`)

- **FR-R1** Every investigation keeps a full event log (opens, runs, hypotheses, experiments with patch refs, resets, verifications, rebaselines, conclusion) in the state dir.
- **FR-R2** On conclusion, a report `<state>/reports/<date>-<slug>.md`: symptom, repro, baseline fingerprint, hypotheses table with verdicts, experiments with diffstat, the toggle proof transcript, root cause, evidence strength, untested hypotheses.
- **FR-R3** If `reportDir` is configured for the repo (e.g. `docs/debugging/`), the report is also written there (after the final reset, so it is not undone) for the user to commit.
- **FR-R4** If the work tree has a Dewey vault (`.uf/dewey/`), write a learning tagged `debug` (category `gotcha`, confidence from evidence strength, `evidence` = report path + fix patch ref, `as_of` = `owner/repo@HEAD`), in the same frontmatter format as the research harness export.

### FR-S: Context (module `status`)

- **FR-S1** A ≤6-line status header injected via `experimental.chat.messages.transform` while an investigation is open: state, repro, baseline fingerprint, open experiment (hypothesis, scope), last verdict, breaker count.
- **FR-S2** `experimental.session.compacting` pushes the investigation block (symptom, repro, fingerprint, hypotheses with verdicts, current experiment, rebaselines). Never sets `prompt`.
- **FR-S3** `debug_status()` returns the same block in full.

## 4. Non-functional requirements

- **Inert by default.** With no investigation open for the session, every hook returns after one map lookup. Measured overhead target: < 0.1 ms per tool call.
- **State outside the tree.** Nothing the harness needs survives in the work tree, so a reset or `git clean` can't erase it.
- **Crash-safe.** If opencode dies mid-experiment, the next session in that work tree sees the investigation in state `experiment-open` (lock is held), and `debug_status` offers `debug_experiment_abort` (reset) or resume.
- **No commits, no pushes.** The harness never changes `HEAD`, branches, the index's committed history or remotes. Snapshots are stored as git objects under a private ref namespace (§3.5), never on a branch.
- **Bounded output.** Repro output never goes into context in full (FR-X4).
- **No model calls, no side sessions.**

## 5. Out of scope (v1)

- Non-git directories (D5).
- Multi-repo investigations (a bug spanning a service and its client library).
- Resetting remote state (staging databases, cloud resources). `touches` may declare a reset command, but the harness can't verify what it doesn't observe beyond the repro.
- Automatic minimization of the fix patch (delta debugging). Candidate for v2.

---

# Part 3 — Technical specification

## 3.1 Repository layout

```text
opencode-debug-harness/
├── package.json              # "@opencode-ai/plugin": "1.19.0"
├── src/
│   ├── index.ts              # entry: double-load guard, config, compose hooks
│   ├── config.ts             # options + <worktree>/.opencode/debug-harness.json + defaults
│   ├── shared-state.ts       # globalThis registry (copied from research harness, D7)
│   ├── db.ts                 # bun:sqlite schema
│   ├── state-machine.ts      # investigation states and allowed transitions
│   ├── modules/
│   │   ├── investigation.ts  # debug_open, debug_refine_repro, debug_close, lock
│   │   ├── runner.ts         # repro/guard execution, classification, fingerprint
│   │   ├── snapshot.ts       # tree snapshots, patches, restore, verify
│   │   ├── experiment.ts     # start/end/abort/rebaseline/bisect
│   │   ├── guard.ts          # tool.execute.before: edit + bash policy
│   │   ├── ledger.ts         # hypotheses, events
│   │   ├── gate.ts           # debug_conclude, toggle proof
│   │   ├── ratchet.ts        # circuit breaker
│   │   ├── status.ts         # header + compaction
│   │   └── export.ts         # report, Dewey learning
│   └── util/{bash-classify,normalize,tool-output}.ts
├── agents/debugger.md        # opencode agent definition
├── skills/debug-loop/SKILL.md
├── commands/debug.md         # /debug <symptom>
├── supervisor/debug-discipline.md
└── test/
```

Private GitHub repo `jflowers/opencode-debug-harness`. Loaded **globally** from `~/.config/opencode/opencode.jsonc` by absolute path (D6); the agent, skill and command are symlinked into `~/.config/opencode/`.

## 3.2 Configuration

Plugin options merged over `<worktree>/.opencode/debug-harness.json` merged over defaults:

```jsonc
{
  "stateDir": "~/.local/share/opencode-debug-harness",   // per work tree: <stateDir>/<sha1(realpath(worktree))>/
  "baselineRuns": 3,
  "flakyRuns": 5,
  "flakyFixRuns": 10,
  "reproTimeoutSec": 300,
  "guardTimeoutSec": 1200,
  "breakerThreshold": 3,
  "editTools": ["write", "edit", "patch", "apply_patch"],
  "bash": {
    "mutating": "\\b(rm|mv|cp|mkdir|touch|chmod|ln|tee|truncate|sed\\s+-i|perl\\s+-i|npm\\s+(i|install|uninstall)|bun\\s+(add|remove|install)|pip\\s+install|go\\s+get|make)\\b|>\\s*[^&]",
    "forbidden": "\\bgit\\s+(commit|reset|checkout|switch|restore|stash|rebase|merge|cherry-pick|revert|clean|am|apply|pull|push|branch\\s+-[dDmM]|update-ref|tag)\\b"
  },
  "reportDir": null,                 // e.g. "docs/debugging"
  "dewey": { "learningsDir": ".uf/dewey/learnings", "tag": "debug" },
  "ignoreSessionTitlePrefixes": ["supervisor-audit @", "supervisor-repair @"]
}
```

`bash.mutating` is a heuristic and errs toward matching; a false positive outside an experiment costs the agent one `debug_experiment_start`. `git apply` is forbidden because patches go through the harness.

## 3.3 State machine

```text
            debug_open (baseline red ×N)
none ─────────────────────────────────────► ready ◄─────────────────────────────┐
                                             │                                   │
                       debug_experiment_start│                                   │ reset verified
                                             ▼                                   │
                                      experiment-open ──debug_experiment_end──► resetting
                                             │                 /abort            │
                                             │                                   │ verification failed
                                             │                                   ▼
                                             │                               diverged ──debug_reset──► resetting
                                             │                                   │
                                             │                         debug_rebaseline ──► ready
ready ──debug_conclude──► concluding ──toggle proof ok──► closed (fix applied | report only)
                                │
                                └── proof failed ──► (reset) ready
```

`breaker-tripped` is a flag on `ready`, not a state: it narrows what `ready` allows.

## 3.4 Data model (`db.ts`)

`<stateDir>/<worktree-id>/debug.sqlite` (WAL, `busy_timeout = 2000`), plus `logs/` (repro output), `patches/`, `files/` (ignored-file copies), `reports/`, and `lock` (`{ pid, sessionID, investigationId, startedAt }`).

```sql
CREATE TABLE investigations (
  id            TEXT PRIMARY KEY,          -- <yyyymmdd>-<slug>
  worktree      TEXT NOT NULL,
  session_id    TEXT NOT NULL,             -- owner session; subagents inherit
  symptom       TEXT NOT NULL,
  repro_json    TEXT NOT NULL,             -- cmd, cwd, env, timeout, failSignature, locks + hashes
  guard_json    TEXT,
  fingerprint   TEXT NOT NULL,
  flaky         INTEGER NOT NULL DEFAULT 0,
  baseline_rate REAL,                      -- failure rate at baseline
  original_baseline TEXT NOT NULL,         -- snapshot id
  current_baseline  TEXT NOT NULL,         -- snapshot id (differs after rebaseline)
  guard_baseline_json TEXT,                -- per-test results at original baseline
  state         TEXT NOT NULL CHECK (state IN ('ready','experiment-open','resetting','diverged','concluding','closed')),
  breaker_count INTEGER NOT NULL DEFAULT 0,
  conclusion_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE hypotheses (
  investigation_id TEXT NOT NULL,
  id            TEXT NOT NULL,             -- h1, h2, ...
  statement     TEXT NOT NULL,
  mechanism     TEXT NOT NULL,
  prediction_json TEXT NOT NULL,
  falsifier     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open','supported','refuted','inconclusive')),
  notes_json    TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (investigation_id, id)
);

CREATE TABLE experiments (
  investigation_id TEXT NOT NULL,
  id            TEXT NOT NULL,             -- e1, e2, ...
  hypothesis_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('intervention','probe','toggle','bisect')),
  scope_json    TEXT NOT NULL,
  touches_json  TEXT NOT NULL DEFAULT '[]',
  base_snapshot TEXT NOT NULL,
  end_snapshot  TEXT,
  patch_path    TEXT,
  verdict       TEXT CHECK (verdict IN ('supported','refuted','inconclusive','aborted')),
  observation_run TEXT,                    -- runs.id
  interpretation TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  PRIMARY KEY (investigation_id, id)
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  purpose       TEXT NOT NULL,             -- baseline | observe | reset-verify | proof-N | guard | bisect
  tree_snapshot TEXT NOT NULL,             -- what was run against
  outcomes_json TEXT NOT NULL,             -- [{exit, classification, signatureLine, durationMs, logPath}]
  at            TEXT NOT NULL
);

CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- open | hypothesize | start | edit | bash | end | reset | verify | rebaseline | breaker | step-back | conclude | reject
  detail_json   TEXT NOT NULL,
  at            TEXT NOT NULL
);
```

## 3.5 Snapshots, reset and verification (`snapshot.ts`)

**Snapshot** (tracked + untracked-not-ignored files, without touching the index or work tree):

```bash
export GIT_INDEX_FILE="$STATE/tmp-index"
git read-tree HEAD && git add -A            # into the temp index only
tree=$(git write-tree)
git update-ref "refs/debug-harness/$INV/$NAME" "$(git commit-tree "$tree" -p HEAD -m "$INV $NAME")"
```

The private ref keeps the objects from GC; `debug_close` deletes the namespace after the report is written (patches are kept in the state dir).

**Ignored files** (`.env`, generated config, `node_modules` contents) aren't in the tree. Two mechanisms cover them:

1. **Copy-on-first-write journal.** In `tool.execute.before` for an edit tool, if the target is ignored by git and not yet journaled in this experiment, copy it (or record "absent") into `files/<exp>/`. Reset restores the copies.
2. **Declared paths.** `touches` may list ignored paths (`{ what: ".env", paths: [".env"] }`), which are copied at experiment start.

Ignored files changed by bash and not declared are not restored. The re-verification catches the effect if it matters to the repro; the report lists bash commands run during the experiment so the user can see what may have leaked.

**Reset** to snapshot `S`:

1. `git diff --name-only S` over the work tree (with untracked) → files that differ.
2. For each: restore content from `S` (`git restore --source=S --worktree -- <path>` *issued by the harness*, not the agent), or delete if absent in `S` and not ignored.
3. Restore journaled ignored files.
4. Run each `touches[].reset` command; non-zero exit → `diverged`.

**Verify** after reset:

1. Snapshot again → tree must equal `S`'s tree.
2. Run the repro (`baselineRuns` times, or `flakyRuns` when flaky) → must classify red with the baseline fingerprint.
3. Both pass → `ready`. Either fails → `diverged`, with the file list and run outcomes.

**Foreign changes.** Before resetting, the harness compares the current tree with the experiment's journal of edits. Files changed that the experiment didn't touch through edit tools or logged bash (e.g. the user editing in their IDE) are reported and the reset waits for `debug_reset({ confirm: true })`, so a reset never silently discards the user's own work.

**Patches.** `git diff --binary S_base end_snapshot` → `patches/<exp>.patch`, plus the journaled ignored-file contents. Reapply (toggle proof, `rebaseline from_experiment`) uses `git apply --3way` against the baseline *by the harness*.

## 3.6 Tool policy (`guard.ts`, `tool.execute.before`)

For a session with an open investigation (owner or its subagents):

| Call | `ready` | `experiment-open` | `diverged` / `resetting` / `concluding` |
|---|---|---|---|
| edit tool, path in scope, not locked | reject: start an experiment | allow (journal first) | reject |
| edit tool, path out of scope or locked | reject | reject, naming scope / lock | reject |
| bash matching `forbidden` | reject | reject | reject |
| bash matching `mutating` | reject: start an experiment | allow, log to `events` | reject |
| other bash, reads, searches | allow | allow | allow |
| `debug_*` tools | per state machine | per state machine | per state machine |

Rejections throw `Error` starting `[debug-harness] ` and state the next allowed step. Sessions without an investigation: no checks. Other sessions editing the same work tree while it is locked by an investigation: not blocked (can't be, across processes), but they get a one-time warning in the tool output that an investigation owns this tree, and the foreign-change check (§3.5) catches the result.

## 3.7 Runner (`runner.ts`)

- `Bun.spawn(["bash", "-lc", cmd], { cwd, env, stdout/stderr → file })` with timeout (kill the process group).
- Classification per FR-O4; fingerprint normalization per FR-O5 (`util/normalize.ts`, unit-tested against fixtures from bun, node, go, pytest, cargo).
- Guard parsing: `go test -json`, TAP, JUnit XML, `bun test`/`pytest` summary lines; otherwise exit code only, and "no worse" means "passed at baseline → passes now".
- Repro runs are serialized per work tree (the lock), never concurrent.

## 3.8 Hooks

Same 1.19.0 contract as the research harness (§3.4 there).

| Hook | Use |
|---|---|
| `tool` | `debug_open`, `debug_refine_repro`, `debug_hypothesize`, `debug_hypothesis_note`, `debug_experiment_start`, `debug_experiment_end`, `debug_experiment_abort`, `debug_run`, `debug_reset`, `debug_rebaseline`, `debug_bisect`, `debug_step_back`, `debug_conclude`, `debug_status`, `debug_close`. |
| `tool.execute.before` | Tool policy (§3.6); ignored-file journal. |
| `tool.execute.after` | Record edited paths per experiment; append the "another session owns this tree" warning; MCP-shaped outputs handled via `util/tool-output.ts`. |
| `event` | `session.created`: subagent inherits parent's investigation; supervisor side sessions marked ignored. `session.deleted`: nothing (the investigation outlives the session; the lock records the session for display only). |
| `command.execute.before` | `/debug <symptom>`: if no investigation, replace parts with an instruction to write a repro and call `debug_open`; if one exists, show status. |
| `experimental.chat.messages.transform` | Status header (FR-S1). |
| `experimental.session.compacting` | Investigation block (FR-S2). |
| `shell.env` | `DEBUG_HARNESS_INVESTIGATION`, `DEBUG_HARNESS_EXPERIMENT`. |
| `dispose` | Close DB, release load record. Lock is *not* released (crash-safety; FR NFR). |

**To verify during implementation:** that a throwing `tool.execute.before` on `bash` blocks the command on 1.19.0 (expected, as for edit tools); that edit-tool arg shapes with the global hashline plugin expose a path the policy can read.

## 3.9 Coexistence

- **Supervisor:** same rules as research harness §3.8: own double-load guard on `globalThis[Symbol.for("opencode-debug-harness.shared-state")]`, ignore supervisor side sessions (registry first, title prefix fallback), no side sessions or model calls.
- **Research harness:** independent. Both may be loaded in the research repo; the debug harness is inert there unless `debug_open` is called. Their `tool.execute.before` rejections compose (either can reject).
- **User's git workflow:** the harness owns only `refs/debug-harness/*` and its state dir.

## 3.10 Agent, skill, command, directive

- **`agents/debugger.md`** — primary agent, `mode: primary`, prompt: the loop, the tool order, "never claim an outcome you did not get from `debug_run` or `debug_experiment_end`", and "if you can't write a repro, say so and ask". Permissions: edit/bash allowed (the harness gates them).
- **`skills/debug-loop/SKILL.md`** — the method for any agent: writing a good repro (smallest command, exits non-zero, signature regex), good hypotheses (mechanism + falsifiable prediction), choosing experiment kind, what to do when the breaker trips, reading `log_ref` instead of re-running.
- **`commands/debug.md`** — `/debug <symptom>`; fallback text when the plugin isn't loaded.
- **`supervisor/debug-discipline.md`** — triggers on `debug_*` tools and edits during an investigation. Checks: hypotheses state a mechanism, not just "maybe X"; the interpretation matches the harness verdict; the agent didn't work around a rejection (e.g. writing files via `python -c` to dodge the edit gate); conclusions don't overclaim the evidence strength.

## 3.11 Tests (`bun test`)

- `runner.test.ts`: classification red/green/other; fingerprint normalization fixtures; timeout kills the process group; flaky detection.
- `snapshot.test.ts` (temp git repos): snapshot doesn't touch index or work tree; dirty baseline restored exactly; untracked files created in an experiment are deleted on reset; ignored-file journal round-trips; foreign change detected; tree-equality verification fails on a leftover file.
- `experiment.test.ts`: start rejected unless `ready`; scope and lock enforcement; verdict mapping per `expect`; reset → verify → `ready`; failed verify → `diverged`; abort; rebaseline.
- `guard.test.ts`: the §3.6 table, row by row; bash classifier fixtures (incl. false-positive cases).
- `gate.test.ts`: toggle proof each failing step; guard regression rejects `fixed`; `understood` evidence strengths; `abandoned` always allowed; fix left applied on success.
- `ratchet.test.ts`: breaker trips at threshold, step-back clears it, supported verdict resets the count.
- `crash.test.ts`: plugin reload with `experiment-open` → status offers abort/resume; abort restores.
- `double-load.test.ts`.
- **End-to-end fixture:** a small repo with a seeded bug (off-by-one plus a red-herring config value), driven through the tool API: open → refuted hypothesis on the red herring (reset verified) → supported intervention → conclude fixed with the toggle proof.

## 3.12 Rollout

1. Create private repo `jflowers/opencode-debug-harness`, push this spec.
2. Phase 1: investigation, runner, snapshot, experiment, guard, gate, status. No bisect, no export beyond the state-dir report.
3. Wire checks (§3.8). Load globally; dogfood on real bugs in `jflowers/*` repos.
4. Phase 2: breaker, bisect, flaky mode refinements, Dewey export, `reportDir`, supervisor directive.
5. Extract the shared core with the research harness (D7) once both have run for a few weeks.

## 3.13 Phase 1 as built (2026-11-23)

Phase 1 implements FR-O, FR-H, FR-X (except FR-X9 bisect), FR-C, FR-S, the FR-R2 report and FR-R3 `reportDir`. Where the build differs from the text above, this section wins:

| Topic | Spec text | As built | Why |
|---|---|---|---|
| Store (§3.4) | One SQLite file per work tree, column-per-field tables, `lock` file | **One** `debug.sqlite` under `stateDir`. Tables keep a JSON `data` column; a partial unique index (`worktree WHERE state != 'closed'`) is the one-investigation-per-work-tree lock. Artifacts stay per work tree: `<stateDir>/<sha1(realpath)[:16]>/<investigation>/{logs,patches,files,tmp,report.md}`. | One DB lets a hook find a session's investigation with one indexed lookup. A unique index is atomic across processes, which a lock file isn't. |
| Session binding | Implicit | `sessions(session_id → investigation_id)`. Subagents inherit on `session.created`; supervisor side sessions never bind. **`debug_attach`** (new tool) rebinds an open investigation to the current session. | Crash recovery and new sessions (NFR crash-safe). |
| Repro shell (FR-O2) | `bash -lc` | `bash -c`, process group killed on timeout | A login shell re-sources the profile on every run (slow, noisy output); opencode's environment already has `PATH`. |
| Reset verification (§3.5) | `baselineRuns` | New option **`verifyRuns`** (default 1), or `flakyRuns` when flaky | Determinism is already established by the N baseline runs; 3× on every reset makes each experiment cost 4 repro runs. |
| Snapshot index (§3.5) | Copy the real index into a temp index | Same, **and the copy keeps the real index's mtime** | Racy git: with a fresh mtime git trusts stale stat data, and a same-size edit made in the same second (`i = 1` → `i = 0`) is invisible to the snapshot. Found by the test suite; regression test in `test/unit.test.ts`. |
| Starting an experiment (FR-X2) | `ready` | `ready` **and** the tree equals the current baseline; otherwise → `diverged` naming the files | Catches changes made outside the harness (shell, IDE) before they contaminate an experiment. |
| Locked files (FR-O8) | Edits rejected | Also re-hashed at `debug_experiment_end`; a change (e.g. via shell) makes the verdict `inconclusive` | Shell commands can't be scoped by path. |
| Edits outside the work tree | Unspecified | Rejected during an investigation | The harness can't reset them. |
| Forbidden git (§3.2) | — | Adds `git add`, `rm`, `mv`, `update-index`, `gc`, `prune`, `worktree remove` | The real index must not change during an investigation. |
| Flaky red (FR-O6) | Rate-based | Any red in `flakyRuns` = red; all green = green; else other | Simple and conservative until real flaky cases show the need. |
| Guard (FR-O7) | Per-test parsing | Exit code only. "No worse" = passed at baseline → must pass. A guard that failed at baseline is reported as not comparable. | Per-test parsing is Phase 2. |
| Conclusion states (§3.3) | `concluding` state | No `concluding` state. `fixed` runs the proof inside one serialized call; a failed proof restores the current baseline, verifies it, and returns to `ready` (or `diverged`). | No intermediate state to recover from. |
| Hooks (§3.8) | `dispose` keeps the lock | Lock is the DB row, so nothing to release | — |

Deferred to Phase 2: circuit breaker (FR-B), `debug_bisect` (FR-X9), Dewey export (FR-R4), the supervisor directive, per-test guard parsing, and wire checks (§3.8) on a live opencode 1.19.0 session.

---

# Part 4 — Decisions

Accepted 2026-11-23 (Jay accepted the recommendations as written).

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Reset mechanism: in-place snapshot or worktree per experiment | **In place**, with git-object snapshots (§3.5). Worktree only for bisect. | Dev servers, watchers, IDE state, ignored files (`.env`, `node_modules`) and absolute-path tooling all live in the real tree. A worktree per experiment breaks the repro for exactly the bugs that depend on environment. Verification after reset gives the safety a worktree would. |
| D2 | Auto-reset at experiment end, or separate step | **Automatic** inside `debug_experiment_end`. | Reset is the step most likely to be skipped; making it part of recording the result removes the choice. `debug_rebaseline` covers the case where you want to keep something. |
| D3 | Bugs with no scriptable repro (UI-only, prod-only) | **Allow a manual repro** (`repro.manual: "<steps>"`): the harness asks the user to confirm red/green via the tool output and records `observed_by: user`. Evidence strength is capped at `predicted`; `fixed` becomes `fixed (manually confirmed)`. Snapshot/reset still apply. | Refusing pushes these bugs back to undisciplined debugging. Labeling keeps the weaker evidence visible. |
| D4 | Probes (logging, debugger): experiments or a lighter step | **Experiments of kind `probe`**, same reset. Keep-for-several via `debug_rebaseline`. | Instrumentation left behind is one of the failure modes this exists to prevent. Uniform rules are simpler to enforce and to explain. |
| D5 | Non-git directories | **Out of scope in v1.** `debug_open` rejects with a hint to `git init` a scratch repo. | Snapshots, patches and verification all lean on git objects. |
| D6 | Load globally or per project | **Globally, inert until `debug_open`.** | Bugs show up in any repo; per-project loading would mean editing every repo's `opencode.json`. Inert cost is one map lookup per call. |
| D7 | Shared core with the research harness | **Copy now, extract later** (`shared-state`, `tool-output`, status injection, Dewey frontmatter writer). | Neither plugin's API is stable yet; a premature shared package couples their release cycles. |
| D8 | Where investigation state lives | **`~/.local/share/opencode-debug-harness/<worktree-id>/`**. | Must survive resets and `git clean -fdx`; per-work-tree id keeps parallel `ghws` instances separate. |
| D9 | Leave the fix applied after `fixed`, or reset and hand back a patch | **Leave applied, uncommitted.** Patch also saved. | That's what the user wants to review and commit; the toggle proof already showed it's the right state. |
