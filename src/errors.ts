/** A deliberate rejection. Hooks rethrow these; any other error fails open. */
export class Rejection extends Error {
  constructor(message: string) {
    super(`[debug-harness] ${message}`)
    this.name = "Rejection"
  }
}

export interface Logger {
  warn(message: string): void
  error(message: string): void
}

export const silentLogger: Logger = { warn() {}, error() {} }
