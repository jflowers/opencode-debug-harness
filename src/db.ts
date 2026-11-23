import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Classification } from "./fingerprint"
import type { GuardSpec, ReproSpec, RunOutcome } from "./runner"

/** SPEC §3.3. */
export type InvState = "ready" | "experiment-open" | "diverged" | "closed"

export interface LockedFile {
  path: string
  sha: string | null // null = absent at open
}

export interface GuardResult {
  exit: number | null
  timedOut: boolean
  passed: boolean
  logPath: string
}

export interface Conclusion {
  kind: "fixed" | "understood" | "abandoned"
  summary: string
  rootCause: string | null
  hypothesisIds: string[]
  fixExperiment: string | null
  evidence: string | null
  proof: ProofStep[]
  reportPath: string | null
  at: string
}

export interface ProofStep {
  step: string
  expected: Classification | "pass"
  got: string
  ok: boolean
  logPath: string | null
}

export interface Investigation {
  id: string
  worktree: string
  state: InvState
  ownerSession: string
  symptom: string
  repro: ReproSpec
  guard: GuardSpec | null
  locks: LockedFile[]
  fingerprint: string
  flaky: boolean
  baselineRate: number
  originalBaseline: { commit: string; tree: string }
  currentBaseline: { commit: string; tree: string }
  rebaselines: { at: string; reason: string; fromExperiment: string | null; commit: string }[]
  guardBaseline: GuardResult | null
  openExperiment: string | null
  divergedReason: string | null
  conclusion: Conclusion | null
  createdAt: string
  updatedAt: string
}

export type Expect = "green" | "red" | "other" | { outputMatches: string } | { outputLacks: string }

export interface Hypothesis {
  id: string
  statement: string
  mechanism: string
  prediction: { intervention: string; expect: Expect }
  falsifier: string
  status: "open" | "supported" | "refuted" | "inconclusive"
  notes: { at: string; text: string }[]
  createdAt: string
}

export interface JournalEntry {
  path: string
  before: "present" | "absent"
  after?: "present" | "absent"
}

export interface Touch {
  what: string
  reset?: string
  paths?: string[]
}

export interface Experiment {
  id: string
  hypothesisId: string
  kind: "intervention" | "probe" | "toggle"
  scope: string[]
  touches: Touch[]
  base: { commit: string; tree: string }
  end: { commit: string; tree: string } | null
  patchPath: string | null
  /** Ignored files edited during the experiment, with pre-edit copies (SPEC §3.5). */
  journal: JournalEntry[]
  /** Repo-relative paths written through edit tools. */
  edited: string[]
  bashCommands: string[]
  verdict: "supported" | "refuted" | "inconclusive" | "aborted" | null
  observation: string | null // run id
  interpretation: string | null
  notes: string[]
  startedAt: string
  endedAt: string | null
}

export interface RunRecord {
  id: string
  purpose: string
  tree: string
  outcome: Classification
  outcomes: RunOutcome[]
  at: string
}

export function now(): string {
  return new Date().toISOString()
}

/** One DB for every work tree; artifacts live per work tree beside it (D8). */
export class DebugDb {
  readonly db: Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS investigations (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_worktree
        ON investigations(worktree) WHERE state != 'closed';
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        investigation_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hypotheses (
        investigation_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (investigation_id, id)
      );
      CREATE TABLE IF NOT EXISTS experiments (
        investigation_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (investigation_id, id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        investigation_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (investigation_id, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        investigation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  // investigations
  insertInvestigation(inv: Investigation): void {
    this.db.query("INSERT INTO investigations (id, worktree, state, data) VALUES (?, ?, ?, ?)").run(inv.id, inv.worktree, inv.state, JSON.stringify(inv))
  }
  saveInvestigation(inv: Investigation): void {
    inv.updatedAt = now()
    this.db.query("UPDATE investigations SET state = ?, data = ? WHERE id = ?").run(inv.state, JSON.stringify(inv), inv.id)
  }
  investigation(id: string): Investigation | null {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM investigations WHERE id = ?").get(id)
    return row ? (JSON.parse(row.data) as Investigation) : null
  }
  openFor(worktree: string): Investigation | null {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM investigations WHERE worktree = ? AND state != 'closed'").get(worktree)
    return row ? (JSON.parse(row.data) as Investigation) : null
  }
  idExists(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM investigations WHERE id = ?").get(id)
  }

  // sessions
  bind(sessionId: string, investigationId: string): void {
    this.db.query("INSERT OR REPLACE INTO sessions (session_id, investigation_id) VALUES (?, ?)").run(sessionId, investigationId)
  }
  boundTo(sessionId: string): string | null {
    const row = this.db.query<{ investigation_id: string }, [string]>("SELECT investigation_id FROM sessions WHERE session_id = ?").get(sessionId)
    return row?.investigation_id ?? null
  }

  // children
  private put(table: "hypotheses" | "experiments" | "runs", invId: string, id: string, data: unknown): void {
    this.db.query(`INSERT OR REPLACE INTO ${table} (investigation_id, id, data) VALUES (?, ?, ?)`).run(invId, id, JSON.stringify(data))
  }
  private all<T>(table: "hypotheses" | "experiments" | "runs", invId: string): T[] {
    return this.db
      .query<{ data: string }, [string]>(`SELECT data FROM ${table} WHERE investigation_id = ? ORDER BY rowid`)
      .all(invId)
      .map((r) => JSON.parse(r.data) as T)
  }
  putHypothesis(invId: string, h: Hypothesis): void {
    this.put("hypotheses", invId, h.id, h)
  }
  hypotheses(invId: string): Hypothesis[] {
    return this.all<Hypothesis>("hypotheses", invId)
  }
  putExperiment(invId: string, e: Experiment): void {
    this.put("experiments", invId, e.id, e)
  }
  experiments(invId: string): Experiment[] {
    return this.all<Experiment>("experiments", invId)
  }
  putRun(invId: string, r: RunRecord): void {
    this.put("runs", invId, r.id, r)
  }
  runs(invId: string): RunRecord[] {
    return this.all<RunRecord>("runs", invId)
  }

  event(invId: string, sessionId: string, kind: string, detail: unknown): void {
    this.db.query("INSERT INTO events (investigation_id, session_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)").run(invId, sessionId, kind, JSON.stringify(detail), now())
  }
  events(invId: string): { kind: string; detail: unknown; at: string; session_id: string }[] {
    return this.db
      .query<{ kind: string; detail: string; at: string; session_id: string }, [string]>("SELECT kind, detail, at, session_id FROM events WHERE investigation_id = ? ORDER BY seq")
      .all(invId)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }))
  }
}
