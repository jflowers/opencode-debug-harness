---
name: debug-loop
description: Scientific debugging with the opencode-debug-harness tools. Reproduce first, change one thing per experiment, let the harness observe and reset, and conclude "fixed" only with a toggle proof. Load this skill whenever you are asked to debug, troubleshoot or find the cause of a failure.
---

# Debug loop

```
debug_open (lock a repro) → debug_hypothesize → debug_experiment_start → edit → debug_experiment_end (verdict + verified reset) → repeat
                                                                                                └→ debug_conclude: fixed | understood | abandoned
```

The harness enforces the loop. Edits outside an open experiment are rejected, shell commands that change files are rejected outside one, and git commands that touch history, the index or refs are rejected for the whole investigation. Don't look for ways around a rejection (for example writing files with `python -c` or `node -e`). Each rejection names the step that's allowed next.

## 1. Write a repro before touching code

A repro is the **smallest shell command that exits non-zero because of this bug**.

- Prefer one test file, or one test (`bun test path -t "name"`, `pytest path::test`, `go test ./pkg -run TestX`) over the whole suite.
- If no test reproduces it, write a tiny script that does, and **commit it, or leave it uncommitted before `debug_open`**. Either way it becomes part of the baseline, and it's locked if you name it in the command.
- Set `failSignature` to a regex for the line that identifies *this* failure (the error message, not a stack frame). Without it the harness uses the first error-looking line.
- Pass `guard` with the broader test command, so `fixed` can check nothing else broke.
- Send build and test output to gitignored paths. If running the repro changes tracked files, every reset will look like it diverged.

If `debug_open` says it can't reproduce, the repro is wrong. Fix the repro, never the code.

## 2. Hypotheses that can be wrong

`debug_hypothesize` needs:

- `statement`: what is causing the failure.
- `mechanism`: how that cause produces *this* failure.
- `prediction`: one intervention, and what the repro will show after it: `green`, `red`, `other`, `{ outputMatches }` or `{ outputLacks }`.
- `falsifier`: which observation would prove it wrong.

"Maybe it's a race" is not a hypothesis. "Two requests share the `cache` map, so the second read sees a half-written entry. Serializing access will turn it green" is one.

The harness sets the status (supported, refuted or inconclusive) from what it observed. Your reading of the result goes in `interpretation` or `debug_hypothesis_note`.

## 3. Experiments: one variable, then reset

- Choose the `kind`:
  - `intervention`: a candidate fix, predicted to turn the repro green.
  - `probe`: logging or assertions, with a prediction about the output (`outputMatches`).
  - `toggle`: remove the suspected cause and expect green. The reset afterwards puts the cause back and confirms the failure returns, which is the strongest evidence for `understood`.
- Keep `scope` as narrow as the change. To touch a file outside the scope, end the experiment and start a new one.
- Declare state outside git under `touches`, each with a reset command, for example `{ what: "local db", reset: "make db-reset" }`, or `{ what: ".env", paths: [".env"] }` for gitignored files.
- `debug_run` lets you look before ending. `debug_experiment_end` does the rest:
  1. Runs the repro.
  2. Records the verdict.
  3. Saves the patch.
  4. Restores the baseline.
  5. Checks that the tree matches the baseline and the repro fails the same way again.
- If the reset can't be verified, the investigation is **diverged**. Read the reason it gives, then retry with `debug_reset`, keep the current tree with `debug_rebaseline`, or `debug_close`.
- To keep instrumentation across experiments, use `debug_rebaseline({ from_experiment })`.

## 4. Reading results

- Each result shows the outcome, the fingerprint, the last lines of output and a `log_ref` path. Read the `log_ref` file when you need more. Don't re-run the repro just to see more output.
- `other` means it failed differently. That's information, not success: often the change moved the failure somewhere else.
- After 3 refuted or inconclusive results in a row, stop guessing:
  - re-read the baseline log,
  - narrow the repro with `debug_refine_repro`,
  - add a `probe`,
  - or bisect, if a known-good commit exists.

## 5. Concluding

- **`fixed`**: pass `fix_experiment` (a supported intervention that predicted `green`). The harness proves it: original baseline red → fix green, guard no worse → reverted red → reapplied green. On success it leaves the fix applied and uncommitted. Then tell the user what changed and suggest a commit. The harness never commits.
- **`understood`**: pass the supported hypothesis ids. The report shows how strong the evidence is: `toggled` beats `predicted`, which beats `intervention`.
- **`abandoned`**: always allowed. Say what was ruled out. An honest "not found" beats an unproven fix.

Never tell the user something is fixed or passing unless that came from `debug_run`, `debug_experiment_end` or `debug_conclude` output.
