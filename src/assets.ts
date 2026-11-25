import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The package root: agents/, commands/ and skills/ sit next to src/. */
export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")

type Entry = Record<string, unknown>

/** Splits a markdown file into its YAML frontmatter and its body. */
export function parseMarkdown(text: string): { meta: Entry; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta = Bun.YAML.parse(m[1]!)
  return { meta: isPlainObject(meta) ? meta : {}, body: m[2]!.trim() }
}

function isPlainObject(v: unknown): v is Entry {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f))
}

/**
 * Adds `bundled` under `name`. An entry the user already has wins field by
 * field, so a config that only narrows `debugger`'s permissions keeps the
 * bundled prompt (how opencode itself layers opencode.json over a markdown
 * agent of the same name).
 */
function layer(map: Record<string, unknown>, name: string, bundled: Entry): void {
  const existing = map[name]
  if (existing === undefined || existing === null) map[name] = bundled
  else if (isPlainObject(existing)) map[name] = { ...bundled, ...existing }
}

/**
 * Registers what the package ships, so it loads wherever the plugin does (npm
 * or a checkout) with nothing to link into ~/.config/opencode:
 * - skills/ on opencode's `skills.paths` (not in the SDK's Config type yet,
 *   but read at runtime);
 * - agents/<name>.md as agent <name>, the body as its prompt;
 * - commands/<name>.md as command /<name>, the body as its template.
 */
export function registerAssets(config: object, dir: string = PACKAGE_DIR): void {
  const cfg = config as { skills?: { paths?: string[] }; agent?: Record<string, unknown>; command?: Record<string, unknown> }

  const skills = join(dir, "skills")
  if (existsSync(skills)) {
    cfg.skills ??= {}
    cfg.skills.paths ??= []
    if (!cfg.skills.paths.includes(skills)) cfg.skills.paths.push(skills)
  }

  for (const file of markdownFiles(join(dir, "agents"))) {
    const { meta, body } = parseMarkdown(readFileSync(file, "utf8"))
    cfg.agent ??= {}
    layer(cfg.agent, basename(file, ".md"), { ...meta, prompt: body })
  }

  for (const file of markdownFiles(join(dir, "commands"))) {
    const { meta, body } = parseMarkdown(readFileSync(file, "utf8"))
    cfg.command ??= {}
    layer(cfg.command, basename(file, ".md"), { ...meta, template: body })
  }
}
