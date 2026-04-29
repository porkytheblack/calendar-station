import { describe, expect, it } from "vitest"
import { UserId as makeUserId, ok, err } from "calendar-station"
import { createReferenceStore } from "calendar-station-conformance"
import { createWatchManager, webhookUrl } from "./watch.js"
import type {
  GoogleCalendarClient,
  GoogleCalendarClientFactory,
  ResolvedGoogleCalendarConfig,
} from "./types.js"

const BASE_CONFIG: ResolvedGoogleCalendarConfig = {
  googleClientId: "id",
  googleClientSecret: "sec",
  webhookBaseUrl: "https://api.example.com/",
  webhookPath: "webhooks/calendar",
  channelTokenSecret: "secret",
  channelTtlMs: 7 * 24 * 60 * 60 * 1000,
  renewalWindowMs: 24 * 60 * 60 * 1000,
  listPageSize: 250,
  listConcurrency: 4,
  ingressMode: "sync",
  commitTimeoutMs: 8_000,
}

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const fakeClient = (
  overrides: Partial<GoogleCalendarClient> = {},
): GoogleCalendarClient => ({
  validateRefreshToken: async () => ok(undefined),
  eventsList: async () =>
    ok({ items: [], nextSyncToken: "st-seed", nextPageToken: undefined }),
  watch: async () =>
    ok({ resourceId: "res-fresh", expiration: new Date("2026-04-30T00:00:00Z") }),
  stop: async () => ok(undefined),
  ...overrides,
})

const factoryOf =
  (client: GoogleCalendarClient): GoogleCalendarClientFactory =>
  () =>
    client

describe("webhookUrl", () => {
  it("trims trailing slash on base + adds leading slash on path", () => {
    expect(webhookUrl("https://api.com/", "webhooks/cal")).toBe(
      "https://api.com/webhooks/cal",
    )
    expect(webhookUrl("https://api.com", "/webhooks/cal")).toBe(
      "https://api.com/webhooks/cal",
    )
  })
})

describe("watchManager.register", () => {
  it("validates → seeds events.list → watches → persists", async () => {
    const store = createReferenceStore()
    const calls: string[] = []
    const client = fakeClient({
      validateRefreshToken: async () => {
        calls.push("validate")
        return ok(undefined)
      },
      eventsList: async () => {
        calls.push("list")
        return ok({
          items: [{ id: "seed-1", summary: "seed" }],
          nextSyncToken: "st-seed",
          nextPageToken: undefined,
        })
      },
      watch: async ({ address, channelId, token }) => {
        calls.push(`watch:${address}:${!!channelId}:${!!token}`)
        return ok({ resourceId: "r1", expiration: new Date("2026-05-01T00:00:00Z") })
      },
    })
    const m = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-04-29T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(client) },
    })
    const r = await m.register({
      userId: makeUserId("user-1"),
      calendarId: "primary",
      refreshToken: "rt",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(calls[0]).toBe("validate")
    expect(calls[1]).toBe("list")
    expect(calls[2]).toMatch(/^watch:https:\/\/api\.example\.com\/webhooks\/calendar:true:true$/)
    const acct = await store.getAccount(r.value.accountId)
    expect(acct.ok && acct.value.syncToken).toBe("st-seed")
    expect(acct.ok && acct.value.resourceId).toBe("r1")
    // The seed event is committed.
    const claimed = await store.claimTriggerJobs({
      workerId: "w",
      limit: 10,
      leaseDurationMs: 60_000,
      now: new Date("2026-04-29T00:01:00Z"),
    })
    expect(claimed.ok && claimed.value.length).toBe(1)
  })

  it("InvalidGrant on bad refresh token", async () => {
    const store = createReferenceStore()
    const client = fakeClient({
      validateRefreshToken: async () =>
        err({
          _tag: "CredentialsRevoked",
          accountId: "<>" as never,
          reason: "invalid_grant",
        }),
    })
    const m = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-04-29T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(client) },
    })
    const r = await m.register({
      userId: makeUserId("user-1"),
      calendarId: "primary",
      refreshToken: "bad",
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("InvalidGrant")
  })

  it("DuplicateAccount on existing (provider, userId, calendarId)", async () => {
    const store = createReferenceStore()
    await store.createAccount({
      userId: makeUserId("user-1"),
      provider: "google-calendar",
      calendarId: "primary",
      credentials: {},
      syncToken: null,
      channelId: null,
      resourceId: null,
      channelExpiresAt: null,
      now: new Date("2026-04-29T00:00:00Z"),
    })
    const m = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-04-29T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(fakeClient()) },
    })
    const r = await m.register({
      userId: makeUserId("user-1"),
      calendarId: "primary",
      refreshToken: "rt",
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("DuplicateAccount")
  })

  it("pre-flight duplicate check fires before watch (no leaked channel)", async () => {
    const store = createReferenceStore()
    let watchCalls = 0
    let stopCalls = 0
    const client = fakeClient({
      watch: async () => {
        watchCalls++
        return ok({ resourceId: "r", expiration: new Date(Date.now() + 1000) })
      },
      stop: async () => {
        stopCalls++
        return ok(undefined)
      },
    })
    const m = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => new Date("2026-04-29T00:00:00Z"),
      config: { ...BASE_CONFIG, clientFactory: factoryOf(client) },
    })
    const r1 = await m.register({
      userId: makeUserId("user-2"),
      calendarId: "primary",
      refreshToken: "rt",
    })
    expect(r1.ok).toBe(true)
    const watchAfterFirst = watchCalls

    const r2 = await m.register({
      userId: makeUserId("user-2"),
      calendarId: "primary",
      refreshToken: "rt",
    })
    expect(r2.ok).toBe(false)
    if (r2.ok) return
    expect(r2.error._tag).toBe("DuplicateAccount")
    // No second watch (so no compensating stop needed).
    expect(watchCalls).toBe(watchAfterFirst)
    expect(stopCalls).toBe(0)
  })
})

