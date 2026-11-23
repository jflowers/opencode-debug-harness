import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DebugConfig } from "./config"
import {
  type Conclusion,
  DebugDb,
  type Experiment,
  type Expect,
  type GuardResult,
  type Hypothesis,
  type Investigation,
  type JournalEntry,
  type ProofStep,
  type RunRecord,
  type Touch,
  now,
} from "./db"
import { editTargets, inScope, toRepoRelative } from "./edit-paths"
import { type Logger, Rejection } from "./errors"
import type { Classification } from "./fingerprint"
import {
  applyPatch,
  deleteRefs,
  diffPatch,
  diffTrees,
  isIgnored,
  restoreWorktree,
  type Snapshot,
  snapshot,
  worktreeRoot,
  worktreeTree,
} from "./git"
import { renderReport } from "./report"
import {
  execLogged,
  filesInCommand,
  type GuardSpec,
  type ReproBatch,
  type ReproSpec,
  readLog,
  resolveCwd,
  runRepro,
  tail,
} from "./runner"

export interface OpenArgs {
  symptom: string
  repro: ReproSpec
  guard?: GuardSpec
}

export interface HypothesizeArgs {
  statement: string
  mechanism: string
  prediction: { intervention: string; expect: Expect }
  falsifier: string
}

export interface StartArgs {
  hypothesis_id: string
  kind: Experiment["kind"]
  scope: string[]
  touches?: Touch[]
}

export interface ConcludeArgs {
  kind: Conclusion["kind"]
  summary: string
  root_cause?: string
  hypothesis_ids?: string[]
  fix_experiment?: string
}

const NEXT: Record<Investigation["state"], string> = {
  ready: "Next: debug_hypothesize, then debug_experiment_start. Or debug_conclude.",
  "experiment-open": "Next: edit inside the experiment scope, observe with debug_run, then debug_experiment_end (which resets).",
  diverged: "Next: debug_reset (retry the reset), debug_rebaseline (accept the current tree as the baseline), or debug_close.",
  closed: "Investigation closed.",
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "bug"
  )
}

function sha(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return null
  }
}

function upper(c: string): string {
  return c.toUpperCase()
}

export function verdictFor(expect: Expect, outcome: Classification, outputs: string[]): "supported" | "refuted" | "inconclusive" {
  if (typeof expect === "string") {
    if (outcome === expect) return "supported"
    return outcome === "other" ? "inconclusive" : "refuted"
  }
  if ("outputMatches" in expect) {
    const re = new RegExp(expect.outputMatches, "m")
    return outputs.some((o) => re.test(o)) ? "supported" : "refuted"
  }
  const re = new RegExp(expect.outputLacks, "m")
  return outputs.some((o) => re.test(o)) ? "refuted" : "supported"
}

function describeExpect(e: Expect): string {
  if (typeof e === "string") return e
  return "outputMatches" in e ? `output matches /${e.outputMatches}/` : `output lacks /${e.outputLacks}/`
}

/** Everything for one work tree (the plugin instance's). */
export class DebugHarness {
  readonly worktree: string
  readonly root: string
  private chain: Promise<unknown> = Promise.resolve()
  private warnedSessions = new Set<string>()

  constructor(
    worktree: string,
    /** Directory relative edit paths resolve against (the opencode instance directory). */
    readonly directory: string,
    readonly config: DebugConfig,
    readonly log: Logger,
    readonly db: DebugDb = new DebugDb(join(config.stateDir, "debug.sqlite")),
  ) {
    this.worktree = worktree
    let real = worktree
    try {
      real = realpathSync(worktree)
    } catch {}
    this.root = join(config.stateDir, createHash("sha1").update(real).digest("hex").slice(0, 16))
  }

  /** Serializes state-changing operations (tool calls can run concurrently). */
  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  // ---------- paths ----------
  private invDir(id: string): string {
    return join(this.root, id)
  }
  private tmp(id: string): string {
    return join(this.invDir(id), "tmp")
  }
  private logs(id: string): string {
    return join(this.invDir(id), "logs")
  }
  private ref(id: string, name: string): string {
    return `refs/debug-harness/${id}/${name}`
  }

  // ---------- lookup ----------
  /** The open investigation this session is bound to, or null. */
  active(sessionId: string): Investigation | null {
    const id = this.db.boundTo(sessionId)
    if (!id) return null
    const inv = this.db.investigation(id)
    return inv && inv.state !== "closed" && inv.worktree === this.worktree ? inv : null
  }

  private need(sessionId: string): Investigation {
    const inv = this.active(sessionId)
    if (inv) return inv
    const other = this.db.openFor(this.worktree)
    if (other) {
      throw new Rejection(
        `This session isn't attached to an investigation. \`${other.id}\` is open in this work tree (state ${other.state}); call debug_attach to take it over.`,
      )
    }
    throw new Rejection("No investigation is open. Write a repro command and call debug_open first.")
  }

  inheritSession(child: string, parent: string): void {
    const inv = this.active(parent)
    if (inv) this.db.bind(child, inv.id)
  }

  private experiment(inv: Investigation, id: string): Experiment {
    const e = this.db.experiments(inv.id).find((x) => x.id === id)
    if (!e) throw new Rejection(`No experiment \`${id}\` in ${inv.id}.`)
    return e
  }
  private hypothesis(inv: Investigation, id: string): Hypothesis {
    const h = this.db.hypotheses(inv.id).find((x) => x.id === id)
    if (!h) throw new Rejection(`No hypothesis \`${id}\` in ${inv.id}. Known: ${this.db.hypotheses(inv.id).map((x) => x.id).join(", ") || "none"}.`)
    return h
  }

  // ---------- running ----------
  private observationRuns(inv: Investigation): number {
    return inv.flaky ? this.config.flakyRuns : 1
  }

