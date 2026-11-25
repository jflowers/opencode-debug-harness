import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { registerAssets } from "./assets"
import { loadConfig } from "./config"
import { type Logger, Rejection } from "./errors"
import { worktreeRoot } from "./git"
import { DebugHarness } from "./harness"
import { isSupervisorSideSession, registerLoad, releaseLoad } from "./shared-state"
import { addNote, type ToolOutput } from "./tool-output"
import { type ArgsOf, parseArgs, type Shape } from "./args"

export { DebugHarness } from "./harness"
export { Rejection } from "./errors"

const SERVICE = "debug-harness"

function makeLogger(client: PluginInput["client"] | undefined): Logger {
  const send = (level: "warn" | "error", message: string) => {
    try {
      void client?.app?.log?.({ body: { service: SERVICE, level, message } })?.catch?.(() => {})
    } catch {}
  }
  return { warn: (m) => send("warn", m), error: (m) => send("error", m) }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs a hook body: rejections propagate, anything else is logged and swallowed. */
async function failOpen<T>(log: Logger, hook: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof Rejection) throw err
    log.error(`${hook}: ${errorText(err)}`)
    return undefined
  }
}

function toolError(err: unknown): string {
  return err instanceof Rejection ? err.message : `[debug-harness] error: ${errorText(err)}`
}

async function guarded(fn: () => Promise<string> | string): Promise<string> {
  try {
    return await fn()
  } catch (err) {
    return toolError(err)
  }
}

function sessionIdOf(messages: { info?: { sessionID?: unknown } }[]): string | undefined {
  for (const m of messages) if (typeof m?.info?.sessionID === "string") return m.info.sessionID
  return undefined
}

type ToolContext = Parameters<Parameters<typeof tool>[0]["execute"]>[1]

/** `tool()` with schema validation (see parseArgs) and rejections returned as text. */
function def<A extends Shape>(spec: { description: string; args: A; run(args: ArgsOf<A>, ctx: ToolContext): Promise<string> | string }) {
  return tool({
    description: spec.description,
    args: spec.args,
    execute: (raw, ctx) => guarded(() => spec.run(parseArgs(spec.args, raw), ctx)),
  })
}

let injectSeq = 0

