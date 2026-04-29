import { describe, expect, it } from "vitest"
import {
  CalendarAccountId as makeAccountId,
  CalendarEventId as makeEventId,
  JobId as makeJobId,
} from "./ids.js"
import { ok, err } from "./result.js"
import { startWorker } from "./worker.js"
import type {
  CalendarEvent,
  CalendarEventHandlerFn,
  ClaimedJob,
  ResolvedWorkerConfig,
  StoreAdapter,
  StoreError,
} from "./types.js"

const t0 = new Date("2026-01-01T00:00:00Z")
const accountId = makeAccountId("acc-1")

const event = (id: string): CalendarEvent => ({
  eventId: makeEventId(id),
  icalUid: `uid-${id}`,
  accountId,
  provider: "google-calendar",
  calendarId: "primary",
  summary: id,
  description: "",
  location: null,
  status: "confirmed",
  htmlLink: null,
  start: { dateTime: t0, date: null, timeZone: "UTC" },
  end: { dateTime: t0, date: null, timeZone: "UTC" },
  allDay: false,
  creator: null,
  organizer: null,
  attendees: [],
  recurrence: [],
  recurringEventId: null,
  originalStartTime: null,
  conference: null,
  hangoutLink: null,
  createdAt: null,
  updatedAt: null,
  etag: null,
  sequence: 0,
})

const claimed = (id: string, attempts = 0): ClaimedJob => ({
  job: {
    jobId: makeJobId(`j-${id}`),
    eventId: makeEventId(id),
    accountId,
    state: "pending",
    attempts,
    lastError: null,
    nextAttemptAt: t0,
    claimedAt: t0,
    claimedBy: "w1",
    leaseExpiresAt: new Date(t0.getTime() + 60_000),
    createdAt: t0,
    completedAt: null,
  },
  event: event(id),
})

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const cfg = (overrides: Partial<ResolvedWorkerConfig> = {}): ResolvedWorkerConfig => ({
  workerId: "w-test",
  triggerConcurrency: 2,
  claimBatchSize: 4,
  leaseDurationMs: 60_000,
  idlePollIntervalMs: 1,
  maxAttempts: 3,
  backoff: { baseMs: 100, factor: 2, maxMs: 1000, jitterFactor: 0 },
  clock: () => t0,
  random: () => 0.5,
  ...overrides,
})

const stubStore = (overrides: Partial<StoreAdapter>): StoreAdapter => ({
  createAccount: async () => err({ _tag: "Permanent", message: "n/a" }),
  getAccount: async () => err({ _tag: "AccountNotFound", accountId }),
  getAccountByChannelId: async () => err({ _tag: "AccountNotFound" }),
  getAccountByCalendar: async () => err({ _tag: "AccountNotFound" }),
  updateAccount: async () => err({ _tag: "Permanent", message: "n/a" }),
  listAccountsExpiringChannel: async () => ok([]),
  commitEvents: async () => err({ _tag: "Permanent", message: "n/a" }),
  claimTriggerJobs: async () => ok([]),
  markTriggerDone: async () => ok(undefined),
  markTriggerFailed: async () => ok(undefined),
  ...overrides,
})

