import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookNotification } from "./types.js"

const headerValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null => {
  const lc = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== lc) continue
    const v = headers[k]
    if (v === undefined) return null
    if (Array.isArray(v)) return v[0] ?? null
    return v
  }
  return null
}

/**
 * Decode a Google Calendar webhook request into a `WebhookNotification`.
 *
 * Google sends the change ping as an empty-body POST. Everything we need is
 * in headers — channel id, the per-channel token we registered, the resource
 * state (sync | exists | not_exists), and the resource id we'll need if we
 * have to call `channels.stop`.
 */
export const decodeWebhook = (
  headers: Record<string, string | string[] | undefined>,
): { ok: true; value: WebhookNotification } | { ok: false; error: string } => {
  const channelId = headerValue(headers, "x-goog-channel-id")
  const resourceId = headerValue(headers, "x-goog-resource-id")
  const resourceState = headerValue(headers, "x-goog-resource-state")
  const channelToken = headerValue(headers, "x-goog-channel-token") ?? ""
  if (!channelId) return { ok: false, error: "missing X-Goog-Channel-Id" }
  if (!resourceId) return { ok: false, error: "missing X-Goog-Resource-Id" }
  if (!resourceState) return { ok: false, error: "missing X-Goog-Resource-State" }
  return {
    ok: true,
    value: {
      channelId,
      channelToken,
      resourceId,
      resourceState,
      messageNumber: headerValue(headers, "x-goog-message-number"),
      resourceUri: headerValue(headers, "x-goog-resource-uri"),
      channelExpiration: headerValue(headers, "x-goog-channel-expiration"),
    },
  }
}

/**
 * Derive a per-channel token from a server-side secret via HMAC-SHA256.
 * Stored alongside the channel id when we call `events.watch`; on inbound
 * webhook we re-derive and compare with the header.
 */
export const deriveChannelToken = (secret: string, channelId: string): string =>
  createHmac("sha256", secret).update(channelId).digest("hex")

/** Constant-time comparison; treats unequal-length strings as mismatched. */
export const verifyChannelToken = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected, "utf-8")
  const b = Buffer.from(received, "utf-8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Build a synthetic `eventId` for the change event. Google's headers carry
 * `X-Goog-Channel-Id` + `X-Goog-Message-Number`; together they make a stable
 * id useful for tracing, even though resolution of the actual delta happens
 * via `events.list?syncToken=…` rather than an opaque payload.
 */
export const syntheticEventId = (
  channelId: string,
  messageNumber: string | null,
): string => `${channelId}::${messageNumber ?? "0"}`
