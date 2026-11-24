import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULTS } from "../src/config"
import { editTargets, inScope, toRepoRelative } from "../src/edit-paths"
import { aggregate, classify, normalizeLine } from "../src/fingerprint"
import { gitOk, restoreWorktree, worktreeTree } from "../src/git"
import plugin from "../src/index"
import { verdictFor } from "../src/harness"
import { harnessSharedState } from "../src/shared-state"
import { makeRepo, REPRO, type Repo } from "./fixture"

setDefaultTimeout(120_000)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  harnessSharedState().loadsByDirectory.clear()
})

test("normalizeLine strips run-to-run noise", () => {
  const a = normalizeLine("Error at 2026-11-23T10:00:01.123Z pid=4411 in /tmp/abc123/x.ts:42:7 after 35ms (0x7ffeefbff5c8)")
  const b = normalizeLine("Error at 2026-11-24T11:22:33.999Z pid=9 in /tmp/zzz/x.ts:43:1 after 1.2s (0x10)")
  expect(a).toBe(b)
})

test("classify: red / green / other", () => {
  const red = classify({ exit: 1, timedOut: false, output: "FAIL\nAssertionError: boom" }, "AssertionError", null)
  expect(red.classification).toBe("red")
  expect(classify({ exit: 1, timedOut: false, output: "AssertionError: boom" }, "AssertionError", red.fingerprint).classification).toBe("red")
  expect(classify({ exit: 1, timedOut: false, output: "TypeError: other" }, "AssertionError", red.fingerprint).classification).toBe("other")
  expect(classify({ exit: 0, timedOut: false, output: "ok" }, "AssertionError", red.fingerprint).classification).toBe("green")
  expect(classify({ exit: 0, timedOut: false, output: "AssertionError: still printed" }, "AssertionError", red.fingerprint).classification).toBe("other")
  expect(classify({ exit: null, timedOut: true, output: "" }, null, red.fingerprint).classification).toBe("other")
})

test("aggregate: deterministic needs agreement, flaky needs one red", () => {
  expect(aggregate(["red", "red"], false)).toBe("red")
  expect(aggregate(["red", "green"], false)).toBe("other")
  expect(aggregate(["red", "green", "green"], true)).toBe("red")
  expect(aggregate(["green", "green"], true)).toBe("green")
  expect(aggregate(["other", "green"], true)).toBe("other")
})

test("verdictFor", () => {
  expect(verdictFor("green", "green", [])).toBe("supported")
  expect(verdictFor("green", "red", [])).toBe("refuted")
  expect(verdictFor("green", "other", [])).toBe("inconclusive")
  expect(verdictFor({ outputMatches: "^idx 1$" }, "red", ["idx 1\nidx 2"])).toBe("supported")
  expect(verdictFor({ outputLacks: "null" }, "red", ["value null"])).toBe("refuted")
})