describe("watchManager.renewExpiringChannels", () => {
  const t0 = new Date("2026-04-29T00:00:00Z")
  it("rotates channel id, persists new expiration, stops old channel", async () => {
    const store = createReferenceStore()
    const created = await store.createAccount({
      userId: makeUserId("user-1"),
      provider: "google-calendar",
      calendarId: "primary",
      credentials: { refreshToken: "rt" },
      syncToken: null,
      channelId: null,
      resourceId: null,
      channelExpiresAt: null,
      now: t0,
    })
    if (!created.ok) throw new Error("seed failed")
    // Seed a channel that expires within the window.
    await store.updateAccount(created.value.accountId, {
      channelId: "ch-old" as never,
      resourceId: "res-old",
      channelExpiresAt: new Date(t0.getTime() + 60 * 60_000),
      now: t0,
    })
    const stopped: Array<{ id: string; resource: string }> = []
    const client = fakeClient({
      watch: async () =>
        ok({ resourceId: "res-new", expiration: new Date(t0.getTime() + 8 * 24 * 60 * 60_000) }),
      stop: async ({ channelId, resourceId }) => {
        stopped.push({ id: channelId, resource: resourceId })
        return ok(undefined)
      },
    })
    const m = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: { ...BASE_CONFIG, clientFactory: factoryOf(client) },
    })
    const r = await m.renewExpiringChannels()
    expect(r.ok && r.value.renewed).toBe(1)
    const acct = await store.getAccount(created.value.accountId)
    expect(acct.ok && acct.value.channelId).not.toBe("ch-old")
    expect(acct.ok && acct.value.resourceId).toBe("res-new")
    expect(stopped).toEqual([{ id: "ch-old", resource: "res-old" }])
  })

  it("on CredentialsRevoked, marks account revoked and counts in summary", async () => {
    const store = createReferenceStore()
    const created = await store.createAccount({
      userId: makeUserId("user-1"),
      provider: "google-calendar",
      calendarId: "primary",
      credentials: { refreshToken: "rt" },
      syncToken: null,
      channelId: "ch-old" as never,
      resourceId: "res-old",
      channelExpiresAt: new Date(t0.getTime() + 60 * 60_000),
      now: t0,
    })
    if (!created.ok) throw new Error("seed failed")
    const client = fakeClient({
      watch: async () =>
        err({
          _tag: "CredentialsRevoked",
          accountId: "<>" as never,
          reason: "invalid_grant",
        }),
    })
    const m = createWatchManager({
      store,
      pipeline: { processEvent: async () => "ack" },
      logger: noopLogger,
      clock: () => t0,
      config: { ...BASE_CONFIG, clientFactory: factoryOf(client) },
    })
    const r = await m.renewExpiringChannels()
    expect(r.ok && r.value.revoked).toBe(1)
    const acct = await store.getAccount(created.value.accountId)
    expect(acct.ok && acct.value.status).toBe("revoked")
  })
})
