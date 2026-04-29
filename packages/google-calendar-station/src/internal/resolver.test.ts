import { describe, expect, it } from "vitest"
import { ChannelId as makeChannelId, UserId as makeUserId, ok, err } from "calendar-station"
import type {
  CalendarChangeEvent,
  StoreAdapter,
} from "calendar-station"
import { createReferenceStore } from "calendar-station-conformance"
import { createGoogleCalendarResolver } from "./resolver.js"
import { deriveChannelToken } from "./webhook.js"
import type {
  GoogleCalendarClient,
  GoogleCalendarClientFactory,
  ResolvedGoogleCalendarConfig,
} from "./types.js"

const SECRET = "test-secret"
const BASE_CONFIG: ResolvedGoogleCalendarConfig = {
  googleClientId: "id",
  googleClientSecret: "sec",
  webhookBaseUrl: "https://example.com",
  webhookPath: "/webhooks/calendar",
  channelTokenSecret: SECRET,
  channelTtlMs: 7 * 24 * 60 * 60 * 1000,
  renewalWindowMs: 24 * 60 * 60 * 1000,
  listPageSize: 250,
  listConcurrency: 4,
  ingressMode: "sync",
  commitTimeoutMs: 8_000,
}

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const seed = async (
  store: StoreAdapter,
  channelIdStr = "ch-1",
  syncTokenStr: string | null = null,
): Promise<{ accountId: import("calendar-station").CalendarAccountId; channelToken: string }> => {
  const r = await store.createAccount({
    userId: makeUserId("user-1"),
    provider: "google-calendar",
    calendarId: "primary",
    credentials: { refreshToken: "rt" },
    syncToken: syncTokenStr ? (syncTokenStr as never) : null,
    channelId: makeChannelId(channelIdStr),
    resourceId: "res-1",
    channelExpiresAt: null,
    now: new Date("2026-01-01T00:00:00Z"),
  })
  if (!r.ok) throw new Error("seed failed")
  return {
    accountId: r.value.accountId,
    channelToken: deriveChannelToken(SECRET, channelIdStr),
  }
}

const fakeClient = (
  overrides: Partial<GoogleCalendarClient> = {},
): GoogleCalendarClient => ({
  validateRefreshToken: async () => ok(undefined),
  eventsList: async () =>
    ok({ items: [], nextSyncToken: "st-final", nextPageToken: undefined }),
  watch: async () => ok({ resourceId: "res", expiration: new Date(Date.now() + 1000) }),
  stop: async () => ok(undefined),
  ...overrides,
})

const factoryOf =
  (client: GoogleCalendarClient): GoogleCalendarClientFactory =>
  () =>
    client

const change = (
  channelId: string,
  resourceState: string,
  channelToken: string,
): CalendarChangeEvent => ({
  eventId: `${channelId}::1`,
  providerPayload: {
    channelId,
    channelToken,
    resourceId: "res-1",
    resourceState,
    messageNumber: "1",
    resourceUri: null,
    channelExpiration: null,
  },
  receivedAt: new Date("2026-01-01T00:00:00Z"),
})