  private async repro(inv: Investigation, purpose: string, times: number, repro = inv.repro, fingerprint: string | null = inv.fingerprint): Promise<RunRecord> {
    const batch = await runRepro(this.worktree, repro, times, fingerprint, inv.flaky, this.logs(inv.id), purpose.replace(/[^a-z0-9-]/gi, "_"), this.config.reproTimeoutSec)
    const record: RunRecord = {
      id: `r${this.db.runs(inv.id).length + 1}`,
      purpose,
      tree: worktreeTree(this.worktree, this.tmp(inv.id)),
      outcome: batch.outcome,
      outcomes: batch.outcomes,
      at: now(),
    }
    this.db.putRun(inv.id, record)
    return record
  }

  private async runGuard(invId: string, guard: GuardSpec, label: string): Promise<GuardResult> {
    const logPath = join(this.logs(invId), `${Date.now()}-guard-${label}.log`)
    const r = await execLogged(guard.cmd, resolveCwd(this.worktree, guard.cwd), guard.env, guard.timeoutSec ?? this.config.guardTimeoutSec, logPath)
    return { exit: r.exit, timedOut: r.timedOut, passed: r.exit === 0 && !r.timedOut, logPath }
  }

  private runText(r: RunRecord | ReproBatch, withTail = true): string {
    const outs = r.outcomes
    const counts = (["red", "green", "other"] as const)
      .map((c) => [c, outs.filter((o) => o.classification === c).length] as const)
      .filter(([, n]) => n > 0)
      .map(([c, n]) => `${n} ${c}`)
      .join(", ")
    const last = outs[outs.length - 1]!
    const lines = [`Outcome: ${upper(r.outcome)} (${counts} of ${outs.length} run${outs.length === 1 ? "" : "s"}). Fingerprint: \`${last.fingerprint}\``]
    if (last.signature) lines.push(`Signature line: ${last.signature.slice(0, 300)}`)
    lines.push(`log_ref: ${last.logPath}`)
    if (withTail) {
      const t = tail(last.logPath, this.config.tailLines)
      if (t) lines.push("```", t, "```")
    }
    return lines.join("\n")
  }

