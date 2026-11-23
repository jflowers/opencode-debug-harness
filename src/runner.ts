import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import { aggregate, type Classification, classify } from "./fingerprint"

export interface ReproSpec {
  cmd: string
  cwd?: string
  env?: Record<string, string>
  timeoutSec?: number
  failSignature?: string | null
  /** Repo-relative files the agent may not edit (FR-O8). */
  locks?: string[]
}

export interface GuardSpec {
  cmd: string
  cwd?: string
  env?: Record<string, string>
  timeoutSec?: number
}

export interface RunOutcome {
  exit: number | null
  timedOut: boolean
  classification: Classification
  fingerprint: string
  signature: string | null
  durationMs: number
  logPath: string
}

export interface ExecResult {
  exit: number | null
  timedOut: boolean
  durationMs: number
  output: string
}

/** Runs `cmd` with bash in `cwd`, stdout+stderr to `logPath`, killing the process group on timeout. */
export async function execLogged(
  cmd: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutSec: number,
  logPath: string,
): Promise<ExecResult> {
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, "w")
  const started = Date.now()
  let timedOut = false
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], {
      cwd,
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-proc.pid, "SIGKILL")
      } catch {
        proc.kill("SIGKILL")
      }
    }, timeoutSec * 1000)
    const exit = await proc.exited
    clearTimeout(timer)
    return { exit: timedOut ? null : exit, timedOut, durationMs: Date.now() - started, output: readLog(logPath) }
  } finally {
    closeSync(fd)
  }
}

export function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8")
  } catch {
    return ""
  }
}

export function resolveCwd(worktree: string, cwd?: string): string {
  if (!cwd) return worktree
  return isAbsolute(cwd) ? cwd : join(worktree, cwd)
}

export interface ReproBatch {
  outcomes: RunOutcome[]
  outcome: Classification
}

let runSeq = 0

/** Runs the repro `times` times and classifies against `baseline` (null during debug_open). */
export async function runRepro(
  worktree: string,
  repro: ReproSpec,
  times: number,
  baseline: string | null,
  flaky: boolean,
  logDir: string,
  label: string,
  defaultTimeoutSec: number,
): Promise<ReproBatch> {
  const outcomes: RunOutcome[] = []
  const stamp = `${Date.now()}-${++runSeq}`
  for (let i = 0; i < times; i++) {
    const logPath = join(logDir, `${stamp}-${label}-${i + 1}.log`)
    const r = await execLogged(repro.cmd, resolveCwd(worktree, repro.cwd), repro.env, repro.timeoutSec ?? defaultTimeoutSec, logPath)
    const c = classify(r, repro.failSignature, baseline)
    outcomes.push({ exit: r.exit, timedOut: r.timedOut, durationMs: r.durationMs, logPath, ...c })
  }
  return { outcomes, outcome: aggregate(outcomes.map((o) => o.classification), flaky) }
}

/** Last `n` lines of a log, each capped, for the model (claim check: the full log stays on disk). */
export function tail(logPath: string, n: number): string {
  const lines = readLog(logPath).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n")
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  return lines
    .slice(-n)
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
    .join("\n")
}

/** Repo-relative files named in the command (FR-O8 default locks). */
export function filesInCommand(worktree: string, cwd: string | undefined, cmd: string): string[] {
  const base = resolveCwd(worktree, cwd)
  const found = new Set<string>()
  for (const raw of cmd.split(/\s+/)) {
    const tok = raw.replace(/^['"]|['"]$/g, "").replace(/::.*$/, "").replace(/:\d+$/, "")
    if (!tok || tok.startsWith("-") || !/[./]/.test(tok)) continue
    const abs = isAbsolute(tok) ? tok : join(base, tok)
    try {
      if (statSync(abs).isFile()) {
        const rel = relative(worktree, abs)
        if (!rel.startsWith("..")) found.add(rel)
      }
    } catch {}
  }
  return [...found]
}