/** Builds the hooks for one work tree. Exported for tests. */
export function createHarness(h: DebugHarness): Hooks {
  const { log, config } = h
  const s = tool.schema
  const ignored = new Set<string>()
  const pendingNotes = new Map<string, string>()
  const isIgnored = (sessionID: string) => ignored.has(sessionID) || isSupervisorSideSession(sessionID)

  const env = s.record(s.string(), s.string()).optional()
  const reproSchema = s.object({
    cmd: s.string().min(1).describe("Smallest shell command that fails because of this bug (run with bash -c in the work tree)"),
    cwd: s.string().optional().describe("Repo-relative working directory"),
    env,
    timeoutSec: s.number().int().positive().optional(),
    failSignature: s.string().optional().describe("Regex matching the line that identifies THIS failure, e.g. an error message"),
    locks: s.array(s.string()).optional().describe("Repo-relative files experiments may not edit (the test files). Files named in cmd are locked automatically."),
  })
  const expectSchema = s.union([
    s.enum(["green", "red", "other"]),
    s.object({ outputMatches: s.string().describe("Regex the repro output will match") }),
    s.object({ outputLacks: s.string().describe("Regex the repro output will no longer match") }),
  ])

  return {
    config: async (opencodeConfig) => registerAssets(opencodeConfig),
    tool: {
      debug_open: def({
        description:
          "Open a debugging investigation: lock a repro command, run it several times on the untouched tree, and record the baseline failure fingerprint. After this, edits are only allowed inside experiments.",
        args: {
          symptom: s.string().min(5).describe("What is wrong, in one sentence"),
          repro: reproSchema,
          guard: s
            .object({ cmd: s.string().min(1), cwd: s.string().optional(), env, timeoutSec: s.number().int().positive().optional() })
            .optional()
            .describe("Pass-to-pass check, e.g. the test suite; must be no worse after a fix"),
        },
        run: (args, ctx) => h.open(ctx.sessionID, args),
      }),
      debug_attach: def({
        description: "Attach this session to the investigation already open in this work tree (e.g. after a crash or a new session).",
        args: {},
        run: (_a, ctx) => h.attach(ctx.sessionID),
      }),
      debug_refine_repro: def({
        description: "Replace the repro (narrower command, better failSignature). Re-runs the baseline and re-derives the fingerprint. Only between experiments.",
        args: { repro: reproSchema, reason: s.string().min(5) },
        run: (args, ctx) => h.refineRepro(ctx.sessionID, args.repro, args.reason),
      }),
      debug_hypothesize: def({
        description:
          "Record a hypothesis with a mechanism and a prediction the repro can check. The harness, not you, sets its status from experiment results.",
        args: {
          statement: s.string().min(10).describe("What you think is causing the failure"),
          mechanism: s.string().min(10).describe("How that cause produces the observed failure"),
          prediction: s.object({
            intervention: s.string().min(5).describe("The single change the experiment will make"),
            expect: expectSchema.describe("What the repro will show after that change"),
          }),
          falsifier: s.string().min(5).describe("Which observation would show this hypothesis is wrong"),
        },
        run: (args, ctx) => h.hypothesize(ctx.sessionID, args),
      }),
      debug_hypothesis_note: def({
        description: "Append an interpretation note to a hypothesis without changing its status.",
        args: { hypothesis_id: s.string(), text: s.string().min(3) },
        run: (args, ctx) => h.note(ctx.sessionID, args.hypothesis_id, args.text),
      }),
      debug_experiment_start: def({
        description:
          "Open an experiment for one hypothesis. Snapshots nothing new: experiments always start from the baseline. Edits are then allowed only inside `scope`.",
        args: {
          hypothesis_id: s.string(),
          kind: s.enum(["intervention", "probe", "toggle"]).describe("intervention: change predicted to flip the outcome; probe: instrumentation; toggle: remove the suspected cause"),
          scope: s.array(s.string()).min(1).describe("Repo-relative path globs this experiment may edit"),
          touches: s
            .array(s.object({ what: s.string(), reset: s.string().optional().describe("Command that restores it"), paths: s.array(s.string()).optional().describe("Gitignored files to snapshot") }))
            .optional()
            .describe("State outside git that this experiment changes (database, .env, services) and how to reset it"),
        },
        run: (args, ctx) => h.start(ctx.sessionID, args),
      }),
      debug_run: def({
        description: "Run the repro now (harness-observed) and get the outcome, fingerprint, last lines and a log_ref. Optionally run the guard too.",
        args: { guard: s.boolean().optional() },
        run: (args, ctx) => h.run(ctx.sessionID, args.guard ?? false),
      }),
      debug_experiment_end: def({
        description:
          "End the open experiment: the harness runs the repro, compares it with the prediction, saves the patch, resets the tree to the baseline and verifies the repro is red again.",
        args: { interpretation: s.string().min(5).describe("What you make of the observation") },
        run: (args, ctx) => h.end(ctx.sessionID, args.interpretation),
      }),
      debug_experiment_abort: def({
        description: "Abandon the open experiment without a verdict and reset to the baseline.",
        args: { reason: s.string().min(3) },
        run: (args, ctx) => h.abort(ctx.sessionID, args.reason),
      }),
      debug_reset: def({
        description: "Retry resetting the work tree to the baseline and verifying it (after a failed reset).",
        args: { confirm: s.boolean().optional().describe("Discard changes the experiment didn't make") },
        run: (args, ctx) => h.reset(ctx.sessionID, args.confirm ?? false),
      }),
      debug_rebaseline: def({
        description:
          "Make a past experiment's change (e.g. instrumentation) part of the baseline, or accept a diverged tree as the baseline. The repro must still be red.",
        args: { reason: s.string().min(5), from_experiment: s.string().optional() },
        run: (args, ctx) => h.rebaseline(ctx.sessionID, args.reason, args.from_experiment),
      }),
      debug_conclude: def({
        description:
          "Conclude. fixed: the harness proves the fix by toggling it (red → green → red → green, guard no worse) and leaves it applied. understood: needs a supported hypothesis. abandoned: always allowed.",
        args: {
          kind: s.enum(["fixed", "understood", "abandoned"]),
          summary: s.string().min(10),
          root_cause: s.string().optional(),
          hypothesis_ids: s.array(s.string()).optional(),
          fix_experiment: s.string().optional().describe("For fixed: the supported intervention experiment"),
        },
        run: (args, ctx) => h.conclude(ctx.sessionID, args),
      }),
      debug_status: def({
        description: "Show the investigation: repro, fingerprint, hypotheses, experiments and the next allowed step.",
        args: {},
        run: (_a, ctx) => h.status(ctx.sessionID),
      }),
      debug_close: def({
        description: "Close the investigation as abandoned from any state. By default restores the work tree to how it was at debug_open.",
        args: { reason: s.string().min(5), restore: s.boolean().optional() },
        run: (args, ctx) => h.close(ctx.sessionID, args.reason, args.restore ?? true),
      }),
    },

    event: async ({ event }) => {
      await failOpen(log, "event", () => {
        const e = event as { type: string; properties?: { info?: { id?: string; parentID?: string; title?: string } } }
        const info = e.properties?.info
        if (!info?.id || e.type !== "session.created") return
        if (info.title && config.ignoreSessionTitlePrefixes.some((p) => info.title!.startsWith(p))) {
          ignored.add(info.id)
          return
        }
        if (isSupervisorSideSession(info.id)) return
        if (info.parentID) h.inheritSession(info.id, info.parentID)
      })
    },

    "command.execute.before": async (input, output) => {
      await failOpen(log, "command.execute.before", () => {
        if (input.command !== "debug" || isIgnored(input.sessionID)) return
        const inv = h.active(input.sessionID)
        const symptom = (input.arguments ?? "").trim()
        const text = inv
          ? `[debug-harness] An investigation is already open; continue it.\n${h.statusText(inv)}`
          : `[debug-harness] Start a debugging investigation${symptom ? ` for: ${symptom}` : ""}.\nLoad the debug-loop skill. First write the smallest command that reproduces the failure (exits non-zero because of this bug), then call debug_open with it. Do not edit any code before debug_open succeeds.`
        const parts = output.parts as { type: string; text?: string }[]
        const first = parts.find((p) => p.type === "text")
        if (first) {
          first.text = text
          output.parts = [first as (typeof output.parts)[number]]
        } else {
          output.parts.push({ type: "text", text } as unknown as (typeof output.parts)[number])
        }
      })
    },

    "tool.execute.before": async (input, output) => {
      await failOpen(log, "tool.execute.before", () => {
        if (isIgnored(input.sessionID)) return
        const args = (output.args ?? {}) as Record<string, unknown>
        let note: string | null = null
        if (config.editTools.includes(input.tool)) note = h.checkEdit(input.sessionID, input.tool, args)
        else if (input.tool === "bash" && typeof args.command === "string") note = h.checkBash(input.sessionID, args.command)
        if (note) pendingNotes.set(input.callID, note)
      })
    },

    "tool.execute.after": async (input, output) => {
      await failOpen(log, "tool.execute.after", () => {
        const note = pendingNotes.get(input.callID)
        if (!note) return
        pendingNotes.delete(input.callID)
        addNote(output as unknown as ToolOutput, note, "end")
      })
    },

    "shell.env": async (input, output) => {
      await failOpen(log, "shell.env", () => {
        if (!input.sessionID) return
        const inv = h.active(input.sessionID)
        if (!inv) return
        output.env.DEBUG_HARNESS_INVESTIGATION = inv.id
        if (inv.openExperiment) output.env.DEBUG_HARNESS_EXPERIMENT = inv.openExperiment
      })
    },

    "experimental.session.compacting": async (input, output) => {
      await failOpen(log, "experimental.session.compacting", () => {
        const inv = h.active(input.sessionID)
        if (inv) output.context.push(`Debug investigation state (authoritative; from the debug harness):\n${h.statusText(inv)}`)
      })
    },

    // OpenCode 1.19.0 discards system-transform mutations; deliver per turn here.
    "experimental.chat.messages.transform": async (_input, output) => {
      await failOpen(log, "experimental.chat.messages.transform", () => {
        const msgs = Array.isArray(output?.messages) ? output.messages : undefined
        if (!msgs?.length) return
        const sessionID = sessionIdOf(msgs as { info?: { sessionID?: unknown } }[])
        if (!sessionID || isIgnored(sessionID)) return
        const header = h.header(sessionID)
        if (!header) return
        msgs.push({
          info: { id: `debug-harness-status-${++injectSeq}`, sessionID, role: "user", time: { created: Date.now() } },
          parts: [{ type: "text", text: `${header}\n(plugin context, not user input)` }],
        } as unknown as (typeof msgs)[number])
      })
    },

    dispose: async () => {
      try {
        h.db.close()
      } catch {}
    },
  }
}

const server: Plugin = async (input, options) => {
  const log = makeLogger(input.client)
  try {
    const worktree = worktreeRoot(input.directory) ?? input.worktree ?? input.directory
    const config = loadConfig(worktree, options)
    const others = registerLoad(input.directory, import.meta.url)
    if (others.length) {
      log.warn(
        `opencode-debug-harness is loaded more than once for ${input.directory} (already running from ${others.join(", ")}; skipping ${import.meta.url}). Remove the duplicate plugin entry.`,
      )
      return {}
    }
    const hooks = createHarness(new DebugHarness(worktree, input.directory, config, log))
    const dispose = hooks.dispose
    hooks.dispose = async () => {
      await dispose?.()
      releaseLoad(input.directory, import.meta.url)
    }
    return hooks
  } catch (err) {
    log.error(`plugin start failed, harness disabled: ${errorText(err)}`)
    return {}
  }
}

export default { id: "debug-harness", server } satisfies PluginModule
