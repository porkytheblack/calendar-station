import { computeNextAttemptAt } from "./backoff.js"
import { safeCall, transientHandlerError, transientStoreError } from "./shim.js"
import type {
  CalendarEventHandlerFn,
  ClaimedJob,
  ResolvedWorkerConfig,
  StationLogger,
  StoreAdapter,
} from "./types.js"

export type WorkerDeps = {
  readonly store: StoreAdapter
  readonly handler: CalendarEventHandlerFn
  readonly config: ResolvedWorkerConfig
  readonly logger: StationLogger
}

export type WorkerHandle = {
  /** Resolves once the loop has exited. */
  readonly done: Promise<void>
  /** Request graceful shutdown; in-flight handlers are awaited. */
  stop(): void
}

export const startWorker = (deps: WorkerDeps): WorkerHandle => {
  const { store, handler, config, logger } = deps
  let stopping = false
  let idleResolve: (() => void) | null = null

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        idleResolve = null
        resolve()
      }, ms)
      idleResolve = () => {
        clearTimeout(t)
        idleResolve = null
        resolve()
      }
    })

  const runOne = async (claimed: ClaimedJob): Promise<void> => {
    const start = Date.now()
    const attempt = claimed.job.attempts + 1
    logger.debug("trigger.claimed", {
      jobId: claimed.job.jobId,
      eventId: claimed.event.eventId,
      accountId: claimed.job.accountId,
      attempts: attempt,
    })

    const result = await safeCall(
      () =>
        handler(claimed.event, {
          jobId: claimed.job.jobId,
          accountId: claimed.job.accountId,
          attempt,
        }),
      transientHandlerError,
    )

    if (result.ok) {
      const done = await safeCall(
        () => store.markTriggerDone(claimed.job.jobId, config.clock()),
        transientStoreError,
      )
      if (!done.ok) {
        logger.error("trigger.done_persist_failed", {
          jobId: claimed.job.jobId,
          error: describe(done.error),
        })
        return
      }
      logger.info("trigger.succeeded", {
        jobId: claimed.job.jobId,
        durationMs: Date.now() - start,
      })
      return
    }

    const errStr = `${result.error._tag}: ${result.error.message}`

    if (result.error._tag === "Permanent") {
      const failed = await safeCall(
        () => store.markTriggerFailed(claimed.job.jobId, errStr, null, config.clock()),
        transientStoreError,
      )
      if (!failed.ok) {
        logger.error("trigger.fail_persist_failed", {
          jobId: claimed.job.jobId,
          error: describe(failed.error),
        })
      }
      logger.error("trigger.dead_lettered", {
        jobId: claimed.job.jobId,
        error: errStr,
        attempts: attempt,
      })
      return
    }

    if (attempt >= config.maxAttempts) {
      const failed = await safeCall(
        () => store.markTriggerFailed(claimed.job.jobId, errStr, null, config.clock()),
        transientStoreError,
      )
      if (!failed.ok) {
        logger.error("trigger.fail_persist_failed", {
          jobId: claimed.job.jobId,
          error: describe(failed.error),
        })
      }
      logger.error("trigger.dead_lettered", {
        jobId: claimed.job.jobId,
        error: errStr,
        attempts: attempt,
      })
      return
    }

    const nextAt = computeNextAttemptAt(config.clock(), attempt, config.backoff, config.random)
    const failed = await safeCall(
      () => store.markTriggerFailed(claimed.job.jobId, errStr, nextAt, config.clock()),
      transientStoreError,
    )
    if (!failed.ok) {
      logger.error("trigger.fail_persist_failed", {
        jobId: claimed.job.jobId,
        error: describe(failed.error),
      })
    }
    logger.warn("trigger.failed", {
      jobId: claimed.job.jobId,
      error: errStr,
      attempts: attempt,
      nextAttemptAt: nextAt.toISOString(),
    })
  }

  const runBatch = async (claimed: ReadonlyArray<ClaimedJob>): Promise<void> => {
    const queue = [...claimed]
    const workers: Array<Promise<void>> = []
    const concurrency = Math.max(1, config.triggerConcurrency)

    const next = async (): Promise<void> => {
      while (queue.length > 0) {
        const job = queue.shift()
        if (!job) return
        try {
          await runOne(job)
        } catch (cause) {
          logger.error("trigger.unexpected_error", {
            jobId: job.job.jobId,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }
    }

    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
      workers.push(next())
    }
    await Promise.all(workers)
  }

  const loop = async (): Promise<void> => {
    while (!stopping) {
      const claim = await safeCall(
        () =>
          store.claimTriggerJobs({
            workerId: config.workerId,
            limit: config.claimBatchSize,
            leaseDurationMs: config.leaseDurationMs,
            now: config.clock(),
          }),
        transientStoreError,
      )

      if (!claim.ok) {
        logger.warn("trigger.claim_failed", { error: describe(claim.error) })
        if (!stopping) await sleep(config.idlePollIntervalMs)
        continue
      }

      if (claim.value.length === 0) {
        if (!stopping) await sleep(config.idlePollIntervalMs)
        continue
      }

      await runBatch(claim.value)
    }
  }

  const done = loop().catch((cause) => {
    logger.error("worker.crashed", {
      error: cause instanceof Error ? cause.message : String(cause),
    })
  })

  return {
    done,
    stop: () => {
      stopping = true
      idleResolve?.()
    },
  }
}

const describe = (e: unknown): string => {
  if (e && typeof e === "object" && "_tag" in e) {
    const tag = (e as { _tag: string })._tag
    const msg = (e as { message?: string }).message ?? ""
    return `${tag}: ${msg}`
  }
  return e instanceof Error ? e.message : String(e)
}
