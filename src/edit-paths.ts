import { isAbsolute, relative, resolve } from "node:path"

const PATH_KEYS = ["filePath", "file_path", "path", "file", "filename"]

/**
 * The files an edit tool call will write, as given in its args.
 * Returns null when they can't be determined (the guard then refuses the call).
 */
export function editTargets(args: Record<string, unknown>): string[] | null {
  const out = new Set<string>()
  for (const k of PATH_KEYS) {
    const v = args[k]
    if (typeof v === "string" && v.trim()) out.add(v.trim())
  }
  if (Array.isArray(args.edits)) {
    for (const e of args.edits as Record<string, unknown>[]) {
      for (const k of PATH_KEYS) if (typeof e?.[k] === "string") out.add(String(e[k]).trim())
    }
  }
  for (const key of ["patchText", "patch", "diff", "input"]) {
    const text = args[key]
    if (typeof text !== "string") continue
    for (const line of text.split("\n")) {
      const m =
        /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ??
        /^\*\*\* Move to: (.+)$/.exec(line) ??
        /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line) ??
        /^--- (?:a\/)?(.+?)(?:\t.*)?$/.exec(line)
      if (m && m[1] && m[1] !== "/dev/null") out.add(m[1].trim())
    }
  }
  return out.size ? [...out] : null
}

/** Repo-relative path, or null when `p` lies outside the work tree. */
export function toRepoRelative(worktree: string, cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(cwd, p)
  const rel = relative(worktree, abs)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  return rel.split("\\").join("/")
}

export function inScope(rel: string, scope: string[]): boolean {
  return scope.some((g) => {
    const glob = g.replace(/^\.\//, "")
    if (glob === "." || glob === "**" || glob === "**/*") return true
    if (rel === glob || rel.startsWith(glob.endsWith("/") ? glob : `${glob}/`)) return true
    return new Bun.Glob(glob).match(rel)
  })
}
