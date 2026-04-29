import { describe, expect, it } from "vitest"
import { resolveWorkerConfig } from "./config.js"

describe("resolveWorkerConfig", () => {
  it("applies defaults when nothing is provided", () => {
    const c = resolveWorkerConfig(undefined)
    expect(c.triggerConcurrency).toBe(8)
    expect(c.claimBatchSize).toBe(16)
    expect(c.leaseDurationMs).toBe(5 * 60_000)
    expect(c.idlePollIntervalMs).toBe(1_000)
    expect(c.maxAttempts).toBe(10)
    expect(c.backoff.baseMs).toBe(30_000)
  })

  it("user backoff overrides defaults but partial settings merge", () => {
    const c = resolveWorkerConfig({ backoff: { baseMs: 1000 } })
    expect(c.backoff.baseMs).toBe(1000)
    expect(c.backoff.maxMs).toBe(5 * 60_000)
  })

  it("rejects triggerConcurrency < 1", () => {
    expect(() => resolveWorkerConfig({ triggerConcurrency: 0 })).toThrow(/triggerConcurrency/)
  })

  it("rejects claimBatchSize < triggerConcurrency", () => {
    expect(() => resolveWorkerConfig({ triggerConcurrency: 8, claimBatchSize: 4 })).toThrow(
      /claimBatchSize/,
    )
  })
})
