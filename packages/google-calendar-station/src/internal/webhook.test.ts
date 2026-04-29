import { describe, expect, it } from "vitest"
import {
  decodeWebhook,
  deriveChannelToken,
  syntheticEventId,
  verifyChannelToken,
} from "./webhook.js"

describe("decodeWebhook", () => {
  it("reads X-Goog-* headers (case-insensitive)", () => {
    const r = decodeWebhook({
      "X-Goog-Channel-Id": "ch-1",
      "x-goog-channel-token": "tok",
      "X-Goog-Resource-Id": "res-1",
      "x-goog-resource-state": "exists",
      "x-goog-message-number": "42",
      "x-goog-resource-uri": "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      "x-goog-channel-expiration": "Tue, 01 Jan 2030 00:00:00 GMT",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.channelId).toBe("ch-1")
    expect(r.value.channelToken).toBe("tok")
    expect(r.value.resourceId).toBe("res-1")
    expect(r.value.resourceState).toBe("exists")
    expect(r.value.messageNumber).toBe("42")
  })

  it("rejects when channel id is missing", () => {
    const r = decodeWebhook({
      "x-goog-resource-id": "res",
      "x-goog-resource-state": "exists",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/channel-id/i)
  })

  it("rejects when resource state is missing", () => {
    const r = decodeWebhook({
      "x-goog-channel-id": "ch",
      "x-goog-resource-id": "res",
    })
    expect(r.ok).toBe(false)
  })

  it("treats missing channel-token as empty string (verifies still fail-closed)", () => {
    const r = decodeWebhook({
      "x-goog-channel-id": "ch",
      "x-goog-resource-id": "res",
      "x-goog-resource-state": "exists",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.channelToken).toBe("")
  })

  it("handles array-valued headers (Node http convention)", () => {
    const r = decodeWebhook({
      "x-goog-channel-id": ["ch-1"],
      "x-goog-resource-id": ["res-1"],
      "x-goog-resource-state": ["exists"],
    })
    expect(r.ok).toBe(true)
  })
})

describe("deriveChannelToken / verifyChannelToken", () => {
  it("derivation is deterministic per (secret, channelId)", () => {
    const a = deriveChannelToken("s3cr3t", "channel-1")
    const b = deriveChannelToken("s3cr3t", "channel-1")
    expect(a).toBe(b)
  })

  it("different channel ids produce different tokens", () => {
    const a = deriveChannelToken("s", "ch-1")
    const b = deriveChannelToken("s", "ch-2")
    expect(a).not.toBe(b)
  })

  it("verify accepts the matching token", () => {
    const t = deriveChannelToken("k", "ch-x")
    expect(verifyChannelToken(t, t)).toBe(true)
  })

  it("verify rejects mismatched length without throwing", () => {
    const t = deriveChannelToken("k", "ch")
    expect(verifyChannelToken(t, "short")).toBe(false)
  })

  it("verify rejects equal-length but different bytes", () => {
    const t = deriveChannelToken("k", "ch")
    const flipped = "0".repeat(t.length)
    expect(verifyChannelToken(t, flipped)).toBe(false)
  })
})

describe("syntheticEventId", () => {
  it("composes channel id + message number", () => {
    expect(syntheticEventId("ch", "1")).toBe("ch::1")
    expect(syntheticEventId("ch", null)).toBe("ch::0")
  })
})
