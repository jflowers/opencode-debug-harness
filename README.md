# opencode-debug-harness

An opencode plugin that makes an agent debug like a careful engineer. It reproduces the failure first, changes one thing per experiment, lets the harness (not the model) observe the result, puts the tree back between experiments and checks that it did, and accepts a fix only when toggling it toggles the failure.

```
debug_open (lock a repro) → hypothesize → experiment → observe → verified reset → repeat
                                                              └→ conclude: fixed (toggle proof) | understood | abandoned
```

See [SPEC.md](SPEC.md) for the design, and §3.13 there for how Phase 1 differs from it.

## Install (global, inert until `debug_open`)

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/Users/jflowers/Projects/github/jflowers/opencode-debug-harness/src/index.ts"
    // or with options: ["/…/src/index.ts", { "reportDir": "docs/debugging" }]
  ]
}
```

Link the agent, skill and command:

```bash
ln -s "$PWD/agents/debugger.md" ~/.config/opencode/agents/debugger.md
ln -s "$PWD/skills/debug-loop" ~/.config/opencode/skills/debug-loop
ln -s "$PWD/commands/debug.md" ~/.config/opencode/commands/debug.md
```

Then, in any git repo, run `/debug <symptom>` or switch to the `debugger` agent.

**Load it once.** A second copy for the same directory disables itself and logs a warning.

## Tools

| Tool | What it does |
|---|---|
| `debug_open` | Locks a repro, runs it N times on the untouched tree, records the failure fingerprint, locks the test files. Edits are blocked from here on. |
| `debug_attach` | Takes over the investigation already open in this work tree (new session, crash). |
| `debug_refine_repro` | Replaces the repro and re-derives the baseline. |
| `debug_hypothesize` / `debug_hypothesis_note` | Records a hypothesis with a mechanism and a checkable prediction. |
| `debug_experiment_start` | Opens one experiment with an edit scope and any non-git state it touches. |
| `debug_run` | Runs the repro (and optionally the guard) as an independent observation. |
| `debug_experiment_end` | Records the verdict, saves the patch, resets to the baseline and verifies the repro is red again. |
| `debug_experiment_abort` / `debug_reset` | Abandons an experiment, or retries a reset. |
| `debug_rebaseline` | Keeps an experiment's change (e.g. logging) as the new baseline. |
| `debug_conclude` | `fixed` runs the toggle proof and leaves the fix applied. `understood` needs a supported hypothesis. `abandoned` is always allowed. |
| `debug_status` / `debug_close` | Show the state, or bail out (restores the tree by default). |

## Where things live

- **State:** `~/.local/share/opencode-debug-harness/`. That holds `debug.sqlite` and, per work tree, logs, patches, copies of edited ignored files, and `report.md`. It lives outside the repo so a reset can't erase it.
- **Snapshots:** git commits under `refs/debug-harness/<investigation>/`, never on a branch. They're deleted when the investigation closes; the patches are kept.
- The harness never commits, never moves `HEAD` and never touches the real index.

## Development

```bash
bun install
bun test
bun run typecheck
```