describe("createGoogleCalendarResolver", () => {
  it("ack-handshake: sync state returns empty events with current syncToken", async () => {
    const store = createReferenceStore()
    const seeded = await seed(store, "ch-sync", "st-current")
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(fakeClient()) },
    })
    const r = await resolver.resolve(change("ch-sync", "sync", seeded.channelToken))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.events.length).toBe(0)
  })

  it("exists state drains events.list, parses items, advances syncToken", async () => {
    const store = createReferenceStore()
    const seeded = await seed(store, "ch-events")
    const items = [
      { id: "e1", status: "confirmed", summary: "First" },
      { id: "e2", status: "tentative", summary: "Second" },
    ]
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: {
        ...BASE_CONFIG,
        clientFactory: factoryOf(
          fakeClient({
            eventsList: async () =>
              ok({ items, nextSyncToken: "st-next", nextPageToken: undefined }),
          }),
        ),
      },
    })
    const r = await resolver.resolve(change("ch-events", "exists", seeded.channelToken))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.events.map((e) => e.eventId)).toEqual(["e1", "e2"])
    expect(r.value.newSyncToken).toBe("st-next")
  })

  it("paginates when nextPageToken is present", async () => {
    const store = createReferenceStore()
    const seeded = await seed(store, "ch-page")
    let call = 0
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: {
        ...BASE_CONFIG,
        clientFactory: factoryOf(
          fakeClient({
            eventsList: async () => {
              call++
              if (call === 1)
                return ok({
                  items: [{ id: "p1" }],
                  nextPageToken: "pt-2",
                  nextSyncToken: undefined,
                })
              return ok({
                items: [{ id: "p2" }],
                nextPageToken: undefined,
                nextSyncToken: "st-end",
              })
            },
          }),
        ),
      },
    })
    const r = await resolver.resolve(change("ch-page", "exists", seeded.channelToken))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.events.map((e) => e.eventId)).toEqual(["p1", "p2"])
    expect(r.value.newSyncToken).toBe("st-end")
    expect(call).toBe(2)
  })

  it("recovers from SyncTokenGone by full re-paginating", async () => {
    const store = createReferenceStore()
    const seeded = await seed(store, "ch-gone", "stale-token")
    let call = 0
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: {
        ...BASE_CONFIG,
        clientFactory: factoryOf(
          fakeClient({
            eventsList: async (input) => {
              call++
              if (call === 1) {
                expect(input.syncToken).toBe("stale-token")
                return err({ _tag: "SyncTokenGone" } as const)
              }
              expect(input.syncToken).toBeUndefined()
              return ok({
                items: [{ id: "after-resync" }],
                nextSyncToken: "st-fresh",
                nextPageToken: undefined,
              })
            },
          }),
        ),
      },
    })
    const r = await resolver.resolve(change("ch-gone", "exists", seeded.channelToken))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.events).toHaveLength(1)
    expect(r.value.newSyncToken).toBe("st-fresh")
  })

  it("not_exists state returns CalendarGone", async () => {
    const store = createReferenceStore()
    const seeded = await seed(store, "ch-deleted")
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(fakeClient()) },
    })
    const r = await resolver.resolve(change("ch-deleted", "not_exists", seeded.channelToken))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("CalendarGone")
  })

  it("AccountNotFound when channel id is unknown", async () => {
    const store = createReferenceStore()
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(fakeClient()) },
    })
    const tok = deriveChannelToken(SECRET, "unknown")
    const r = await resolver.resolve(change("unknown", "exists", tok))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("AccountNotFound")
  })

  it("ChannelTokenMismatch fails closed", async () => {
    const store = createReferenceStore()
    await seed(store, "ch-mismatch")
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(fakeClient()) },
    })
    const r = await resolver.resolve(change("ch-mismatch", "exists", "wrong-token-sized-same"))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("ChannelTokenMismatch")
  })

  it("MalformedNotification when payload is missing", async () => {
    const store = createReferenceStore()
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(fakeClient()) },
    })
    const r = await resolver.resolve({
      eventId: "x",
      providerPayload: null,
      receivedAt: new Date(),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("MalformedNotification")
  })

  it("AccountPaused / AccountRevoked surface as the right tags", async () => {
    const store = createReferenceStore()
    const seeded = await seed(store, "ch-paused")
    await store.updateAccount(seeded.accountId, {
      status: "paused",
      now: new Date("2026-01-02T00:00:00Z"),
    })
    const resolver = createGoogleCalendarResolver({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(fakeClient()) },
    })
    const r1 = await resolver.resolve(change("ch-paused", "exists", seeded.channelToken))
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error._tag).toBe("AccountPaused")

    await store.updateAccount(seeded.accountId, {
      status: "revoked",
      now: new Date("2026-01-02T00:00:00Z"),
    })
    const r2 = await resolver.resolve(change("ch-paused", "exists", seeded.channelToken))
    if (!r2.ok) expect(r2.error._tag).toBe("AccountRevoked")
  })
})
