import { tool } from "@opencode-ai/plugin"
import { Rejection } from "./errors"

export type Shape = Parameters<typeof tool>[0]["args"]
export type ArgsOf<A extends Shape> = Parameters<Parameters<typeof tool<A>>[0]["execute"]>[0]

type Path = PropertyKey[]

function getAt(root: unknown, path: Path): unknown {
  let v: unknown = root
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined
    v = (v as Record<PropertyKey, unknown>)[k]
  }
  return v
}

function setAt(root: Record<PropertyKey, unknown>, path: Path, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1)) as Record<PropertyKey, unknown>
  parent[path[path.length - 1]!] = value
}

/**
 * Validates tool args against their schema. opencode 1.19.0 hands args to
 * `execute` without validating them, and some models send an object or array
 * argument as a JSON-encoded string. Strings that fail validation where JSON is
 * expected are decoded and checked again; anything still wrong is rejected with
 * the schema's own messages.
 */
export function parseArgs<A extends Shape>(shape: A, raw: unknown): ArgsOf<A> {
  const schema = tool.schema.object(shape)
  const value: Record<PropertyKey, unknown> = raw && typeof raw === "object" ? structuredClone(raw as object) as Record<PropertyKey, unknown> : {}
  for (let pass = 0; pass < 8; pass++) {
    const r = schema.safeParse(value)
    if (r.success) return r.data as ArgsOf<A>
    let decoded = false
    for (const issue of r.error.issues) {
      if (issue.path.length === 0) continue
      const v = getAt(value, issue.path)
      if (typeof v !== "string" || !/^\s*[[{]/.test(v)) continue
      try {
        setAt(value, issue.path, JSON.parse(v))
        decoded = true
      } catch {}
    }
    if (!decoded) {
      const issues = r.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ")
      throw new Rejection(`Invalid arguments. ${issues}. Pass objects and arrays as JSON values, not strings.`)
    }
  }
  throw new Rejection("Invalid arguments: too deeply JSON-encoded.")
}
