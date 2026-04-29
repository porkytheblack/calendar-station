import { ChannelId as makeChannelId } from "calendar-station"
import type { CalendarChangeEvent, ChannelId } from "calendar-station"
import { defaultGoogleCalendarClientFactory } from "./client.js"
import {
  decodeWebhook,
  deriveChannelToken,
  syntheticEventId,
  verifyChannelToken,
} from "./webhook.js"
import type {
  GoogleCalendarRuntimeDeps,
  WebhookNotification,
} from "./types.js"

export type WebhookResponse = { status: number; body?: string }

export type IngressHandle = {
  start(): Promise<void>
  stop(): Promise<void>
  wait(): Promise<void>
  handle(input: {
    headers: Record<string, string | string[] | undefined>
    body?: string | Buffer | null
  }): Promise<WebhookResponse>
}

export const startIngress = (deps: GoogleCalendarRuntimeDeps): IngressHandle => {
  const { config, logger, pipeline, store, clock } = deps
  let stopping = false
  let waitDone: Promise<void> = Promise.resolve()
  /** In-flight pipeline calls in deferred mode. Drained on stop. */
  const inflight = new Set<Promise<void>>()

  const buildSdkClient = () => {
    const factory = config.clientFactory ?? defaultGoogleCalendarClientFactory
    return factory(
      { refreshToken: "" },
      { config, onTokenRefresh: () => {} },
    )
  }

  /** Race the pipeline against a hard timeout so Google never sees a hang. */
  const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => {
    let to: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      to = setTimeout(() => resolve("timeout"), ms)
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      if (to) clearTimeout(to)
    }
  }

  const dispatch = async (notif: WebhookNotification): Promise<WebhookResponse> => {
    if (notif.resourceState === "sync") {
      // Channel-creation handshake. Google sends this once immediately after
      // events.watch — ack and forget.
      logger.debug("webhook.sync_handshake", { channelId: notif.channelId })
      return { status: 200 }
    }

    if (notif.resourceState === "not_exists") {
      // The calendar resource itself was deleted. Stop the channel so we
      // don't keep hearing about it.
      logger.warn("webhook.calendar_deleted", { channelId: notif.channelId })
      const acct = await store.getAccountByChannelId(notif.channelId as ChannelId)
      if (acct.ok && acct.value.channelId && acct.value.resourceId) {
        const client = buildSdkClient()
        const stop = await client.stop({
          channelId: acct.value.channelId,
          resourceId: acct.value.resourceId,
        })
        if (!stop.ok) {
          logger.warn("webhook.channel_stop_failed", {
            channelId: notif.channelId,
            error: stop.error._tag,
          })
        }
        await store.updateAccount(acct.value.accountId, {
          channelId: null,
          resourceId: null,
          channelExpiresAt: null,
          now: clock(),
        })
      }
      return { status: 200 }
    }

    // exists (or any unknown forward-compat state) → feed the pipeline.
    const change: CalendarChangeEvent = {
      eventId: syntheticEventId(notif.channelId, notif.messageNumber),
      providerPayload: notif,
      receivedAt: clock(),
    }

    if (config.ingressMode === "deferred") {
      const work = (async () => {
        try {
          await pipeline.processEvent(change)
        } catch (e) {
          logger.error("webhook.deferred_failed", {
            channelId: notif.channelId,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      })()
      inflight.add(work)
      work.finally(() => inflight.delete(work))
      return { status: 200 }
    }

    const decision = await withTimeout(
      pipeline.processEvent(change),
      config.commitTimeoutMs,
    )
    if (decision === "timeout") {
      logger.warn("webhook.commit_timeout", {
        channelId: notif.channelId,
        commitTimeoutMs: config.commitTimeoutMs,
      })
      return { status: 503 }
    }
    if (decision === "ack") return { status: 200 }
    // nack → return 5xx so Google retries.
    return { status: 503 }
  }

  const handle = async (input: {
    headers: Record<string, string | string[] | undefined>
    body?: string | Buffer | null
  }): Promise<WebhookResponse> => {
    if (stopping) return { status: 503, body: "shutting down" }

    const decoded = decodeWebhook(input.headers)
    if (!decoded.ok) {
      logger.warn("webhook.decode_failed", { reason: decoded.error })
      return { status: 400, body: decoded.error }
    }
    const notif = decoded.value

    const expected = deriveChannelToken(config.channelTokenSecret, notif.channelId)
    if (!verifyChannelToken(expected, notif.channelToken)) {
      logger.warn("webhook.token_mismatch", { channelId: notif.channelId })
      return { status: 401 }
    }

    // Confirm the channel id matches a known account before doing real work.
    const acct = await store.getAccountByChannelId(makeChannelId(notif.channelId))
    if (!acct.ok && acct.error._tag === "AccountNotFound") {
      // Could be a leftover channel from a previous deployment. Reply 200
      // to stop Google retrying; if there is a real channel mismatch, ops
      // see it via the log.
      logger.warn("webhook.unknown_channel", { channelId: notif.channelId })
      return { status: 200 }
    }
    if (!acct.ok) {
      logger.error("webhook.account_lookup_failed", {
        channelId: notif.channelId,
        error: acct.error._tag,
      })
      return { status: 503 }
    }

    return dispatch(notif)
  }

  return {
    start: async () => {
      logger.info("ingress.started", {
        provider: "google-calendar",
        webhookUrl: `${config.webhookBaseUrl.replace(/\/+$/, "")}${
          config.webhookPath.startsWith("/") ? config.webhookPath : `/${config.webhookPath}`
        }`,
        ingressMode: config.ingressMode,
      })
    },
    stop: async () => {
      stopping = true
      // Drain any in-flight deferred pipeline calls.
      const pending = Array.from(inflight)
      if (pending.length > 0) {
        waitDone = Promise.all(pending).then(() => {})
        await waitDone
      }
    },
    wait: async () => {
      await waitDone
    },
    handle,
  }
}