describe("worker", () => {
  it("runs a successful job and marks done", async () => {
    let claimedCount = 0
    const doneCalls: string[] = []
    const store = stubStore({
      claimTriggerJobs: async () => {
        claimedCount++
        if (claimedCount === 1) return ok([claimed("a"), claimed("b")])
        return ok([])
      },
      markTriggerDone: async (jobId) => {
        doneCalls.push(jobId)
        return ok(undefined)
      },
    })
    const handler: CalendarEventHandlerFn = async () => ok(undefined)
    const handle = startWorker({ store, handler, config: cfg(), logger: noopLogger })
    await new Promise((r) => setTimeout(r, 30))
    handle.stop()
    await handle.done
    expect(doneCalls).toEqual(["j-a", "j-b"])
  })

  it("transient handler error schedules retry", async () => {
    let claimedCount = 0
    const failedCalls: Array<{ nextAttemptAt: Date | null }> = []
    const store = stubStore({
      claimTriggerJobs: async () => {
        claimedCount++
        if (claimedCount === 1) return ok([claimed("a", 0)])
        return ok([])
      },
      markTriggerFailed: async (_id, _err, nextAttemptAt) => {
        failedCalls.push({ nextAttemptAt })
        return ok(undefined)
      },
    })
    const handler: CalendarEventHandlerFn = async () =>
      err({ _tag: "Transient", message: "blip" })
    const handle = startWorker({ store, handler, config: cfg(), logger: noopLogger })
    await new Promise((r) => setTimeout(r, 30))
    handle.stop()
    await handle.done
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]!.nextAttemptAt).not.toBeNull()
  })

  it("permanent handler error dead-letters immediately", async () => {
    let claimedCount = 0
    const failedCalls: Array<{ nextAttemptAt: Date | null }> = []
    const store = stubStore({
      claimTriggerJobs: async () => {
        claimedCount++
        if (claimedCount === 1) return ok([claimed("a", 0)])
        return ok([])
      },
      markTriggerFailed: async (_id, _err, nextAttemptAt) => {
        failedCalls.push({ nextAttemptAt })
        return ok(undefined)
      },
    })
    const handler: CalendarEventHandlerFn = async () =>
      err({ _tag: "Permanent", message: "auth gone" })
    const handle = startWorker({ store, handler, config: cfg(), logger: noopLogger })
    await new Promise((r) => setTimeout(r, 30))
    handle.stop()
    await handle.done
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]!.nextAttemptAt).toBeNull()
  })

  it("dead-letters when attempt >= maxAttempts on transient", async () => {
    let claimedCount = 0
    const failedCalls: Array<{ nextAttemptAt: Date | null }> = []
    const store = stubStore({
      claimTriggerJobs: async () => {
        claimedCount++
        if (claimedCount === 1) return ok([claimed("a", 2)])
        return ok([])
      },
      markTriggerFailed: async (_id, _err, nextAttemptAt) => {
        failedCalls.push({ nextAttemptAt })
        return ok(undefined)
      },
    })
    const handler: CalendarEventHandlerFn = async () =>
      err({ _tag: "Transient", message: "blip" })
    const handle = startWorker({
      store,
      handler,
      config: cfg({ maxAttempts: 3 }),
      logger: noopLogger,
    })
    await new Promise((r) => setTimeout(r, 30))
    handle.stop()
    await handle.done
    expect(failedCalls[0]!.nextAttemptAt).toBeNull()
  })

  it("uncaught throw inside handler is treated as Transient", async () => {
    let claimedCount = 0
    const failedCalls: Array<{ nextAttemptAt: Date | null }> = []
    const store = stubStore({
      claimTriggerJobs: async () => {
        claimedCount++
        if (claimedCount === 1) return ok([claimed("a", 0)])
        return ok([])
      },
      markTriggerFailed: async (_id, _err, nextAttemptAt) => {
        failedCalls.push({ nextAttemptAt })
        return ok(undefined)
      },
    })
    const handler: CalendarEventHandlerFn = (async () => {
      throw new Error("oops")
    }) as unknown as CalendarEventHandlerFn
    const handle = startWorker({ store, handler, config: cfg(), logger: noopLogger })
    await new Promise((r) => setTimeout(r, 30))
    handle.stop()
    await handle.done
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]!.nextAttemptAt).not.toBeNull()
  })

  it("recovers from transient claim failures", async () => {
    let calls = 0
    const store = stubStore({
      claimTriggerJobs: async () => {
        calls++
        if (calls === 1) return err<StoreError>({ _tag: "Transient", message: "db blip" })
        return ok([])
      },
    })
    const handler: CalendarEventHandlerFn = async () => ok(undefined)
    const handle = startWorker({ store, handler, config: cfg(), logger: noopLogger })
    await new Promise((r) => setTimeout(r, 20))
    handle.stop()
    await handle.done
    expect(calls).toBeGreaterThanOrEqual(1)
  })
})
