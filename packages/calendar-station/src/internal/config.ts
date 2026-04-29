import { hostname } from "node:os"
import { defaultBackoff } from "./backoff.js"
import type { ResolvedWorkerConfig, WorkerConfig } from "./types.js"

export const resolveWorkerConfig = (
  input: WorkerConfig | undefined,
): ResolvedWorkerConfig => {
  const c = input ?? {}
  const triggerConcurrency = c.triggerConcurrency ?? 8
  const claimBatchSize = c.claimBatchSize ?? 16
  if (triggerConcurrency < 1) {
    throw new Error(
      `createStation: triggerConcurrency must be >= 1, got ${triggerConcurrency}`,
    )
  }
  if (claimBatchSize < triggerConcurrency) {
    throw new Error(
      `createStation: claimBatchSize (${claimBatchSize}) must be >= triggerConcurrency (${triggerConcurrency})`,
    )
  }
  return {
    workerId: c.workerId ?? defaultWorkerId(),
    triggerConcurrency,
    claimBatchSize,
    leaseDurationMs: c.leaseDurationMs ?? 5 * 60_000,
    idlePollIntervalMs: c.idlePollIntervalMs ?? 1_000,
    maxAttempts: c.maxAttempts ?? 10,
    backoff: { ...defaultBackoff, ...c.backoff },
    clock: c.clock ?? (() => new Date()),
    random: c.random ?? Math.random,
  }
}

const defaultWorkerId = (): string => {
  let host: string
  try {
    host = hostname()
  } catch {
    host = "host"
  }
  const pid = typeof process !== "undefined" && process.pid ? process.pid : 0
  const rand = Math.random().toString(36).slice(2, 8)
  return `${host}-${pid}-${rand}`
}
