import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** SPEC §3.2. */
export interface DebugConfig {
  /** Root for the DB and per-work-tree artifacts. Must live outside any tree the harness resets. */
  stateDir: string
  /** Repro runs at `debug_open` / `debug_refine_repro` / rebaseline. */
  baselineRuns: number
  /** Repro runs when verifying a reset on a non-flaky investigation. */
  verifyRuns: number
  /** Repro runs per observation once an investigation is flaky. */
  flakyRuns: number
  /** Consecutive greens a flaky investigation needs to conclude `fixed`. */
  flakyFixRuns: number
  reproTimeoutSec: number
  guardTimeoutSec: number
  /** Lines of repro output shown to the model (the rest stays in the log file). */
  tailLines: number
  editTools: string[]
  bash: {
    /** Commands that change files or environment: rejected outside an experiment, logged inside one. */
    mutating: string
    /** Commands rejected during any investigation (history, index and ref changes). */
    forbidden: string
  }
  /** Repo-relative directory the conclusion report is also written to, or null. */
  reportDir: string | null
  ignoreSessionTitlePrefixes: string[]
}

export const DEFAULTS: DebugConfig = {
  stateDir: "~/.local/share/opencode-debug-harness",
  baselineRuns: 3,
  verifyRuns: 1,
  flakyRuns: 5,
  flakyFixRuns: 10,
  reproTimeoutSec: 300,
  guardTimeoutSec: 1200,
  tailLines: 20,
  editTools: ["write", "edit", "patch", "apply_patch", "multiedit"],
  bash: {
    mutating:
      "\\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd|patch|sed\\s+(-[a-zA-Z]*i|--in-place)|perl\\s+-[a-zA-Z]*i|npm\\s+(i|install|ci|uninstall|update)|pnpm\\s+(i|install|add|remove|update)|yarn\\s+(add|remove|install)|bun\\s+(add|remove|install|i|update)|pip3?\\s+(install|uninstall)|uv\\s+(add|remove|sync|pip)|go\\s+(get|mod\\s+tidy)|cargo\\s+(add|remove|update)|make|docker|kubectl|psql|mysql|redis-cli)\\b|(^|[^0-9&>])>{1,2}\\s*[^&\\s]",
    forbidden:
      "\\bgit\\s+(commit|reset|checkout|switch|restore|stash|rebase|merge|cherry-pick|revert|clean|am|apply|pull|push|add|rm|mv|update-ref|update-index|tag|branch\\s+-[dDmMf]|worktree\\s+remove|gc|prune)\\b",
  },
  reportDir: null,
  ignoreSessionTitlePrefixes: ["supervisor-audit @", "supervisor-repair @"],
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p
}

function merge(base: DebugConfig, over: Partial<DebugConfig> | undefined): DebugConfig {
  if (!over || typeof over !== "object") return base
  return { ...base, ...over, bash: { ...base.bash, ...(over.bash ?? {}) } }
}

/** Plugin options over `<worktree>/.opencode/debug-harness.json` over defaults. */
export function loadConfig(worktree: string, options?: unknown): DebugConfig {
  let fileCfg: Partial<DebugConfig> | undefined
  const file = join(worktree, ".opencode/debug-harness.json")
  if (existsSync(file)) {
    try {
      fileCfg = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      fileCfg = undefined
    }
  }
  const cfg = merge(merge(DEFAULTS, fileCfg), options as Partial<DebugConfig> | undefined)
  return { ...cfg, stateDir: expandHome(cfg.stateDir) }
}
