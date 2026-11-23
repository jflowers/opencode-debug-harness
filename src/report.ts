import type { Experiment, Hypothesis, Investigation, ProofStep, RunRecord } from "./db"

function cell(s: string | null | undefined): string {
  return (s ?? "").replace(/\|/g, "/").replace(/\n/g, " ")
}

function expectText(h: Hypothesis): string {
  const e = h.prediction.expect
  if (typeof e === "string") return e
  return "outputMatches" in e ? `output matches \`/${e.outputMatches}/\`` : `output lacks \`/${e.outputLacks}/\``
}

/** FR-R2: the conclusion report. */
export function renderReport(
  inv: Investigation,
  hypotheses: Hypothesis[],
  experiments: Experiment[],
  runs: RunRecord[],
  proofTable: (s: ProofStep[]) => string,
): string {
  const c = inv.conclusion
  const out: string[] = [
    `# Debug report: ${inv.symptom}`,
    "",
    `- **Investigation:** \`${inv.id}\``,
    `- **Work tree:** \`${inv.worktree}\``,
    `- **Outcome:** ${c ? c.kind.toUpperCase() : "open"}${c?.evidence ? ` — ${c.evidence}` : ""}`,
    `- **Opened:** ${inv.createdAt}  **Closed:** ${c?.at ?? "—"}`,
    "",
    "## Summary",
    "",
    c?.summary ?? "",
    "",
  ]
  if (c?.rootCause) out.push("## Root cause", "", c.rootCause, "")
  out.push(
    "## Reproduction",
    "",
    "```bash",
    inv.repro.cmd,
    "```",
    "",
    `- Baseline fingerprint: \`${inv.fingerprint}\``,
    `- ${inv.flaky ? `Flaky: baseline red rate ${Math.round(inv.baselineRate * 100)}%` : "Deterministic at baseline"}`,
    `- Locked files: ${inv.locks.map((l) => `\`${l.path}\``).join(", ") || "none"}`,
    `- Guard: ${inv.guard ? `\`${inv.guard.cmd}\` (baseline ${inv.guardBaseline?.passed ? "pass" : "fail"})` : "none"}`,
    "",
  )
  if (c?.proof.length) out.push("## Toggle proof", "", proofTable(c.proof), "")
  out.push("## Hypotheses", "", "| Id | Statement | Mechanism | Prediction | Status |", "|---|---|---|---|---|")
  for (const h of hypotheses) {
    out.push(`| ${h.id} | ${cell(h.statement)} | ${cell(h.mechanism)} | ${cell(h.prediction.intervention)} → ${expectText(h)} | ${h.status} |`)
  }
  out.push("", "## Experiments", "", "| Id | Hypothesis | Kind | Scope | Edited | Observed | Verdict | Interpretation |", "|---|---|---|---|---|---|---|---|")
  for (const e of experiments) {
    const obs = runs.find((r) => r.id === e.observation)
    out.push(
      `| ${e.id} | ${e.hypothesisId} | ${e.kind} | ${cell(e.scope.join(", "))} | ${cell(e.edited.join(", "))}${e.bashCommands.length ? ` (+${e.bashCommands.length} shell)` : ""} | ${obs?.outcome ?? "—"} | ${e.verdict ?? "open"} | ${cell(e.interpretation)} |`,
    )
  }
  if (inv.rebaselines.length) {
    out.push("", "## Rebaselines", "")
    inv.rebaselines.forEach((r, i) => out.push(`${i + 1}. ${r.at}: ${r.reason}${r.fromExperiment ? ` (from ${r.fromExperiment})` : ""}`))
  }
  const untested = hypotheses.filter((h) => h.status === "open")
  if (untested.length) out.push("", "## Untested hypotheses", "", ...untested.map((h) => `- ${h.id}: ${h.statement}`))
  const patches = experiments.filter((e) => e.patchPath).map((e) => `- ${e.id}: \`${e.patchPath}\``)
  if (patches.length) out.push("", "## Patches", "", ...patches)
  return `${out.join("\n")}\n`
}
