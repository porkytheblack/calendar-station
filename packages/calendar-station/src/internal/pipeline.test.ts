import { describe, expect, it } from "vitest"
import {
  CalendarAccountId as makeAccountId,
  CalendarEventId as makeEventId,
  ChannelId as makeChannelId,
  SyncToken as makeSyncToken,
  UserId as makeUserId,
} from "./ids.js"
import { ok, err } from "./result.js"
import { createPipeline } from "./pipeline.js"
import type {
  CalendarAccount,
  CalendarChangeEvent,
  CalendarChangeResolver,
  CalendarEvent,
  ResolverError,
  StoreAdapter,
  StoreError,
} from "./types.js"

const t0 = new Date("2026-01-01T00:00:00Z")

const stubLogger = () => {
  const log: Array<{
    level: string
    event: string
    fields: Record<string, unknown> | undefined
  }> = []
  return {
    log,
    logger: {
      debug: (event: string, fields?: Record<string, unknown>) =>
        log.push({ level: "debug", event, fields }),
      info: (event: string, fields?: Record<string, unknown>) =>
        log.push({ level: "info", event, fields }),
      warn: (event: string, fields?: Record<string, unknown>) =>
        log.push({ level: "warn", event, fields }),
      error: (event: string, fields?: Record<string, unknown>) =>
        log.push({ level: "error", event, fields }),
    },
  }
}

const accountId = makeAccountId("acc-1")
const userId = makeUserId("user-1")
const channelId = makeChannelId("ch-1")
const syncToken = makeSyncToken("st-1")

const stubAccount: CalendarAccount = {
  accountId,
  userId,
  provider: "google-calendar",
  calendarId: "primary",
  status: "active",
  credentials: {},
  syncToken: null,
  channelId,
  resourceId: "res-1",
  channelExpiresAt: null,
  createdAt: t0,
  updatedAt: t0,
}

const stubEvent: CalendarEvent = {
  eventId: makeEventId("e1"),
  icalUid: "uid-1",
  accountId,
  provider: "google-calendar",
  calendarId: "primary",
  summary: "hi",
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
}

const change: CalendarChangeEvent = {
  eventId: "ch-1::1",
  providerPayload: null,
  receivedAt: t0,
}

const stubStore = (
  overrides: Partial<StoreAdapter> = {},
): StoreAdapter & { calls: Record<string, number> } => {
  const calls = { commitEvents: 0, updateAccount: 0 }
  const base: StoreAdapter = {
    createAccount: async () => err({ _tag: "Permanent", message: "n/a" }),
    getAccount: async () => err({ _tag: "AccountNotFound", accountId }),
    getAccountByChannelId: async () => err({ _tag: "AccountNotFound", channelId }),
    getAccountByCalendar: async () => err({ _tag: "AccountNotFound" }),
    updateAccount: async () => {
      calls.updateAccount++
      return ok(stubAccount)
    },
    listAccountsExpiringChannel: async () => ok([]),
    commitEvents: async () => {
      calls.commitEvents++
      return ok({ committedEventIds: [stubEvent.eventId] })
    },
    claimTriggerJobs: async () => ok([]),
    markTriggerDone: async () => ok(undefined),
    markTriggerFailed: async () => ok(undefined),
  }
  return { ...base, ...overrides, calls } as StoreAdapter & {
    calls: Record<string, number>
  }
}

const makeResolver = (
  result: () => Promise<
    | {
        ok: true
        value: {
          accountId: typeof accountId
          events: ReadonlyArray<CalendarEvent>
          newSyncToken: typeof syncToken
        }
      }
    | { ok: false; error: ResolverError }
  >,
): CalendarChangeResolver => ({
  resolve: result,
})

