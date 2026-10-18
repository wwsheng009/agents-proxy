export type RuntimeSnapshot = {
  consecutive403: number
  lastUpstreamStatus: number | null
  lastUpstreamLogId: string | null
  lastUpstreamCfRay: string | null
  last403At: string | null
  lastOkAt: string | null
}

const EMPTY: RuntimeSnapshot = {
  consecutive403: 0,
  lastUpstreamStatus: null,
  lastUpstreamLogId: null,
  lastUpstreamCfRay: null,
  last403At: null,
  lastOkAt: null,
}

/**
 * Tracks upstream results so /healthz can expose a run-state 403 streak.
 *
 * A 403 is only counted when the upstream body identifies it as
 * FreeTierError. Other 403s (for example malformed client requests) do not
 * change the streak.
 */
export class RuntimeState {
  private state: RuntimeSnapshot = { ...EMPTY }

  /**
   * True when the same Bun process has seen enough consecutive
   * FreeTierError responses that a restart should be considered.
   */
  shouldRecycle(threshold: number): boolean {
    return this.state.consecutive403 >= threshold
  }

  record(status: number, headers: Headers, errorType: string | null = null): void {
    this.state.lastUpstreamStatus = status

    const logId = headers.get("x-opencode-log-id")
    if (logId) this.state.lastUpstreamLogId = logId
    const cfRay = headers.get("cf-ray")
    if (cfRay) this.state.lastUpstreamCfRay = cfRay

    if (status >= 200 && status < 300) {
      this.state.consecutive403 = 0
      this.state.lastOkAt = new Date().toISOString()
      return
    }

    if (status === 403 && errorType === "FreeTierError") {
      this.state.consecutive403 += 1
      this.state.last403At = new Date().toISOString()
      return
    }

    // A 5xx means the request did not even reach the admission layer. Keeping
    // an older 403 streak here would leave /healthz degraded forever.
    if (status >= 500) this.state.consecutive403 = 0

    // Any other 4xx (e.g. 400/404) means the request reached the API but was
    // not an admission rejection. Do not carry a stale 403 streak forward.
    if (status >= 400 && status !== 403) this.state.consecutive403 = 0

    // 429 means admission succeeded and only the daily quota was hit.
    if (status === 429) this.state.consecutive403 = 0
  }

  snapshot(): RuntimeSnapshot {
    return { ...this.state }
  }
}
