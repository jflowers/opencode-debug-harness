import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULTS, type DebugConfig } from "../src/config"
import { DebugDb } from "../src/db"
import { silentLogger } from "../src/errors"
import { gitOk } from "../src/git"
import { DebugHarness } from "../src/harness"

export const BUGGY_TOTAL = `export function total(items: number[]): number {
  let sum = 0
  for (let i = 1; i < items.length; i++) sum += items[i]!
  return sum
}
`
export const FIXED_TOTAL = BUGGY_TOTAL.replace("let i = 1", "let i = 0")

export const CHECK = `import { total } from "./src/total"
const got = total([1, 2, 3])
if (got !== 6) {
  console.error(\`AssertionError: total([1,2,3]) expected 6, got \${got} at \${new Date().toISOString()}\`)
  process.exit(1)
}
console.log("ok")
`

export const GUARD = `import { total } from "./src/total"
if (total([]) !== 0) { console.error("guard: total([]) should be 0"); process.exit(1) }
console.log("guard ok")
`

export interface Repo {
  dir: string
  state: string
  h: DebugHarness
  write(rel: string, content: string): void
  edit(session: string, rel: string, content: string): void
  cleanup(): void
}

/** A temp git repo with an off-by-one bug in src/total.ts and a red herring in src/config.ts. */
export function makeRepo(overrides: Partial<DebugConfig> = {}): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "debug-harness-repo-")))
  const state = mkdtempSync(join(tmpdir(), "debug-harness-state-"))
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  write("src/total.ts", BUGGY_TOTAL)
  write("src/config.ts", "export const ROUNDING = 2\n")
  write("check.ts", CHECK)
  write("guard.ts", GUARD)
  write(".gitignore", ".env\nout/\n")
  write(".env", "MODE=prod\n")
  gitOk(dir, ["init", "-q", "-b", "main"])
  gitOk(dir, ["add", "-A"])
  gitOk(dir, ["commit", "-q", "-m", "init"])
  const config: DebugConfig = { ...DEFAULTS, stateDir: state, baselineRuns: 2, ...overrides }
  const h = new DebugHarness(dir, dir, config, silentLogger, new DebugDb(join(state, "debug.sqlite")))
  return {
    dir,
    state,
    h,
    write,
    edit(session, rel, content) {
      h.checkEdit(session, "write", { filePath: join(dir, rel), content })
      write(rel, content)
    },
    cleanup() {
      h.db.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    },
  }
}

export const REPRO = { cmd: "bun check.ts", failSignature: "AssertionError" }