  // ---------- open / attach / refine ----------
  open(sessionId: string, args: OpenArgs): Promise<string> {
    return this.exclusive(async () => {
      const mine = this.active(sessionId)
      if (mine) throw new Rejection(`This session is already investigating \`${mine.id}\`. Conclude or close it first.`)
      const top = worktreeRoot(this.worktree)
      if (!top) throw new Rejection("debug_open needs a git work tree (D5). Run `git init` (a scratch repo is fine) and retry.")
      const existing = this.db.openFor(this.worktree)
      if (existing) {
        throw new Rejection(`\`${existing.id}\` is already open in this work tree (session ${existing.ownerSession}, state ${existing.state}). Call debug_attach to take it over, or debug_close it.`)
      }
      if (!args.repro?.cmd?.trim()) throw new Rejection("repro.cmd is required: the smallest command that fails because of this bug.")
      if (args.repro.failSignature) {
        try {
          new RegExp(args.repro.failSignature)
        } catch (e) {
          throw new Rejection(`repro.failSignature is not a valid regex: ${(e as Error).message}`)
        }
      }
      const date = now().slice(0, 10).replace(/-/g, "")
      let id = `${date}-${slugify(args.symptom)}`
      for (let n = 2; this.db.idExists(id); n++) id = `${date}-${slugify(args.symptom)}-${n}`

      const est = await this.establishBaseline(id, args.repro, "baseline")
      if ("error" in est) {
        deleteRefs(this.worktree, `refs/debug-harness/${id}/`)
        throw new Rejection(est.error)
      }
      const snap = snapshot(this.worktree, this.tmp(id), this.ref(id, "baseline-0"), `${id} original baseline`)
      const guardBaseline = args.guard?.cmd ? await this.runGuard(id, args.guard, "baseline") : null
      const inv: Investigation = {
        id,
        worktree: this.worktree,
        state: "ready",
        ownerSession: sessionId,
        symptom: args.symptom,
        repro: { ...args.repro, locks: est.locks.map((l) => l.path) },
        guard: args.guard?.cmd ? args.guard : null,
        locks: est.locks,
        fingerprint: est.fingerprint,
        flaky: est.flaky,
        baselineRate: est.rate,
        originalBaseline: snap,
        currentBaseline: snap,
        rebaselines: [],
        guardBaseline,
        openExperiment: null,
        divergedReason: null,
        conclusion: null,
        createdAt: now(),
        updatedAt: now(),
      }
      this.db.insertInvestigation(inv)
      this.db.bind(sessionId, id)
      this.db.putRun(id, { ...est.run, tree: snap.tree })
      this.db.event(id, sessionId, "open", { symptom: args.symptom, repro: inv.repro, fingerprint: inv.fingerprint, flaky: inv.flaky })

      const lines = [
        `[debug-harness] Opened \`${id}\`. Baseline is RED on ${Math.round(est.rate * est.run.outcomes.length)}/${est.run.outcomes.length} runs.`,
        `Baseline fingerprint: \`${inv.fingerprint}\``,
        inv.flaky
          ? `FLAKY: runs disagreed. Every observation now runs ${this.config.flakyRuns}×; \`fixed\` needs ${this.config.flakyFixRuns} consecutive greens.`
          : "Deterministic: every baseline run failed the same way.",
        `Locked (experiments may not edit): ${inv.locks.map((l) => `\`${l.path}\``).join(", ") || "none — pass repro.locks to protect the test files"}`,
        guardBaseline ? `Guard at baseline: ${guardBaseline.passed ? "PASS" : `FAIL (exit ${guardBaseline.exit})`} — log_ref: ${guardBaseline.logPath}` : "No guard (pass-to-pass) command; `fixed` will not check for regressions.",
        this.runText(est.run),
        "Edits are now blocked outside experiments. " + NEXT.ready,
      ]
      return lines.join("\n")
    })
  }

  /** Runs the repro baselineRuns times on the current tree and derives fingerprint/flakiness/locks. */
  private async establishBaseline(
    invId: string,
    repro: ReproSpec,
    purpose: string,
  ): Promise<{ error: string } | { fingerprint: string; flaky: boolean; rate: number; locks: Investigation["locks"]; run: RunRecord }> {
    const n = Math.max(1, this.config.baselineRuns)
    const batch = await runRepro(this.worktree, repro, n, null, false, this.logs(invId), purpose, this.config.reproTimeoutSec)
    const failing = batch.outcomes.filter((o) => o.classification === "red")
    if (failing.length === 0) {
      const summary = batch.outcomes.map((o) => (o.timedOut ? "timeout" : `exit ${o.exit}`)).join(", ")
      return {
        error: `Can't reproduce: none of ${n} runs failed (${summary}). Refine the repro so it exits non-zero because of this bug, then retry.\n${this.runText(batch)}`,
      }
    }
    const counts = new Map<string, number>()
    for (const o of failing) counts.set(o.fingerprint, (counts.get(o.fingerprint) ?? 0) + 1)
    const fingerprint = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    for (const o of batch.outcomes) if (o.classification === "red" && o.fingerprint !== fingerprint) o.classification = "other"
    const reds = batch.outcomes.filter((o) => o.classification === "red").length
    const flaky = reds !== n
    const lockPaths = new Set([...(repro.locks ?? []), ...filesInCommand(this.worktree, repro.cwd, repro.cmd)])
    const locks = [...lockPaths].map((p) => ({ path: p, sha: sha(join(this.worktree, p)) }))
    const run: RunRecord = { id: "r1", purpose, tree: "", outcome: "red", outcomes: batch.outcomes, at: now() }
    return { fingerprint, flaky, rate: reds / n, locks, run }
  }

  attach(sessionId: string): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.db.openFor(this.worktree)
      if (!inv) throw new Rejection("No investigation is open in this work tree.")
      this.db.bind(sessionId, inv.id)
      inv.ownerSession = sessionId
      this.db.saveInvestigation(inv)
      this.db.event(inv.id, sessionId, "attach", {})
      return `[debug-harness] Attached to \`${inv.id}\`.\n${this.statusText(inv)}`
    })
  }

  refineRepro(sessionId: string, repro: ReproSpec, reason: string): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state !== "ready") throw new Rejection(`debug_refine_repro needs state ready (now ${inv.state}). ${NEXT[inv.state]}`)
      this.assertAtBaseline(inv)
      const est = await this.establishBaseline(inv.id, repro, "refine")
      if ("error" in est) throw new Rejection(est.error)
      const before = inv.fingerprint
      inv.repro = { ...repro, locks: est.locks.map((l) => l.path) }
      inv.locks = est.locks
      inv.fingerprint = est.fingerprint
      inv.flaky = est.flaky
      inv.baselineRate = est.rate
      this.db.saveInvestigation(inv)
      this.db.putRun(inv.id, { ...est.run, id: `r${this.db.runs(inv.id).length + 1}`, tree: inv.currentBaseline.tree })
      this.db.event(inv.id, sessionId, "refine", { reason, from: before, to: inv.fingerprint, repro: inv.repro })
      return `[debug-harness] Repro refined. Fingerprint \`${before}\` → \`${inv.fingerprint}\`${inv.flaky ? " (FLAKY)" : ""}.\n${this.runText(est.run)}`
    })
  }

  // ---------- hypotheses ----------
  hypothesize(sessionId: string, args: HypothesizeArgs): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state === "diverged") throw new Rejection(`The work tree has diverged from the baseline. ${NEXT.diverged}`)
      const e = args.prediction?.expect
      if (!e) throw new Rejection("prediction.expect is required: green | red | other | {outputMatches} | {outputLacks}. A prediction the repro can't check is not a hypothesis.")
      if (typeof e === "object") {
        const pattern = "outputMatches" in e ? e.outputMatches : e.outputLacks
        try {
          new RegExp(pattern)
        } catch (err) {
          throw new Rejection(`prediction.expect regex is invalid: ${(err as Error).message}`)
        }
      }
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
      const hs = this.db.hypotheses(inv.id)
      const dup = hs.find((h) => norm(h.statement) === norm(args.statement))
      if (dup) throw new Rejection(`Same statement as ${dup.id} (${dup.status}). Add a note to it, or state what is different about this one.`)
      const h: Hypothesis = { id: `h${hs.length + 1}`, ...args, status: "open", notes: [], createdAt: now() }
      this.db.putHypothesis(inv.id, h)
      this.db.event(inv.id, sessionId, "hypothesize", h)
      return `[debug-harness] Recorded ${h.id}: ${h.statement}\nPrediction: ${h.prediction.intervention} → ${describeExpect(h.prediction.expect)}.\nNext: debug_experiment_start({ hypothesis_id: "${h.id}", kind, scope }).`
    })
  }

  note(sessionId: string, hypothesisId: string, text: string): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      const h = this.hypothesis(inv, hypothesisId)
      h.notes.push({ at: now(), text })
      this.db.putHypothesis(inv.id, h)
      return `[debug-harness] Note added to ${h.id} (status unchanged: ${h.status}).`
    })
  }

  // ---------- experiments ----------
  private assertAtBaseline(inv: Investigation): void {
    const tree = worktreeTree(this.worktree, this.tmp(inv.id))
    if (tree === inv.currentBaseline.tree) return
    const changed = diffTrees(this.worktree, inv.currentBaseline.tree, tree).map((c) => `${c.status} ${c.path}`)
    inv.state = "diverged"
    inv.divergedReason = `The work tree changed outside an experiment: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ", …" : ""}`
    this.db.saveInvestigation(inv)
    throw new Rejection(`${inv.divergedReason}\n${NEXT.diverged}`)
  }

  start(sessionId: string, args: StartArgs): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state !== "ready") {
        throw new Rejection(
          inv.state === "experiment-open"
            ? `Experiment ${inv.openExperiment} is still open. One variable at a time: end it (debug_experiment_end) or abort it first.`
            : `Can't start an experiment in state ${inv.state}. ${NEXT[inv.state]}`,
        )
      }
      const h = this.hypothesis(inv, args.hypothesis_id)
      if (!args.scope?.length) throw new Rejection("scope is required: the path globs this experiment may edit (keep it narrow).")
      for (const g of args.scope) if (g.startsWith("/") || g.split("/").includes("..")) throw new Rejection(`scope \`${g}\` must be repo-relative.`)
      this.assertAtBaseline(inv)
      const exps = this.db.experiments(inv.id)
      const exp: Experiment = {
        id: `e${exps.length + 1}`,
        hypothesisId: h.id,
        kind: args.kind,
        scope: args.scope,
        touches: args.touches ?? [],
        base: inv.currentBaseline,
        end: null,
        patchPath: null,
        journal: [],
        edited: [],
        bashCommands: [],
        verdict: null,
        observation: null,
        interpretation: null,
        notes: [],
        startedAt: now(),
        endedAt: null,
      }
      for (const t of exp.touches) for (const p of t.paths ?? []) this.journal(inv, exp, p)
      inv.state = "experiment-open"
      inv.openExperiment = exp.id
      this.db.putExperiment(inv.id, exp)
      this.db.saveInvestigation(inv)
      this.db.event(inv.id, sessionId, "start", { id: exp.id, hypothesis: h.id, kind: exp.kind, scope: exp.scope, touches: exp.touches })
      return [
        `[debug-harness] Experiment ${exp.id} open for ${h.id} (${exp.kind}). Edits allowed in: ${exp.scope.map((s) => `\`${s}\``).join(", ")}.`,
        `Prediction to test: ${h.prediction.intervention} → ${describeExpect(h.prediction.expect)}.`,
        "Make the change, optionally observe with debug_run, then call debug_experiment_end. Ending records the verdict and resets the tree to the baseline.",
      ].join("\n")
    })
  }

  /** Copy-on-first-write for files git doesn't track (SPEC §3.5). Returns true when journaled now. */
  private journal(inv: Investigation, exp: Experiment, rel: string): boolean {
    if (exp.journal.some((j) => j.path === rel)) return false
    if (!isIgnored(this.worktree, rel)) return false
    const src = join(this.worktree, rel)
    const present = existsSync(src)
    if (present) {
      const dst = join(this.invDir(inv.id), "files", exp.id, "before", rel)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(src, dst)
    }
    exp.journal.push({ path: rel, before: present ? "present" : "absent" })
    return true
  }

  private journalCopy(invId: string, expId: string, phase: "before" | "after", rel: string): string {
    return join(this.invDir(invId), "files", expId, phase, rel)
  }

  private captureAfter(inv: Investigation, exp: Experiment): void {
    for (const j of exp.journal) {
      const src = join(this.worktree, j.path)
      j.after = existsSync(src) ? "present" : "absent"
      if (j.after === "present") {
        const dst = this.journalCopy(inv.id, exp.id, "after", j.path)
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
      }
    }
  }

  private putJournal(inv: Investigation, exp: Experiment, phase: "before" | "after"): void {
    for (const j of exp.journal) {
      const state = phase === "before" ? j.before : j.after
      const dst = join(this.worktree, j.path)
      if (state === "present") {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(this.journalCopy(inv.id, exp.id, phase, j.path), dst)
      } else if (state === "absent") {
        rmSync(dst, { force: true })
      }
    }
  }

  run(sessionId: string, withGuard: boolean): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      const purpose = inv.openExperiment ? `observe:${inv.openExperiment}` : "observe"
      const r = await this.repro(inv, purpose, this.observationRuns(inv))
      this.db.event(inv.id, sessionId, "run", { run: r.id, outcome: r.outcome })
      const lines = [`[debug-harness] Repro run ${r.id} (harness-observed, ${inv.openExperiment ? `during ${inv.openExperiment}` : inv.state}).`, this.runText(r)]
      if (withGuard) {
        if (!inv.guard) lines.push("No guard command was given at debug_open.")
        else {
          const g = await this.runGuard(inv.id, inv.guard, "observe")
          lines.push(`Guard: ${g.passed ? "PASS" : `FAIL (exit ${g.exit}${g.timedOut ? ", timed out" : ""})`} (baseline: ${inv.guardBaseline?.passed ? "PASS" : "FAIL"}) — log_ref: ${g.logPath}`)
        }
      }
      return lines.join("\n")
    })
  }

  end(sessionId: string, interpretation: string): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state !== "experiment-open" || !inv.openExperiment) throw new Rejection(`No experiment is open (state ${inv.state}). ${NEXT[inv.state]}`)
      const exp = this.experiment(inv, inv.openExperiment)
      const h = this.hypothesis(inv, exp.hypothesisId)

      const endSnap = snapshot(this.worktree, this.tmp(inv.id), this.ref(inv.id, `${exp.id}-end`), `${inv.id} ${exp.id} end`)
      exp.end = endSnap
      const lockViolations = inv.locks.filter((l) => sha(join(this.worktree, l.path)) !== l.sha).map((l) => l.path)

      const prior = this.db
        .runs(inv.id)
        .filter((r) => r.purpose === `observe:${exp.id}` && r.tree === endSnap.tree)
        .pop()
      const obs = prior ?? (await this.repro(inv, `observe:${exp.id}`, this.observationRuns(inv)))
      const outputs = obs.outcomes.map((o) => readLog(o.logPath))
      let verdict = verdictFor(h.prediction.expect, obs.outcome, outputs)
      const notes: string[] = []
      if (lockViolations.length) {
        verdict = "inconclusive"
        notes.push(`Locked file(s) changed: ${lockViolations.join(", ")}; the observation doesn't count.`)
      }
      if (endSnap.tree === exp.base.tree) notes.push("The experiment changed nothing git can see.")

      const patchPath = join(this.invDir(inv.id), "patches", `${exp.id}.patch`)
      mkdirSync(dirname(patchPath), { recursive: true })
      writeFileSync(patchPath, diffPatch(this.worktree, exp.base.tree, endSnap.tree))
      this.captureAfter(inv, exp)
      Object.assign(exp, { patchPath, verdict, observation: obs.id, interpretation, notes, endedAt: now() })
      this.db.putExperiment(inv.id, exp)
      h.status = verdict
      this.db.putHypothesis(inv.id, h)
      this.db.event(inv.id, sessionId, "end", { id: exp.id, verdict, run: obs.id, outcome: obs.outcome, lockViolations })

      const head = [
        `[debug-harness] ${exp.id} ended. Verdict for ${h.id}: ${upper(verdict)} (predicted ${describeExpect(h.prediction.expect)}, observed ${obs.outcome}).`,
        ...notes,
        this.runText(obs),
        `Patch saved: ${patchPath}`,
      ]

      const changed = diffTrees(this.worktree, exp.base.tree, endSnap.tree).map((c) => c.path)
      const accounted = new Set([...exp.edited, ...exp.journal.map((j) => j.path)])
      const foreign = exp.bashCommands.length === 0 ? changed.filter((p) => !accounted.has(p)) : []
      if (foreign.length) {
        inv.state = "diverged"
        inv.divergedReason = `Files changed that this experiment didn't edit (someone else's work?): ${foreign.join(", ")}. Not reset. Move them aside, or call debug_reset({ confirm: true }) to discard them.`
        this.db.saveInvestigation(inv)
        return [...head, `RESET WITHHELD. ${inv.divergedReason}`].join("\n")
      }
      const reset = await this.resetAndVerify(inv, exp, sessionId)
      return [...head, reset].join("\n")
    })
  }

  abort(sessionId: string, reason: string): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state !== "experiment-open" || !inv.openExperiment) throw new Rejection(`No experiment is open (state ${inv.state}).`)
      const exp = this.experiment(inv, inv.openExperiment)
      exp.end = snapshot(this.worktree, this.tmp(inv.id), this.ref(inv.id, `${exp.id}-end`), `${inv.id} ${exp.id} aborted`)
      exp.verdict = "aborted"
      exp.interpretation = reason
      exp.endedAt = now()
      this.db.putExperiment(inv.id, exp)
      this.db.event(inv.id, sessionId, "abort", { id: exp.id, reason })
      return `[debug-harness] ${exp.id} aborted (hypothesis status unchanged).\n${await this.resetAndVerify(inv, exp, sessionId)}`
    })
  }

  /** Restore the current baseline, run declared resets, then prove it: same tree, repro red again. */
  private async resetAndVerify(inv: Investigation, exp: Experiment | null, sessionId: string): Promise<string> {
    const problems: string[] = []
    restoreWorktree(this.worktree, this.tmp(inv.id), inv.currentBaseline.commit)
    if (exp) this.putJournal(inv, exp, "before")
    for (const t of exp?.touches ?? []) {
      if (!t.reset) continue
      const r = await execLogged(t.reset, this.worktree, undefined, this.config.reproTimeoutSec, join(this.logs(inv.id), `${Date.now()}-reset-${exp!.id}.log`))
      if (r.exit !== 0) problems.push(`reset for "${t.what}" failed (exit ${r.exit}${r.timedOut ? ", timed out" : ""})`)
    }
    const tree = worktreeTree(this.worktree, this.tmp(inv.id))
    if (tree !== inv.currentBaseline.tree) {
      const left = diffTrees(this.worktree, inv.currentBaseline.tree, tree).map((c) => `${c.status} ${c.path}`)
      problems.push(`tree still differs from the baseline: ${left.join(", ")}`)
    }
    const verify = await this.repro(inv, `reset-verify${exp ? `:${exp.id}` : ""}`, inv.flaky ? this.config.flakyRuns : Math.max(1, this.config.verifyRuns))
    if (verify.outcome !== "red") problems.push(`repro is ${verify.outcome}, not red with the baseline fingerprint`)
    this.db.event(inv.id, sessionId, "reset", { experiment: exp?.id ?? null, run: verify.id, ok: problems.length === 0, problems })

    if (problems.length) {
      inv.state = "diverged"
      inv.divergedReason = `Reset not verified: ${problems.join("; ")}.`
      this.db.saveInvestigation(inv)
      return [`RESET FAILED. ${inv.divergedReason}`, this.runText(verify), NEXT.diverged].join("\n")
    }
    inv.state = "ready"
    inv.openExperiment = null
    inv.divergedReason = null
    this.db.saveInvestigation(inv)
    return `Reset verified: tree equals the baseline and the repro is RED again (${verify.id}, fingerprint matches). ${NEXT.ready}`
  }

  reset(sessionId: string, confirm: boolean): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state === "ready") return `[debug-harness] Nothing to reset; state is ready.`
      if (inv.divergedReason?.includes("didn't edit") && !confirm) {
        throw new Rejection(`${inv.divergedReason}\nPass confirm: true only if those changes may be discarded.`)
      }
      const exp = inv.openExperiment ? this.experiment(inv, inv.openExperiment) : null
      return `[debug-harness] ${await this.resetAndVerify(inv, exp, sessionId)}`
    })
  }

  rebaseline(sessionId: string, reason: string, fromExperiment?: string): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state === "experiment-open") throw new Rejection("End or abort the open experiment first.")
      let exp: Experiment | null = null
      if (fromExperiment) {
        if (inv.state !== "ready") throw new Rejection("Rebaselining from an experiment needs state ready.")
        exp = this.experiment(inv, fromExperiment)
        if (!exp.patchPath) throw new Rejection(`${exp.id} has no saved patch.`)
        this.assertAtBaseline(inv)
        const r = applyPatch(this.worktree, readFileSync(exp.patchPath, "utf8"))
        if (r.code !== 0) throw new Rejection(`${exp.id}'s patch doesn't apply to the current baseline: ${r.stderr.trim()}`)
        this.putJournal(inv, exp, "after")
      } else if (inv.state !== "diverged") {
        throw new Rejection("Without from_experiment, rebaseline only accepts a diverged tree. To keep an experiment's change, pass from_experiment.")
      }
      const n = inv.flaky ? this.config.flakyRuns : Math.max(1, this.config.baselineRuns)
      const check = await this.repro(inv, "rebaseline", n)
      if (check.outcome !== "red") {
        if (exp) {
          restoreWorktree(this.worktree, this.tmp(inv.id), inv.currentBaseline.commit)
          this.putJournal(inv, exp, "before")
        }
        throw new Rejection(`The candidate baseline isn't RED with the baseline fingerprint (${check.outcome}); not rebaselined.\n${this.runText(check)}`)
      }
      const k = inv.rebaselines.length + 1
      const snap: Snapshot = snapshot(this.worktree, this.tmp(inv.id), this.ref(inv.id, `baseline-${k}`), `${inv.id} baseline ${k}`)
      inv.currentBaseline = snap
      inv.rebaselines.push({ at: now(), reason, fromExperiment: exp?.id ?? null, commit: snap.commit })
      inv.state = "ready"
      inv.openExperiment = null
      inv.divergedReason = null
      this.db.saveInvestigation(inv)
      this.db.event(inv.id, sessionId, "rebaseline", { reason, fromExperiment: exp?.id ?? null, commit: snap.commit })
      return `[debug-harness] Rebaselined (${k}): ${reason}. Repro RED on the new baseline. \`fixed\` is still proven against the original baseline.\n${NEXT.ready}`
    })
  }

  // ---------- conclusion ----------
  conclude(sessionId: string, args: ConcludeArgs): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      if (inv.state !== "ready") throw new Rejection(`Can't conclude in state ${inv.state}. ${NEXT[inv.state]}`)
      if (!args.summary?.trim()) throw new Rejection("summary is required.")
      const ids = args.hypothesis_ids ?? []
      const hs = ids.map((id) => this.hypothesis(inv, id))
      const exps = this.db.experiments(inv.id)
      let evidence: string | null = null
      let proof: ProofStep[] = []

      if (args.kind === "understood") {
        if (!hs.some((h) => h.status === "supported")) {
          throw new Rejection(`\`understood\` needs at least one supported hypothesis in hypothesis_ids (given: ${ids.map((id) => `${id}=${this.hypothesis(inv, id).status}`).join(", ") || "none"}).`)
        }
        evidence = this.evidenceStrength(hs, exps)
      } else if (args.kind === "fixed") {
        if (!args.fix_experiment) throw new Rejection("`fixed` needs fix_experiment: the intervention whose verdict was supported.")
        const fx = this.experiment(inv, args.fix_experiment)
        const fh = this.hypothesis(inv, fx.hypothesisId)
        if (fx.verdict !== "supported" || fh.prediction.expect !== "green") {
          throw new Rejection(`${fx.id} must be a supported experiment whose prediction was \`green\` (verdict ${fx.verdict}, predicted ${describeExpect(fh.prediction.expect)}).`)
        }
        this.assertAtBaseline(inv)
        const result = await this.toggleProof(inv, fx, sessionId)
        proof = result.steps
        if (!result.ok) {
          this.db.event(inv.id, sessionId, "conclude-rejected", { proof })
          const restore = await this.resetAndVerify(inv, fx, sessionId)
          throw new Rejection(`Toggle proof failed; not fixed.\n${this.proofTable(proof)}\n${restore}`)
        }
        if (!hs.some((h) => h.id === fh.id)) hs.push(fh)
        evidence = "toggled (fix applied → green, reverted → red, reapplied → green)"
      }

      const conclusion: Conclusion = {
        kind: args.kind,
        summary: args.summary,
        rootCause: args.root_cause ?? null,
        hypothesisIds: hs.map((h) => h.id),
        fixExperiment: args.fix_experiment ?? null,
        evidence,
        proof,
        reportPath: null,
        at: now(),
      }
      return this.finish(inv, conclusion, sessionId, args.kind === "fixed" ? "The fix is applied and uncommitted for you to review." : "The tree is at the baseline.")
    })
  }

  private evidenceStrength(hs: Hypothesis[], exps: Experiment[]): string {
    const supported = (h: Hypothesis) => exps.filter((e) => e.hypothesisId === h.id && e.verdict === "supported")
    for (const h of hs) if (supported(h).some((e) => e.kind === "toggle")) return "toggled (cause removed → green; reset put it back → red)"
    for (const h of hs) if (supported(h).length && typeof h.prediction.expect === "object") return "predicted (a specific output prediction was confirmed)"
    return "intervention (a predicted outcome was confirmed, without a cause toggle)"
  }

  private async toggleProof(inv: Investigation, fx: Experiment, sessionId: string): Promise<{ ok: boolean; steps: ProofStep[] }> {
    const steps: ProofStep[] = []
    const patch = readFileSync(fx.patchPath!, "utf8")
    const greenRuns = inv.flaky ? this.config.flakyFixRuns : 1
    const redRuns = inv.flaky ? this.config.flakyRuns : 1
    const step = async (name: string, expected: Classification, times: number) => {
      const r = await this.repro(inv, `proof:${name}`, times)
      const ok = r.outcome === expected
      steps.push({ step: name, expected, got: r.outcome, ok, logPath: r.outcomes[r.outcomes.length - 1]?.logPath ?? null })
      return ok
    }
    const apply = (name: string) => {
      const r = applyPatch(this.worktree, patch)
      this.putJournal(inv, fx, "after")
      if (r.code !== 0) steps.push({ step: name, expected: "pass", got: `patch did not apply: ${r.stderr.trim()}`, ok: false, logPath: null })
      return r.code === 0
    }
    const revert = () => {
      restoreWorktree(this.worktree, this.tmp(inv.id), inv.originalBaseline.commit)
      this.putJournal(inv, fx, "before")
    }

    revert()
    if (!(await step("1 original baseline", "red", redRuns))) return { ok: false, steps }
    if (!apply("2 apply fix")) return { ok: false, steps }
    if (!(await step("2 fix applied", "green", greenRuns))) return { ok: false, steps }
    if (inv.guard) {
      const g = await this.runGuard(inv.id, inv.guard, "proof")
      const baselinePassed = inv.guardBaseline?.passed ?? false
      const ok = g.passed || !baselinePassed
      steps.push({ step: "2 guard (pass-to-pass)", expected: "pass", got: g.passed ? "pass" : baselinePassed ? "FAIL (passed at baseline)" : "fail (also failed at baseline; not comparable)", ok, logPath: g.logPath })
      if (!ok) return { ok: false, steps }
    }
    revert()
    if (!(await step("3 fix reverted", "red", redRuns))) return { ok: false, steps }
    if (!apply("4 reapply fix")) return { ok: false, steps }
    if (!(await step("4 fix reapplied", "green", greenRuns))) return { ok: false, steps }
    this.db.event(inv.id, sessionId, "proof", { steps })
    return { ok: true, steps }
  }

  proofTable(steps: ProofStep[]): string {
    return ["| Step | Expected | Got | |", "|---|---|---|---|", ...steps.map((s) => `| ${s.step} | ${s.expected} | ${s.got} | ${s.ok ? "✓" : "✗"} |`)].join("\n")
  }

  private finish(inv: Investigation, conclusion: Conclusion, sessionId: string, tail: string): string {
    inv.conclusion = conclusion
    inv.state = "closed"
    inv.openExperiment = null
    const report = renderReport(inv, this.db.hypotheses(inv.id), this.db.experiments(inv.id), this.db.runs(inv.id), (s) => this.proofTable(s))
    const reportPath = join(this.invDir(inv.id), "report.md")
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, report)
    conclusion.reportPath = reportPath
    let repoCopy = ""
    if (this.config.reportDir) {
      const dst = join(this.worktree, this.config.reportDir, `${inv.id}.md`)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, report)
      repoCopy = ` Also written to ${this.config.reportDir}/${inv.id}.md.`
    }
    this.db.saveInvestigation(inv)
    this.db.event(inv.id, sessionId, "conclude", conclusion)
    deleteRefs(this.worktree, `refs/debug-harness/${inv.id}/`)
    const lines = [`[debug-harness] Concluded \`${inv.id}\`: ${conclusion.kind.toUpperCase()}.`]
    if (conclusion.evidence) lines.push(`Evidence: ${conclusion.evidence}`)
    if (conclusion.proof.length) lines.push(this.proofTable(conclusion.proof))
    const open = this.db.hypotheses(inv.id).filter((h) => h.status === "open")
    if (open.length) lines.push(`Untested hypotheses: ${open.map((h) => h.id).join(", ")}`)
    lines.push(`Report: ${reportPath}.${repoCopy}`, tail)
    return lines.join("\n")
  }

  close(sessionId: string, reason: string, restore: boolean): Promise<string> {
    return this.exclusive(async () => {
      const inv = this.need(sessionId)
      let note = "The work tree was left as it is."
      if (restore) {
        restoreWorktree(this.worktree, this.tmp(inv.id), inv.originalBaseline.commit)
        if (inv.openExperiment) this.putJournal(inv, this.experiment(inv, inv.openExperiment), "before")
        note = "The work tree was restored to how it was at debug_open."
      }
      if (inv.openExperiment) {
        const exp = this.experiment(inv, inv.openExperiment)
        if (!exp.verdict) {
          exp.verdict = "aborted"
          exp.endedAt = now()
          this.db.putExperiment(inv.id, exp)
        }
      }
      const conclusion: Conclusion = { kind: "abandoned", summary: reason, rootCause: null, hypothesisIds: [], fixExperiment: null, evidence: null, proof: [], reportPath: null, at: now() }
      return this.finish(inv, conclusion, sessionId, note)
    })
  }

  // ---------- status ----------
  status(sessionId: string): string {
    const inv = this.active(sessionId)
    if (inv) return this.statusText(inv)
    const other = this.db.openFor(this.worktree)
    if (other) return `[debug-harness] \`${other.id}\` is open in this work tree but not attached to this session (state ${other.state}). debug_attach takes it over.\n${this.statusText(other)}`
    return "[debug-harness] No investigation open. Write a repro and call debug_open."
  }

  statusText(inv: Investigation): string {
    const hs = this.db.hypotheses(inv.id)
    const exps = this.db.experiments(inv.id)
    const lines = [
      `## Investigation \`${inv.id}\` — ${inv.state}`,
      `Symptom: ${inv.symptom}`,
      `Repro: \`${inv.repro.cmd}\`${inv.flaky ? ` (FLAKY, baseline red rate ${Math.round(inv.baselineRate * 100)}%)` : ""}`,
      `Baseline fingerprint: \`${inv.fingerprint}\``,
      `Locked: ${inv.locks.map((l) => l.path).join(", ") || "none"}`,
    ]
    if (inv.rebaselines.length) lines.push(`Rebaselines: ${inv.rebaselines.map((r, i) => `${i + 1}. ${r.reason}${r.fromExperiment ? ` (from ${r.fromExperiment})` : ""}`).join("; ")}`)
    if (inv.divergedReason) lines.push(`Diverged: ${inv.divergedReason}`)
    lines.push("", "| Hypothesis | Status | Prediction | Experiments |", "|---|---|---|---|")
    for (const h of hs) {
      const es = exps.filter((e) => e.hypothesisId === h.id).map((e) => `${e.id}:${e.verdict ?? "open"}`)
      lines.push(`| ${h.id}: ${h.statement.replace(/\|/g, "/")} | ${h.status} | ${h.prediction.intervention.replace(/\|/g, "/")} → ${describeExpect(h.prediction.expect)} | ${es.join(", ") || "—"} |`)
    }
    if (!hs.length) lines.push("| — | | | |")
    if (inv.openExperiment) {
      const e = exps.find((x) => x.id === inv.openExperiment)
      if (e) lines.push("", `Open experiment ${e.id} (${e.kind}, for ${e.hypothesisId}); scope: ${e.scope.join(", ")}; edited: ${e.edited.join(", ") || "nothing yet"}`)
    }
    lines.push("", NEXT[inv.state])
    return lines.join("\n")
  }

  /** ≤6-line header for every turn (FR-S1). */
  header(sessionId: string): string | null {
    const inv = this.active(sessionId)
    if (!inv) return null
    const hs = this.db.hypotheses(inv.id)
    const exps = this.db.experiments(inv.id)
    const last = [...exps].reverse().find((e) => e.verdict)
    const open = inv.openExperiment ? exps.find((e) => e.id === inv.openExperiment) : null
    return [
      `[debug-harness] Investigation ${inv.id} — state ${inv.state}${open ? ` (${open.id} for ${open.hypothesisId}, ${open.kind}; scope ${open.scope.join(", ")})` : ""}`,
      `Repro: \`${inv.repro.cmd}\` — baseline ${inv.flaky ? "FLAKY " : ""}red, fingerprint \`${inv.fingerprint}\``,
      `Hypotheses: ${hs.map((h) => `${h.id} ${h.status}`).join(", ") || "none"}${last ? `. Last verdict: ${last.id} ${last.verdict}` : ""}`,
      NEXT[inv.state],
    ].join("\n")
  }

  // ---------- policy (tool.execute.before) ----------
  /** FR-X3 / §3.6. Throws Rejection to block; returns a note for unbound sessions in a locked tree. */
  checkEdit(sessionId: string, tool: string, args: Record<string, unknown>): string | null {
    const inv = this.active(sessionId)
    if (!inv) return this.foreignWarning(sessionId)
    if (inv.state !== "experiment-open" || !inv.openExperiment) {
      throw new Rejection(`Edits are blocked: no experiment is open in \`${inv.id}\` (state ${inv.state}). ${NEXT[inv.state]}`)
    }
    const exp = this.experiment(inv, inv.openExperiment)
    const targets = editTargets(args)
    if (!targets) throw new Rejection(`Can't tell which file this \`${tool}\` call writes, so it can't be scoped. Use write or edit with filePath.`)
    const rels: string[] = []
    for (const t of targets) {
      const rel = toRepoRelative(this.worktree, this.directory, t)
      if (!rel) throw new Rejection(`\`${t}\` is outside the work tree; the harness can't reset it, so it can't be edited during an investigation.`)
      if (inv.locks.some((l) => l.path === rel)) throw new Rejection(`\`${rel}\` is locked: the repro depends on it. Change the repro only with debug_refine_repro.`)
      if (!inScope(rel, exp.scope)) throw new Rejection(`\`${rel}\` is outside ${exp.id}'s scope (${exp.scope.join(", ")}). One variable at a time: end this experiment and start another with the right scope.`)
      rels.push(rel)
    }
    let changed = false
    for (const rel of rels) {
      if (this.journal(inv, exp, rel)) changed = true
      if (!exp.edited.includes(rel)) {
        exp.edited.push(rel)
        changed = true
      }
    }
    if (changed) this.db.putExperiment(inv.id, exp)
    return null
  }

  checkBash(sessionId: string, command: string): string | null {
    const inv = this.active(sessionId)
    if (!inv) return null
    if (new RegExp(this.config.bash.forbidden).test(command)) {
      throw new Rejection(`\`${command.slice(0, 120)}\` changes git history, the index or refs, which would break the investigation's snapshots. The harness does resets itself (debug_experiment_end, debug_reset).`)
    }
    if (!new RegExp(this.config.bash.mutating, "m").test(command)) return null
    if (inv.state !== "experiment-open" || !inv.openExperiment) {
      throw new Rejection(`\`${command.slice(0, 120)}\` looks like it changes files or state, and no experiment is open (state ${inv.state}). ${NEXT[inv.state]} Read-only commands are fine.`)
    }
    const exp = this.experiment(inv, inv.openExperiment)
    exp.bashCommands.push(command)
    this.db.putExperiment(inv.id, exp)
    this.db.event(inv.id, sessionId, "bash", { experiment: exp.id, command })
    return null
  }

  private foreignWarning(sessionId: string): string | null {
    if (this.warnedSessions.has(sessionId)) return null
    const other = this.db.openFor(this.worktree)
    if (!other) return null
    this.warnedSessions.add(sessionId)
    return `[debug-harness] Note: investigation \`${other.id}\` owns this work tree. Edits from this session will show up as foreign changes and block its next reset.`
  }
}