test("editTargets reads write/edit args and patch bodies", () => {
  expect(editTargets({ filePath: "/r/a.ts", content: "x" })).toEqual(["/r/a.ts"])
  expect(editTargets({ patchText: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch" })).toEqual(["src/a.ts", "src/b.ts"])
  expect(editTargets({ patch: "--- a/x.ts\n+++ b/x.ts\n@@" })).toEqual(["x.ts"])
  expect(editTargets({ edits: [{ filePath: "a" }, { filePath: "b" }] })).toEqual(["a", "b"])
  expect(editTargets({ something: 1 })).toBeNull()
})

test("toRepoRelative and inScope", () => {
  expect(toRepoRelative("/r", "/r/sub", "x.ts")).toBe("sub/x.ts")
  expect(toRepoRelative("/r", "/r", "/elsewhere/x.ts")).toBeNull()
  expect(toRepoRelative("/r", "/r", "/r")).toBeNull()
  expect(inScope("src/a/b.ts", ["src/**"])).toBe(true)
  expect(inScope("src/a/b.ts", ["src/"])).toBe(true)
  expect(inScope("src/a/b.ts", ["src"])).toBe(true)
  expect(inScope("srcx/b.ts", ["src"])).toBe(false)
  expect(inScope("lib/b.ts", ["src/**", "*.json"])).toBe(false)
  expect(inScope("package.json", ["*.json"])).toBe(true)
})

test("bash rules: mutating vs read-only vs forbidden", () => {
  const mut = new RegExp(DEFAULTS.bash.mutating, "m")
  const forb = new RegExp(DEFAULTS.bash.forbidden)
  for (const c of ["rm -rf out", "echo x > a.txt", "echo x >> log", "sed -i '' s/a/b/ f", "bun add zod", "npm install", "make db-reset"]) expect(mut.test(c)).toBe(true)
  for (const c of ["cat a.ts", "grep -rn foo src", "bun test 2>&1 | tail", "ls -la", "git log --oneline", "git diff", "echo hi 2>&1"]) expect(mut.test(c)).toBe(false)
  for (const c of ["git commit -m x", "git stash", "git checkout -- .", "git reset --hard", "git add -A"]) expect(forb.test(c)).toBe(true)
  for (const c of ["git status", "git log", "git diff HEAD", "git show HEAD:x"]) expect(forb.test(c)).toBe(false)
})

test("snapshots see a same-size edit made in the same second (racy git)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "debug-harness-racy-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "a.txt"), "i = 1\n")
  gitOk(dir, ["init", "-q"])
  gitOk(dir, ["add", "-A"])
  gitOk(dir, ["commit", "-q", "-m", "x"])
  const tmp = join(dir, ".git/dh-tmp")
  const base = worktreeTree(dir, tmp)
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, "a.txt"), "i = 0\n")
    expect(worktreeTree(dir, tmp)).not.toBe(base)
    restoreWorktree(dir, tmp, base)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("i = 1\n")
    expect(worktreeTree(dir, tmp)).toBe(base)
  }
})

test("snapshots never touch the real index", () => {
  const repo: Repo = makeRepo()
  cleanups.push(() => repo.cleanup())
  repo.write("src/new.ts", "export {}\n")
  const before = gitOk(repo.dir, ["status", "--porcelain"])
  worktreeTree(repo.dir, join(repo.state, "tmp"))
  expect(gitOk(repo.dir, ["status", "--porcelain"])).toBe(before)
  expect(before).toContain("?? src/new.ts")
})

// ---------- plugin wiring ----------

const input = (directory: string) => ({ directory, worktree: directory, client: undefined }) as never

test("plugin: inert for sessions without an investigation; edit gate via tool.execute.before", async () => {
  const repo = makeRepo()
  cleanups.push(() => repo.cleanup())
  const hooks = await plugin.server(input(repo.dir), { stateDir: repo.state, baselineRuns: 1 })
  cleanups.push(() => void hooks.dispose?.())
  expect(Object.keys(hooks.tool ?? {})).toContain("debug_open")

  const before = (tool: string, args: Record<string, unknown>, sessionID = "s1") =>
    hooks["tool.execute.before"]!({ tool, sessionID, callID: `c-${Math.random()}` }, { args })
  await before("write", { filePath: join(repo.dir, "src/total.ts"), content: "x" }) // no investigation: allowed

  const ctx = { sessionID: "s1", messageID: "m", agent: "build", directory: repo.dir, worktree: repo.dir, abort: new AbortController().signal, metadata() {}, ask: async () => {} } as never
  const opened = await hooks.tool!.debug_open!.execute({ symptom: "total() drops the first item", repro: REPRO } as never, ctx)
  expect(opened).toContain("Opened")
  await expect(before("write", { filePath: join(repo.dir, "src/total.ts"), content: "x" })).rejects.toThrow(/Edits are blocked/)
  await expect(before("bash", { command: "git reset --hard" })).rejects.toThrow(/git history/)
  await before("bash", { command: "cat src/total.ts" })
  await before("write", { filePath: join(repo.dir, "src/total.ts"), content: "x" }, "s-unrelated")

  // header goes to the bound session only
  const msgs = (sid: string) => ({ messages: [{ info: { sessionID: sid }, parts: [] }] }) as never
  const out1 = msgs("s1")
  await hooks["experimental.chat.messages.transform"]!({} as never, out1)
  expect(JSON.stringify(out1)).toContain("[debug-harness] Investigation")
  const out2 = msgs("s-unrelated")
  await hooks["experimental.chat.messages.transform"]!({} as never, out2)
  expect((out2 as { messages: unknown[] }).messages).toHaveLength(1)

  // subagents inherit, supervisor side sessions don't
  await hooks.event!({ event: { type: "session.created", properties: { info: { id: "child", parentID: "s1", title: "sub" } } } } as never)
  await hooks.event!({ event: { type: "session.created", properties: { info: { id: "audit", parentID: "s1", title: "supervisor-audit @ x" } } } } as never)
  await expect(before("write", { filePath: join(repo.dir, "src/total.ts"), content: "x" }, "child")).rejects.toThrow(/Edits are blocked/)
  await before("write", { filePath: join(repo.dir, "src/total.ts"), content: "x" }, "audit")
})

