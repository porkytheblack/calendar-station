import { describe, expect, it } from "vitest"
import { ChannelId as makeChannelId, UserId as makeUserId, ok } from "calendar-station"
import type { CalendarPipeline } from "calendar-station"
import { createReferenceStore } from "calendar-station-conformance"
import { startIngress } from "./ingress.js"
import { deriveChannelToken } from "./webhook.js"
import type {
  GoogleCalendarClient,
  GoogleCalendarClientFactory,
  ResolvedGoogleCalendarConfig,
} from "./types.js"

const SECRET = "ingress-secret"

const baseConfig = (
  overrides: Partial<ResolvedGoogleCalendarConfig> = {},
): ResolvedGoogleCalendarConfig => ({
  googleClientId: "id",
  googleClientSecret: "sec",
  webhookBaseUrl: "https://api.example.com",
  webhookPath: "/webhooks/calendar",
  channelTokenSecret: SECRET,
  channelTtlMs: 7 * 24 * 60 * 60 * 1000,
  renewalWindowMs: 24 * 60 * 60 * 1000,
  listPageSize: 250,
  listConcurrency: 4,
  ingressMode: "sync",
  commitTimeoutMs: 100,
  ...overrides,
})

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const fakeClient = (
  overrides: Partial<GoogleCalendarClient> = {},
): GoogleCalendarClient => ({
  validateRefreshToken: async () => ok(undefined),
  eventsList: async () => ok({ items: [], nextSyncToken: "st", nextPageToken: undefined }),
  watch: async () => ok({ resourceId: "r", expiration: new Date(Date.now() + 1000) }),
  stop: async () => ok(undefined),
  ...overrides,
})

const factoryOf =
  (client: GoogleCalendarClient): GoogleCalendarClientFactory =>
  () =>
    client

const seed = async (store: ReturnType<typeof createReferenceStore>, channelId = "ch-1") => {
  const r = await store.createAccount({
    userId: makeUserId("user-1"),
    provider: "google-calendar",
    calendarId: "primary",
    credentials: { refreshToken: "rt" },
    syncToken: null,
    channelId: makeChannelId(channelId),
    resourceId: "res-1",
    channelExpiresAt: null,
    now: new Date("2026-01-01T00:00:00Z"),
  })
  if (!r.ok) throw new Error("seed failed")
  return r.value
}

const headers = (
  channelId: string,
  state: string,
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  "x-goog-channel-id": channelId,
  "x-goog-channel-token": token,
  "x-goog-resource-id": "res-1",
  "x-goog-resource-state": state,
  "x-goog-message-number": "1",
  ...extra,
})

const ackPipeline: CalendarPipeline = { processEvent: async () => "ack" }
const nackPipeline: CalendarPipeline = { processEvent: async () => "nack" }

