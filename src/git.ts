import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** Identity for the harness's private snapshot commits (never on a branch). */
const IDENTITY = {
  GIT_AUTHOR_NAME: "opencode-debug-harness",
  GIT_AUTHOR_EMAIL: "debug-harness@localhost",
  GIT_COMMITTER_NAME: "opencode-debug-harness",
  GIT_COMMITTER_EMAIL: "debug-harness@localhost",
}

export class GitError extends Error {}

export function git(cwd: string, args: string[], env?: Record<string, string>, stdin?: string): GitResult {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: "0", ...env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

export function gitOk(cwd: string, args: string[], env?: Record<string, string>, stdin?: string): string {
  const r = git(cwd, args, env, stdin)
  if (r.code !== 0) throw new GitError(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout
}

/** Top level of the work tree containing `dir`, or null when it isn't in one. */
export function worktreeRoot(dir: string): string | null {
  const r = git(dir, ["rev-parse", "--show-toplevel"])
  return r.code === 0 ? r.stdout.trim() : null
}

export function headCommit(wt: string): string | null {
  const r = git(wt, ["rev-parse", "--verify", "-q", "HEAD"])
  return r.code === 0 ? r.stdout.trim() : null
}

let seq = 0

/**
 * Tree id of the work tree as it is now: tracked files plus untracked,
 * non-ignored files. Built in a throwaway index; never touches the real
 * index or the work tree (SPEC §3.5).
 */
export function worktreeTree(wt: string, tmpDir: string): string {
  mkdirSync(tmpDir, { recursive: true })
  const idx = join(tmpDir, `index-${process.pid}-${++seq}`)
  try {
    const real = gitOk(wt, ["rev-parse", "--git-path", "index"]).trim()
    const realPath = isAbsolute(real) ? real : resolve(wt, real)
    const env = { GIT_INDEX_FILE: idx }
    if (existsSync(realPath)) {
      // Keep the real index's timestamps on the copy. Git treats an entry whose
      // mtime isn't older than the index file as "racily clean" and rehashes it;
      // a fresh mtime on the copy would make git trust stale stat data and miss
      // a same-size edit made in the same second.
      copyFileSync(realPath, idx)
      const st = statSync(realPath)
      utimesSync(idx, st.atime, st.mtime)
    } else gitOk(wt, ["read-tree", "--empty"], env)
    gitOk(wt, ["add", "-A", "--", "."], env)
    return gitOk(wt, ["write-tree"], env).trim()
  } finally {
    rmSync(idx, { force: true })
  }
}

export interface Snapshot {
  commit: string
  tree: string
}

/** Stores `tree` as a commit under `ref` so it survives gc. */
export function storeSnapshot(wt: string, tree: string, ref: string, message: string): Snapshot {
  const head = headCommit(wt)
  const commit = gitOk(wt, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message]).trim()
  gitOk(wt, ["update-ref", ref, commit])
  return { commit, tree }
}

export function snapshot(wt: string, tmpDir: string, ref: string, message: string): Snapshot {
  return storeSnapshot(wt, worktreeTree(wt, tmpDir), ref, message)
}

export interface Change {
  status: string
  path: string
}

/** Paths that differ between two trees (no rename detection). */
export function diffTrees(wt: string, from: string, to: string): Change[] {
  const out = gitOk(wt, ["diff", "--no-renames", "--name-status", "-z", from, to])
  const parts = out.split("\0").filter((p) => p.length > 0)
  const changes: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i]!, path: parts[i + 1]! })
  return changes
}

/** Binary patch turning `from` into `to`. */
export function diffPatch(wt: string, from: string, to: string): string {
  return gitOk(wt, ["diff", "--binary", "--no-renames", "--full-index", from, to])
}

/**
 * Makes the work tree's tracked + untracked-non-ignored content equal
 * `target` (a tree or commit). Touches neither the index nor HEAD.
 * Returns the paths it changed.
 */
export function restoreWorktree(wt: string, tmpDir: string, target: string): string[] {
  const current = worktreeTree(wt, tmpDir)
  const changes = diffTrees(wt, target, current)
  const toRestore: string[] = []
  for (const c of changes) {
    if (c.status === "A") rmSync(join(wt, c.path), { force: true })
    else toRestore.push(c.path)
  }
  for (let i = 0; i < toRestore.length; i += 200) {
    const chunk = toRestore.slice(i, i + 200)
    for (const p of chunk) mkdirSync(dirname(join(wt, p)), { recursive: true })
    gitOk(wt, ["restore", `--source=${target}`, "--worktree", "--", ...chunk.map((p) => `:(literal)${p}`)])
  }
  return changes.map((c) => c.path)
}

/** Applies a patch to the work tree only (never the index). */
export function applyPatch(wt: string, patch: string): GitResult {
  if (!patch.trim()) return { code: 0, stdout: "", stderr: "" }
  return git(wt, ["apply", "--binary", "--whitespace=nowarn", "-"], undefined, patch)
}

export function deleteRefs(wt: string, prefix: string): void {
  const refs = git(wt, ["for-each-ref", "--format=%(refname)", prefix]).stdout.split("\n").filter(Boolean)
  for (const r of refs) git(wt, ["update-ref", "-d", r])
}

export function isIgnored(wt: string, relPath: string): boolean {
  return git(wt, ["check-ignore", "-q", "--no-index", "--", relPath]).code === 0
}
