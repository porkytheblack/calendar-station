import type { BackoffConfig } from "./types.js"

export const defaultBackoff: BackoffConfig = {
  baseMs: 30_000,
  factor: 2,
  maxMs: 5 * 60_000,
  jitterFactor: 0.25,
}

/**
 * Compute the next attempt delay in ms.
 * `attempts` is the number of attempts already made (1-based after the first failure).
 * Curve with defaults: 30s, 1m, 2m, 4m, 5m, 5m, ...
 */
export const nextAttemptDelayMs = (
  attempts: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): number => {
  if (attempts < 1) attempts = 1
  const exp = config.baseMs * Math.pow(config.factor, attempts - 1)
  const capped = Math.min(config.maxMs, exp)
  const j = config.jitterFactor
  const jitter = 1 - j + random() * 2 * j
  return Math.max(0, Math.round(capped * jitter))
}

export const computeNextAttemptAt = (
  now: Date,
  attempts: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): Date => new Date(now.getTime() + nextAttemptDelayMs(attempts, config, random))
