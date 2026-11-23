---
description: Start (or continue) a harness-enforced debugging investigation for a symptom.
agent: debugger
---

# Command: /debug

Symptom: `$ARGUMENTS`

The `opencode-debug-harness` plugin handles `/debug` itself and replaces this text, so you normally never see it.

<protect>
If you are reading this, the debug harness plugin is not loaded: there are no `debug_*` tools and nothing enforces the loop. Tell the user, and suggest adding the plugin to `~/.config/opencode/opencode.jsonc` (see the opencode-debug-harness README). Do not imitate the harness.
</protect>
