import { describe, expect, it } from "vitest"
import { defaultBackoff, nextAttemptDelayMs, computeNextAttemptAt } from "./backoff.js"

describe("backoff", () => {
  it("default curve is 30s, 1m, 2m, 4m, 5m, 5m... (no jitter)", () => {
    const noJitter = { ...defaultBackoff, jitterFactor: 0 }
    const r = () => 0.5
    expect(nextAttemptDelayMs(1, noJitter, r)).toBe(30_000)
    expect(nextAttemptDelayMs(2, noJitter, r)).toBe(60_000)
    expect(nextAttemptDelayMs(3, noJitter, r)).toBe(120_000)
    expect(nextAttemptDelayMs(4, noJitter, r)).toBe(240_000)
    expect(nextAttemptDelayMs(5, noJitter, r)).toBe(300_000)
    expect(nextAttemptDelayMs(6, noJitter, r)).toBe(300_000)
  })

  it("jitter stays in [1-j, 1+j]", () => {
    const j = 0.25
    const cfg = { ...defaultBackoff, jitterFactor: j }
    for (let i = 1; i <= 4; i++) {
      const lo = nextAttemptDelayMs(i, cfg, () => 0)
      const hi = nextAttemptDelayMs(i, cfg, () => 1)
      const base = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(cfg.factor, i - 1))
      expect(lo).toBeGreaterThanOrEqual(Math.round(base * (1 - j)))
      expect(hi).toBeLessThanOrEqual(Math.round(base * (1 + j)))
    }
  })

  it("computeNextAttemptAt advances clock by the delay", () => {
    const now = new Date("2026-01-01T00:00:00Z")
    const cfg = { ...defaultBackoff, jitterFactor: 0 }
    const next = computeNextAttemptAt(now, 1, cfg, () => 0.5)
    expect(next.getTime() - now.getTime()).toBe(30_000)
  })

  it("attempts < 1 is treated as 1", () => {
    const cfg = { ...defaultBackoff, jitterFactor: 0 }
    expect(nextAttemptDelayMs(0, cfg, () => 0.5)).toBe(nextAttemptDelayMs(1, cfg, () => 0.5))
  })
})