describe("pipeline", () => {
  it("commits and acks on happy path", async () => {
    const { logger, log } = stubLogger()
    const store = stubStore()
    const resolver = makeResolver(async () =>
      ok({ accountId, events: [stubEvent], newSyncToken: syncToken }),
    )
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("ack")
    expect(store.calls.commitEvents).toBe(1)
    expect(log.find((l) => l.event === "event.committed")).toBeTruthy()
  })

  it("acks MalformedNotification (warn)", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () =>
      err({ _tag: "MalformedNotification", details: "bad" }),
    )
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("ack")
  })

  it("acks AccountNotFound (info)", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () => err({ _tag: "AccountNotFound", channelId }))
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("ack")
  })

  it("acks AccountPaused/Revoked", async () => {
    const { logger } = stubLogger()
    const p1 = createPipeline({
      store: stubStore(),
      resolver: makeResolver(async () => err({ _tag: "AccountPaused", accountId })),
      logger,
      clock: () => t0,
    })
    expect(await p1.processEvent(change)).toBe("ack")
    const p2 = createPipeline({
      store: stubStore(),
      resolver: makeResolver(async () => err({ _tag: "AccountRevoked", accountId })),
      logger,
      clock: () => t0,
    })
    expect(await p2.processEvent(change)).toBe("ack")
  })

  it("acks ChannelTokenMismatch and CalendarGone", async () => {
    const { logger } = stubLogger()
    const p1 = createPipeline({
      store: stubStore(),
      resolver: makeResolver(async () => err({ _tag: "ChannelTokenMismatch", channelId })),
      logger,
      clock: () => t0,
    })
    expect(await p1.processEvent(change)).toBe("ack")
    const p2 = createPipeline({
      store: stubStore(),
      resolver: makeResolver(async () => err({ _tag: "CalendarGone", accountId })),
      logger,
      clock: () => t0,
    })
    expect(await p2.processEvent(change)).toBe("ack")
  })

  it("acks CredentialsRevoked AND mutates account.status", async () => {
    const { logger } = stubLogger()
    const store = stubStore()
    const resolver = makeResolver(async () =>
      err({ _tag: "CredentialsRevoked", accountId, reason: "invalid_grant" }),
    )
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("ack")
    expect(store.calls.updateAccount).toBe(1)
  })

  it("nacks ProviderTransient", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () => err({ _tag: "ProviderTransient", message: "5xx" }))
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("nack")
  })

  it("acks ProviderPermanent", async () => {
    const { logger } = stubLogger()
    const resolver = makeResolver(async () => err({ _tag: "ProviderPermanent", message: "401" }))
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("ack")
  })

  it("nacks Store.Transient during commit", async () => {
    const { logger } = stubLogger()
    const store = stubStore({
      commitEvents: async () => err<StoreError>({ _tag: "Transient", message: "db blip" }),
    })
    const resolver = makeResolver(async () =>
      ok({ accountId, events: [stubEvent], newSyncToken: syncToken }),
    )
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("nack")
  })

  it("acks Store.Permanent during commit + emits alarm log", async () => {
    const { logger, log } = stubLogger()
    const store = stubStore({
      commitEvents: async () =>
        err<StoreError>({ _tag: "Permanent", message: "schema mismatch" }),
    })
    const resolver = makeResolver(async () =>
      ok({ accountId, events: [stubEvent], newSyncToken: syncToken }),
    )
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("ack")
    const dropped = log.find((l) => l.event === "event.dropped")
    expect(dropped?.fields?.alarm).toBe(true)
  })

  it("converts thrown resolver into ProviderTransient → nack", async () => {
    const { logger } = stubLogger()
    const resolver: CalendarChangeResolver = {
      resolve: async () => {
        throw new Error("boom")
      },
    }
    const p = createPipeline({ store: stubStore(), resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("nack")
  })

  it("empty events still commits and acks", async () => {
    const { logger } = stubLogger()
    const store = stubStore({
      commitEvents: async () => ok({ committedEventIds: [] }),
    })
    const resolver = makeResolver(async () =>
      ok({ accountId, events: [], newSyncToken: syncToken }),
    )
    const p = createPipeline({ store, resolver, logger, clock: () => t0 })
    expect(await p.processEvent(change)).toBe("ack")
  })
})
