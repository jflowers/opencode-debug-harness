import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { PACKAGE_DIR, parseMarkdown, registerAssets } from "../src/assets"

type Config = {
  skills?: { paths?: string[] }
  agent?: Record<string, Record<string, unknown>>
  command?: Record<string, Record<string, unknown>>
}

describe("parseMarkdown", () => {
  test("splits frontmatter from the body", () => {
    const { meta, body } = parseMarkdown("---\ndescription: >\n  two\n  lines\nmode: primary\n---\n\nHello.\n")
    expect(meta).toEqual({ description: "two lines\n", mode: "primary" })
    expect(body).toBe("Hello.")
  })

  test("a file without frontmatter is all body", () => {
    expect(parseMarkdown("just text\n")).toEqual({ meta: {}, body: "just text" })
  })
})

describe("registerAssets", () => {
  test("registers the bundled skill dir, debugger agent and /debug command", () => {
    const config: Config = {}
    registerAssets(config)
    expect(config.skills?.paths).toEqual([join(PACKAGE_DIR, "skills")])

    const agent = config.agent?.debugger
    expect(agent?.mode).toBe("primary")
    expect((agent?.tools as Record<string, boolean>)["debug_*"]).toBe(true)
    expect(agent?.prompt).toStartWith("You are a debugger.")

    const command = config.command?.debug
    expect(command?.agent).toBe("debugger")
    expect(command?.template).toContain("$ARGUMENTS")
  })

  test("is idempotent and keeps the user's own entries", () => {
    const config: Config = {
      skills: { paths: ["/mine"] },
      agent: { debugger: { model: "my/model" }, build: { model: "x" } },
      command: { other: { template: "y" } },
    }
    registerAssets(config)
    registerAssets(config)
    expect(config.skills?.paths).toEqual(["/mine", join(PACKAGE_DIR, "skills")])
    expect(config.agent?.debugger?.model).toBe("my/model")
    expect(config.agent?.debugger?.prompt).toStartWith("You are a debugger.")
    expect(config.agent?.build).toEqual({ model: "x" })
    expect(config.command?.other).toEqual({ template: "y" })
  })
})