test("plugin: a second copy for the same directory returns no hooks", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "debug-harness-plugin-")))
  const state = mkdtempSync(join(tmpdir(), "debug-harness-plugin-state-"))
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  const first = await plugin.server(input(dir), { stateDir: state })
  harnessSharedState().loadsByDirectory.get(dir)!.add("file:///other/copy/index.ts")
  harnessSharedState().loadsByDirectory.get(dir)!.delete(import.meta.resolve("../src/index.ts"))
  expect(await plugin.server(input(dir), { stateDir: state })).toEqual({})
  await first.dispose?.()
})

test("debug_open refuses a directory that isn't a git work tree", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "debug-harness-nogit-")))
  const state = mkdtempSync(join(tmpdir(), "debug-harness-nogit-state-"))
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })
  const hooks = await plugin.server(input(dir), { stateDir: state })
  cleanups.push(() => void hooks.dispose?.())
  const ctx = { sessionID: "s1", directory: dir, worktree: dir } as never
  expect(await hooks.tool!.debug_open!.execute({ symptom: "something broke", repro: { cmd: "false" } } as never, ctx)).toContain("needs a git work tree")
})

test("tool args: JSON-encoded objects are decoded, real schema errors are reported", async () => {
  const repo = makeRepo()
  cleanups.push(() => repo.cleanup())
  const hooks = await plugin.server(input(repo.dir), { stateDir: repo.state, baselineRuns: 1 })
  cleanups.push(() => void hooks.dispose?.())
  const ctx = { sessionID: "s1", directory: repo.dir, worktree: repo.dir } as never
  const call = (name: string, args: unknown) => hooks.tool![name]!.execute(args as never, ctx) as Promise<string>

  // repro as a string (seen from GLM 5.3 in a live run)
  expect(await call("debug_open", { symptom: "total() drops the first item", repro: JSON.stringify(REPRO) })).toContain("Opened")
  const base = { statement: "loop starts at index 1", mechanism: "the first item is never added", falsifier: "starting at 0 stays red" }
  // prediction as a string, containing a regex escape
  const p1 = JSON.stringify({ intervention: "start the loop at 0 instead of /\\d+/ 1", expect: "green" })
  expect(await call("debug_hypothesize", { ...base, prediction: p1 })).toContain("Recorded h1")
  // nested expect as a string inside a string
  const p2 = JSON.stringify({ intervention: "log the index", expect: JSON.stringify({ outputMatches: "idx 0" }) })
  expect(await call("debug_hypothesize", { ...base, statement: "first index is skipped", prediction: p2 })).toContain("Recorded h2")
  // genuinely wrong
  const bad = await call("debug_hypothesize", { ...base, statement: "something else entirely", prediction: { intervention: "x = 1", expect: "maybe" } })
  expect(bad).toContain("Invalid arguments")
  expect(bad).toContain("prediction.expect")
  expect(await call("debug_experiment_start", { hypothesis_id: "h1", kind: "intervention", scope: '["src/total.ts"]' })).toContain("Experiment e1 open")
})
