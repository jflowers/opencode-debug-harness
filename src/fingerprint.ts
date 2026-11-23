/** Failure fingerprints and outcome classification (FR-O4, FR-O5). */

export type Classification = "red" | "green" | "other"

const ERRORISH = /\b(error|exception|panic|fail(?:ed|ure|s)?|assert(?:ion)?|traceback|fatal|segmentation fault|undefined is not|cannot read)\b/i

/** Replaces run-to-run noise so the same failure normalizes to the same text. */
export function normalizeLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI colour
    .replace(/(\.[a-zA-Z]{1,5}):\d+(?::\d+)?/g, "$1:<line>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
    .replace(/\b0x[0-9a-fA-F]+\b/g, "<hex>")
    .replace(/\b[0-9a-f]{12,64}\b/g, "<hash>")
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s:'")]+/g, "<tmp>")
    .replace(/\b(pid|PID|port)[=: ]+\d+/g, "$1=<n>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|µs|us|ns|sec|secs|seconds)\b/g, "<dur>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}

/** The line that identifies this failure: the first `failSignature` match, else the first error-looking line. */
export function signatureLine(output: string, failSignature?: string | null): string | null {
  const lines = output.split("\n")
  if (failSignature) {
    const re = new RegExp(failSignature)
    for (const l of lines) if (re.test(l)) return l.trim()
    return null
  }
  for (const l of lines) if (ERRORISH.test(l)) return l.trim()
  return null
}

export function fingerprintOf(exit: number | null, sig: string | null): string {
  return `exit=${exit ?? "none"} sig=${sig ? normalizeLine(sig) : "-"}`
}

export interface RawRun {
  exit: number | null
  timedOut: boolean
  output: string
}

/**
 * red   = fails with the baseline fingerprint
 * green = exits 0 and the signature is absent
 * other = anything else (fails differently, times out, exits 0 but still prints the signature)
 * With no baseline yet (`debug_open`), every failing run counts as red here;
 * the caller groups them by fingerprint.
 */
export function classify(run: RawRun, failSignature: string | null | undefined, baseline: string | null): {
  classification: Classification
  fingerprint: string
  signature: string | null
} {
  const sig = signatureLine(run.output, failSignature)
  const fingerprint = run.timedOut ? "timeout" : fingerprintOf(run.exit, sig)
  if (run.timedOut) return { classification: "other", fingerprint, signature: sig }
  if (run.exit === 0) {
    return { classification: failSignature && sig ? "other" : "green", fingerprint, signature: sig }
  }
  if (baseline === null || fingerprint === baseline) return { classification: "red", fingerprint, signature: sig }
  return { classification: "other", fingerprint, signature: sig }
}

/**
 * One verdict from several runs. Deterministic: every run must agree, or it's `other`.
 * Flaky (FR-O6): any red → red; all green → green; else other.
 */
export function aggregate(classes: Classification[], flaky: boolean): Classification {
  if (classes.length === 0) return "other"
  if (classes.every((c) => c === "green")) return "green"
  if (flaky) return classes.includes("red") ? "red" : "other"
  return classes.every((c) => c === "red") ? "red" : "other"
}
