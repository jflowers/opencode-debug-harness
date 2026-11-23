import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { git } from "../src/git"
import { BUGGY_TOTAL, FIXED_TOTAL, makeRepo, REPRO, type Repo } from "./fixture"

setDefaultTimeout(120_000)

const S = "ses_main"
let repo: Repo
afterEach(() => repo?.cleanup())

const read = (rel: string) => readFileSync(join(repo.dir, rel), "utf8")

async function rejects(p: Promise<unknown> | (() => unknown), re: RegExp) {
  try {
    await (typeof p === "function" ? p() : p)
  } catch (e) {
    expect((e as Error).message).toMatch(re)
    return
  }
  throw new Error(`expected rejection matching ${re}`)
}

test("end to end: red herring refuted, reset verified, fix proven by toggle", async () => {
  repo = makeRepo()
  const h = repo.h
  const opened = await h.open(S, { symptom: "total() drops the first item", repro: REPRO, guard: { cmd: "bun guard.ts" } })
  expect(opened).toContain("Baseline is RED on 2/2")
  expect(opened).toContain("`check.ts`") // auto-locked
  expect(opened).toContain("Guard at baseline: PASS")
  // timestamps in the error line are normalized away
  expect(h.active(S)!.fingerprint).toBe("exit=1 sig=AssertionError: total([1,2,3]) expected 6, got 5 at <ts>")

  // no edits outside an experiment
  expect(() => h.checkEdit(S, "write", { filePath: join(repo.dir, "src/total.ts") })).toThrow(/no experiment is open/)
  expect(() => h.checkBash(S, "sed -i '' s/1/0/ src/total.ts")).toThrow(/no experiment is open/)
  expect(() => h.checkBash(S, "git stash")).toThrow(/git history/)
  expect(h.checkBash(S, "cat src/total.ts && grep -n i src/total.ts")).toBeNull()

  // h1: the red herring
  await h.hypothesize(S, {
    statement: "Rounding config truncates the sum",
    mechanism: "ROUNDING=2 rounds intermediate sums",
    prediction: { intervention: "set ROUNDING to 0", expect: "green" },
    falsifier: "still red with ROUNDING 0",
  })
  await rejects(h.hypothesize(S, { statement: "rounding config truncates the sum!", mechanism: "x".repeat(10), prediction: { intervention: "y", expect: "green" }, falsifier: "z" }), /Same statement as h1/)
  await h.start(S, { hypothesis_id: "h1", kind: "intervention", scope: ["src/config.ts"] })
  await rejects(h.start(S, { hypothesis_id: "h1", kind: "intervention", scope: ["src/config.ts"] }), /still open/)
  repo.edit(S, "src/config.ts", "export const ROUNDING = 0\n")
  expect(() => h.checkEdit(S, "write", { filePath: join(repo.dir, "src/total.ts") })).toThrow(/outside e1's scope/)
  expect(() => h.checkEdit(S, "edit", { filePath: join(repo.dir, "check.ts") })).toThrow(/locked/)
  repo.write("out/scratch.txt", "ignored and undeclared\n")
  repo.write("notes.txt", "untracked, created by a shell command\n")
  h.checkBash(S, "echo hi > notes.txt")
  const e1 = await h.end(S, "rounding is not it")
  expect(e1).toContain("Verdict for h1: REFUTED")
  expect(e1).toContain("Reset verified")
  expect(read("src/config.ts")).toBe("export const ROUNDING = 2\n")
  expect(existsSync(join(repo.dir, "notes.txt"))).toBe(false)
  expect(h.active(S)!.state).toBe("ready")

  // h2: the real cause
  await h.hypothesize(S, {
    statement: "Loop starts at index 1 and skips the first item",
    mechanism: "for loop initializer is i = 1",
    prediction: { intervention: "start the loop at 0", expect: "green" },
    falsifier: "still red after starting at 0",
  })
  await h.start(S, { hypothesis_id: "h2", kind: "intervention", scope: ["src/**"] })
  repo.edit(S, "src/total.ts", FIXED_TOTAL)
  const run = await h.run(S, true)
  expect(run).toContain("Outcome: GREEN")
  expect(run).toContain("Guard: PASS")
  const e2 = await h.end(S, "starting at 0 fixes it")
  expect(e2).toContain("Verdict for h2: SUPPORTED")
  expect(read("src/total.ts")).toBe(BUGGY_TOTAL) // reset puts the bug back

  const done = await h.conclude(S, { kind: "fixed", summary: "Loop skipped index 0", root_cause: "off-by-one initializer", hypothesis_ids: ["h2"], fix_experiment: "e2" })
  expect(done).toContain("FIXED")
  expect(done).toContain("| 3 fix reverted | red | red | ✓ |")
  expect(read("src/total.ts")).toBe(FIXED_TOTAL) // left applied
  expect(git(repo.dir, ["status", "--porcelain"]).stdout).toContain("src/total.ts")
  expect(git(repo.dir, ["for-each-ref", "refs/debug-harness/"]).stdout.trim()).toBe("")
  expect(h.active(S)).toBeNull()
  const report = readFileSync(h.db.investigation(h.db.boundTo(S)!)!.conclusion!.reportPath!, "utf8")
  expect(report).toContain("## Toggle proof")
  expect(report).toContain("| h1 | Rounding config truncates the sum |")
})

test("can't open without a reproducible failure", async () => {
  repo = makeRepo()
  await rejects(repo.h.open(S, { symptom: "nothing is wrong", repro: { cmd: "true" } }), /Can't reproduce/)
  expect(repo.h.db.openFor(repo.dir)).toBeNull()
})

test("one investigation per work tree; another session attaches", async () => {
  repo = makeRepo()
  await repo.h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await rejects(repo.h.open("ses_other", { symptom: "again", repro: REPRO }), /already open/)
  expect(repo.h.status("ses_other")).toContain("not attached")
  expect(await repo.h.attach("ses_other")).toContain("Attached")
  expect(repo.h.active("ses_other")).not.toBeNull()
})

test("ignored files edited in an experiment are journaled and restored", async () => {
  repo = makeRepo()
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await h.hypothesize(S, { statement: "env mode matters here", mechanism: "MODE switches code path", prediction: { intervention: "MODE=dev", expect: "green" }, falsifier: "still red" })
  await h.start(S, { hypothesis_id: "h1", kind: "probe", scope: [".env"] })
  repo.edit(S, ".env", "MODE=dev\n")
  const out = await h.end(S, "env is irrelevant")
  expect(out).toContain("REFUTED")
  expect(read(".env")).toBe("MODE=prod\n")
})

test("a dirty baseline is preserved across experiments", async () => {
  repo = makeRepo()
  repo.write("src/config.ts", "export const ROUNDING = 3 // uncommitted\n")
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await h.hypothesize(S, { statement: "loop skips the first element", mechanism: "i starts at 1", prediction: { intervention: "i = 0", expect: "green" }, falsifier: "still red" })
  await h.start(S, { hypothesis_id: "h1", kind: "intervention", scope: ["src/"] })
  repo.edit(S, "src/total.ts", FIXED_TOTAL)
  repo.edit(S, "src/config.ts", "export const ROUNDING = 9\n")
  await h.end(S, "fixed")
  expect(read("src/config.ts")).toBe("export const ROUNDING = 3 // uncommitted\n")
  expect(read("src/total.ts")).toBe(BUGGY_TOTAL)
})

test("foreign changes withhold the reset until confirmed", async () => {
  repo = makeRepo()
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await h.hypothesize(S, { statement: "loop skips the first element", mechanism: "i starts at 1", prediction: { intervention: "i = 0", expect: "green" }, falsifier: "still red" })
  await h.start(S, { hypothesis_id: "h1", kind: "intervention", scope: ["src/total.ts"] })
  repo.edit(S, "src/total.ts", FIXED_TOTAL)
  repo.write("README.md", "the user's own work\n") // not through the harness
  const out = await h.end(S, "fixed")
  expect(out).toContain("RESET WITHHELD")
  expect(h.active(S)!.state).toBe("diverged")
  expect(existsSync(join(repo.dir, "README.md"))).toBe(true)
  expect(() => h.checkEdit(S, "write", { filePath: join(repo.dir, "src/total.ts") })).toThrow(/state diverged/)
  await rejects(h.reset(S, false), /confirm: true/)
  expect(await h.reset(S, true)).toContain("Reset verified")
  expect(existsSync(join(repo.dir, "README.md"))).toBe(false)
})

test("changes outside an experiment are caught before the next one", async () => {
  repo = makeRepo()
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await h.hypothesize(S, { statement: "loop skips the first element", mechanism: "i starts at 1", prediction: { intervention: "i = 0", expect: "green" }, falsifier: "still red" })
  repo.write("src/total.ts", FIXED_TOTAL) // bypassed the gate
  await rejects(h.start(S, { hypothesis_id: "h1", kind: "intervention", scope: ["src/**"] }), /changed outside an experiment: M src\/total.ts/)
  expect(h.active(S)!.state).toBe("diverged")
  // the tree is green now, so it can't become the baseline
  await rejects(h.rebaseline(S, "accept"), /isn't RED/)
  expect(await h.reset(S, false)).toContain("Reset verified")
})

test("a failing declared reset leaves the investigation diverged", async () => {
  repo = makeRepo()
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await h.hypothesize(S, { statement: "database state matters", mechanism: "stale rows", prediction: { intervention: "truncate", expect: "green" }, falsifier: "still red" })
  await h.start(S, { hypothesis_id: "h1", kind: "probe", scope: ["src/**"], touches: [{ what: "local db", reset: "exit 3" }] })
  const out = await h.end(S, "nothing")
  expect(out).toContain("RESET FAILED")
  expect(out).toContain('reset for "local db" failed (exit 3)')
  await rejects(h.start(S, { hypothesis_id: "h1", kind: "probe", scope: ["src/**"] }), /state diverged/)
  expect(await h.close(S, "giving up", true)).toContain("ABANDONED")
})

test("fixed is rejected when the guard regresses, and the tree goes back to the baseline", async () => {
  repo = makeRepo()
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO, guard: { cmd: "bun guard.ts" } })
  await h.hypothesize(S, { statement: "loop skips the first element", mechanism: "i starts at 1", prediction: { intervention: "i = 0", expect: "green" }, falsifier: "still red" })
  await h.start(S, { hypothesis_id: "h1", kind: "intervention", scope: ["src/**"] })
  repo.edit(S, "src/total.ts", FIXED_TOTAL.replace("let sum = 0", "if (items.length === 0) return 1\n  let sum = 0"))
  await h.end(S, "green")
  await rejects(h.conclude(S, { kind: "fixed", summary: "fixed the loop", fix_experiment: "e1" }), /Toggle proof failed[\s\S]*FAIL \(passed at baseline\)/)
  expect(read("src/total.ts")).toBe(BUGGY_TOTAL)
  expect(h.active(S)!.state).toBe("ready")
})

test("understood records toggle evidence; conclusions need support", async () => {
  repo = makeRepo()
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await h.hypothesize(S, { statement: "loop skips the first element", mechanism: "i starts at 1", prediction: { intervention: "remove the off-by-one", expect: "green" }, falsifier: "still red" })
  await rejects(h.conclude(S, { kind: "understood", summary: "it's the loop", hypothesis_ids: ["h1"] }), /needs at least one supported/)
  await h.start(S, { hypothesis_id: "h1", kind: "toggle", scope: ["src/total.ts"] })
  repo.edit(S, "src/total.ts", FIXED_TOTAL)
  await h.end(S, "cause removed, green")
  const out = await h.conclude(S, { kind: "understood", summary: "the loop skips index 0", hypothesis_ids: ["h1"] })
  expect(out).toContain("Evidence: toggled")
  expect(read("src/total.ts")).toBe(BUGGY_TOTAL)
})

test("outputMatches predictions and rebaselining a probe", async () => {
  repo = makeRepo()
  const h = repo.h
  await h.open(S, { symptom: "total() drops the first item", repro: REPRO })
  await h.hypothesize(S, { statement: "first item is never read", mechanism: "loop index", prediction: { intervention: "log each index", expect: { outputMatches: "^idx 1$" } }, falsifier: "idx 0 appears" })
  await h.start(S, { hypothesis_id: "h1", kind: "probe", scope: ["src/total.ts"] })
  repo.edit(S, "src/total.ts", BUGGY_TOTAL.replace("sum += items[i]!", "{ console.log(`idx ${i}`); sum += items[i]! }"))
  expect(await h.end(S, "index 0 never logged")).toContain("SUPPORTED")
  expect(await h.rebaseline(S, "keep the index logging", "e1")).toContain("Rebaselined (1)")
  expect(read("src/total.ts")).toContain("console.log")
  expect(h.active(S)!.state).toBe("ready")
})