describe("startIngress.handle", () => {
  it("400 on missing channel id header", async () => {
    const store = createReferenceStore()
    const ingress = startIngress({
      store,
      pipeline: ackPipeline,
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ clientFactory: factoryOf(fakeClient()) }),
    })
    const r = await ingress.handle({ headers: {} })
    expect(r.status).toBe(400)
  })

  it("401 on channel token mismatch", async () => {
    const store = createReferenceStore()
    await seed(store, "ch-401")
    const ingress = startIngress({
      store,
      pipeline: ackPipeline,
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ clientFactory: factoryOf(fakeClient()) }),
    })
    const r = await ingress.handle({
      headers: headers("ch-401", "exists", "wrong-token-of-equal-bytes"),
    })
    expect(r.status).toBe(401)
  })

  it("200 on sync handshake (no pipeline call)", async () => {
    const store = createReferenceStore()
    await seed(store, "ch-sync")
    let calls = 0
    const ingress = startIngress({
      store,
      pipeline: { processEvent: async () => (++calls, "ack") },
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ clientFactory: factoryOf(fakeClient()) }),
    })
    const tok = deriveChannelToken(SECRET, "ch-sync")
    const r = await ingress.handle({ headers: headers("ch-sync", "sync", tok) })
    expect(r.status).toBe(200)
    expect(calls).toBe(0)
  })

  it("200 on exists when pipeline acks", async () => {
    const store = createReferenceStore()
    await seed(store, "ch-exists")
    const ingress = startIngress({
      store,
      pipeline: ackPipeline,
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ clientFactory: factoryOf(fakeClient()) }),
    })
    const tok = deriveChannelToken(SECRET, "ch-exists")
    const r = await ingress.handle({ headers: headers("ch-exists", "exists", tok) })
    expect(r.status).toBe(200)
  })

  it("503 on exists when pipeline nacks (Google retries)", async () => {
    const store = createReferenceStore()
    await seed(store, "ch-nack")
    const ingress = startIngress({
      store,
      pipeline: nackPipeline,
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ clientFactory: factoryOf(fakeClient()) }),
    })
    const tok = deriveChannelToken(SECRET, "ch-nack")
    const r = await ingress.handle({ headers: headers("ch-nack", "exists", tok) })
    expect(r.status).toBe(503)
  })

  it("503 on exists when pipeline exceeds commit timeout", async () => {
    const store = createReferenceStore()
    await seed(store, "ch-slow")
    const ingress = startIngress({
      store,
      pipeline: { processEvent: () => new Promise(() => {}) },
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ commitTimeoutMs: 20, clientFactory: factoryOf(fakeClient()) }),
    })
    const tok = deriveChannelToken(SECRET, "ch-slow")
    const r = await ingress.handle({ headers: headers("ch-slow", "exists", tok) })
    expect(r.status).toBe(503)
  })

  it("not_exists stops the channel and clears persisted channel state", async () => {
    const store = createReferenceStore()
    const acct = await seed(store, "ch-deleted")
    let stopped = false
    const ingress = startIngress({
      store,
      pipeline: ackPipeline,
      logger: noopLogger,
      clock: () => new Date("2026-01-02T00:00:00Z"),
      config: baseConfig({
        clientFactory: factoryOf(
          fakeClient({
            stop: async () => {
              stopped = true
              return ok(undefined)
            },
          }),
        ),
      }),
    })
    const tok = deriveChannelToken(SECRET, "ch-deleted")
    const r = await ingress.handle({ headers: headers("ch-deleted", "not_exists", tok) })
    expect(r.status).toBe(200)
    expect(stopped).toBe(true)
    const a = await store.getAccount(acct.accountId)
    expect(a.ok && a.value.channelId).toBeNull()
  })

  it("deferred mode acks 200 immediately and runs pipeline in background", async () => {
    const store = createReferenceStore()
    await seed(store, "ch-deferred")
    let pipelineRan = false
    let release: () => void = () => {}
    const ingress = startIngress({
      store,
      pipeline: {
        processEvent: () =>
          new Promise<"ack" | "nack">((resolve) => {
            release = () => {
              pipelineRan = true
              resolve("ack")
            }
          }),
      },
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ ingressMode: "deferred", clientFactory: factoryOf(fakeClient()) }),
    })
    const tok = deriveChannelToken(SECRET, "ch-deferred")
    const r = await ingress.handle({ headers: headers("ch-deferred", "exists", tok) })
    expect(r.status).toBe(200)
    expect(pipelineRan).toBe(false)
    release()
    await ingress.stop() // drains in-flight deferred work
    expect(pipelineRan).toBe(true)
  })

  it("returns 200 (not 5xx) when channel id is unknown to avoid Google retries", async () => {
    const store = createReferenceStore()
    const ingress = startIngress({
      store,
      pipeline: ackPipeline,
      logger: noopLogger,
      clock: () => new Date(),
      config: baseConfig({ clientFactory: factoryOf(fakeClient()) }),
    })
    const tok = deriveChannelToken(SECRET, "unknown")
    const r = await ingress.handle({ headers: headers("unknown", "exists", tok) })
    expect(r.status).toBe(200)
  })
})
