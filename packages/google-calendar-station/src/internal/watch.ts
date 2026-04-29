import { ChannelId as makeChannelId, err, ok } from "calendar-station"
import type {
  CalendarAccount,
  CalendarAccountId,
  ChannelId,
  Result,
  UserIdType,
} from "calendar-station"
import { defaultGoogleCalendarClientFactory } from "./client.js"
import { drainList } from "./resolver.js"
import { deriveChannelToken } from "./webhook.js"
import type {
  GoogleCalendarClient,
  GoogleCalendarRuntimeDeps,
  RegisterError,
  RenewSummary,
} from "./types.js"

const RENEW_CONCURRENCY = 8

/**
 * Build the absolute webhook URL from base + path. Trims trailing slash on
 * the base and leading slash on the path so the join is unambiguous.
 */
export const webhookUrl = (baseUrl: string, path: string): string => {
  const b = baseUrl.replace(/\/+$/, "")
  const p = path.startsWith("/") ? path : `/${path}`
  return b + p
}

export const createWatchManager = (deps: GoogleCalendarRuntimeDeps) => {
  const { store, logger, clock, config } = deps

  const buildClient = (refreshToken: string, account?: CalendarAccount): GoogleCalendarClient => {
    const factory = config.clientFactory ?? defaultGoogleCalendarClientFactory
    return factory(
      { refreshToken },
      {
        config,
        onTokenRefresh: (next) => {
          if (!account) return
          void store
            .updateAccount(account.accountId, {
              credentials: { ...account.credentials, ...next },
              now: clock(),
            })
            .catch(() => {})
        },
      },
    )
  }

  const register = async (input: {
    userId: UserIdType
    calendarId: string
    refreshToken: string
  }): Promise<Result<{ accountId: CalendarAccountId }, RegisterError>> => {
    const client = buildClient(input.refreshToken)

    // 1. Validate refresh token before any side effects.
    const validate = await client.validateRefreshToken()
    if (!validate.ok) {
      if (validate.error._tag === "CredentialsRevoked") {
        return err({ _tag: "InvalidGrant", reason: validate.error.reason })
      }
      if (validate.error._tag === "ProviderTransient") {
        return err({
          _tag: "ProviderTransient",
          message: validate.error.message,
          cause: validate.error.cause,
        })
      }
      const errMsg =
        "message" in validate.error ? (validate.error as { message?: string }).message : undefined
      return err({
        _tag: "ProviderPermanent",
        message: errMsg ?? validate.error._tag,
        cause: validate.error,
      })
    }

    // 2. Pre-flight duplicate check.
    const existing = await store.getAccountByCalendar(
      "google-calendar",
      input.userId,
      input.calendarId,
    )
    if (existing.ok) {
      return err({
        _tag: "DuplicateAccount",
        userId: input.userId,
        calendarId: input.calendarId,
      })
    } else if (existing.error._tag !== "AccountNotFound") {
      const msg =
        existing.error._tag === "Transient" || existing.error._tag === "Permanent"
          ? existing.error.message
          : "lookup failed"
      return err({ _tag: "ProviderTransient", message: msg })
    }

    // 3. Initial seed: drain events.list (no syncToken) to pick up the
    //    nextSyncToken. Pass an in-memory dummy account so drainList has the
    //    right calendarId; we don't yet know the account id.
    const seedAccount: CalendarAccount = {
      accountId: "<seed>" as unknown as CalendarAccountId,
      userId: input.userId,
      provider: "google-calendar",
      calendarId: input.calendarId,
      status: "active",
      credentials: { refreshToken: input.refreshToken },
      syncToken: null,
      channelId: null,
      resourceId: null,
      channelExpiresAt: null,
      createdAt: clock(),
      updatedAt: clock(),
    }
    const drained = await drainList(client, seedAccount, logger, config.listPageSize, false)
    if (!drained.ok) {
      const e = drained.error
      if (e._tag === "CredentialsRevoked") return err({ _tag: "InvalidGrant", reason: e.reason })
      if (e._tag === "ProviderTransient")
        return err({ _tag: "ProviderTransient", message: e.message, cause: e.cause })
      const msg = "message" in e ? e.message : e._tag
      return err({ _tag: "ProviderPermanent", message: msg ?? e._tag, cause: e })
    }
    const seedSyncToken = drained.value.newSyncToken

    // 4. events.watch.
    const channelId = makeChannelId(crypto.randomUUID())
    const channelToken = deriveChannelToken(config.channelTokenSecret, channelId)
    const address = webhookUrl(config.webhookBaseUrl, config.webhookPath)
    const watch = await client.watch({
      calendarId: input.calendarId,
      channelId,
      address,
      token: channelToken,
      ttlMs: config.channelTtlMs,
    })
    if (!watch.ok) {
      if (watch.error._tag === "CredentialsRevoked") {
        return err({ _tag: "InvalidGrant", reason: watch.error.reason })
      }
      if (watch.error._tag === "ProviderTransient") {
        return err({
          _tag: "ProviderTransient",
          message: watch.error.message,
          cause: watch.error.cause,
        })
      }
      const errMsg =
        "message" in watch.error ? (watch.error as { message?: string }).message : undefined
      return err({
        _tag: "ProviderPermanent",
        message: errMsg ?? watch.error._tag,
        cause: watch.error,
      })
    }

    // 5. Persist.
    const created = await store.createAccount({
      userId: input.userId,
      provider: "google-calendar",
      calendarId: input.calendarId,
      credentials: { refreshToken: input.refreshToken },
      syncToken: seedSyncToken,
      channelId,
      resourceId: watch.value.resourceId,
      channelExpiresAt: watch.value.expiration,
      now: clock(),
    })

    if (!created.ok) {
      const stop = await client.stop({
        channelId,
        resourceId: watch.value.resourceId,
      })
      if (!stop.ok) {
        logger.warn("watch.compensating_stop_failed", {
          calendarId: input.calendarId,
          error: stop.error._tag,
        })
      }
      if (created.error._tag === "DuplicateAccount") {
        return err({
          _tag: "DuplicateAccount",
          userId: input.userId,
          calendarId: input.calendarId,
        })
      }
      return err({ _tag: "StoreError", message: created.error._tag })
    }

    logger.info("account.registered", {
      accountId: created.value.accountId,
      provider: "google-calendar",
      calendarId: input.calendarId,
      channelExpiresAt: watch.value.expiration.toISOString(),
    })
    // Persist the seed events alongside the account so the worker emits
    // trigger jobs for whatever exists at registration time. We do this
    // after createAccount so that the (account, events) pair is consistent.
    if (drained.value.events.length > 0) {
      const commit = await store.commitEvents({
        accountId: created.value.accountId,
        events: drained.value.events.map((e) => ({ ...e, accountId: created.value.accountId })),
        newSyncToken: seedSyncToken,
        now: clock(),
      })
      if (!commit.ok) {
        logger.warn("event.seed_commit_failed", {
          accountId: created.value.accountId,
          error: commit.error._tag,
        })
      }
    }

    return ok({ accountId: created.value.accountId })
  }

  const renewExpiringChannels = async (): Promise<Result<RenewSummary, never>> => {
    const cutoff = new Date(clock().getTime() + config.renewalWindowMs)
    const list = await store.listAccountsExpiringChannel("google-calendar", cutoff)
    if (!list.ok) {
      logger.warn("watch.renew_list_failed", { error: list.error._tag })
      return ok({ renewed: 0, failed: 0, revoked: 0, details: [] })
    }

    const summary: {
      renewed: number
      failed: number
      revoked: number
      details: Array<{
        accountId: CalendarAccountId
        calendarId: string
        outcome: "renewed" | "failed" | "revoked"
        error?: string
      }>
    } = { renewed: 0, failed: 0, revoked: 0, details: [] }

    const queue = [...list.value]
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const account = queue.shift()
        if (!account) return
        const refreshToken =
          (account.credentials as { refreshToken?: string }).refreshToken ?? ""
        const client = buildClient(refreshToken, account)

        const oldChannelId = account.channelId
        const oldResourceId = account.resourceId
        const oldExpiry = account.channelExpiresAt

        // Allocate a fresh channel id so notifications continue without
        // ambiguity if the old channel briefly overlaps with the new.
        const newChannelId = makeChannelId(crypto.randomUUID())
        const newToken = deriveChannelToken(config.channelTokenSecret, newChannelId)
        const address = webhookUrl(config.webhookBaseUrl, config.webhookPath)

        const watch = await client.watch({
          calendarId: account.calendarId,
          channelId: newChannelId,
          address,
          token: newToken,
          ttlMs: config.channelTtlMs,
        })
        if (!watch.ok) {
          if (watch.error._tag === "CredentialsRevoked") {
            await store.updateAccount(account.accountId, {
              status: "revoked",
              now: clock(),
            })
            logger.error("account.revoked", {
              accountId: account.accountId,
              reason: watch.error.reason,
            })
            summary.revoked += 1
            summary.details.push({
              accountId: account.accountId,
              calendarId: account.calendarId,
              outcome: "revoked",
              error: watch.error.reason,
            })
            continue
          }
          summary.failed += 1
          summary.details.push({
            accountId: account.accountId,
            calendarId: account.calendarId,
            outcome: "failed",
            error: "_tag" in watch.error ? watch.error._tag : "unknown",
          })
          continue
        }

        const upd = await store.updateAccount(account.accountId, {
          channelId: newChannelId,
          resourceId: watch.value.resourceId,
          channelExpiresAt: watch.value.expiration,
          now: clock(),
        })
        if (!upd.ok) {
          // Compensate: stop the freshly-created channel so we don't leak it.
          const stop = await client.stop({
            channelId: newChannelId,
            resourceId: watch.value.resourceId,
          })
          if (!stop.ok) {
            logger.warn("watch.compensating_stop_failed", {
              calendarId: account.calendarId,
              error: stop.error._tag,
            })
          }
          summary.failed += 1
          summary.details.push({
            accountId: account.accountId,
            calendarId: account.calendarId,
            outcome: "failed",
            error: upd.error._tag,
          })
          continue
        }

        // Best-effort: stop the old channel. If the swap fails here Google's
        // 7-day expiration will clean it up, but logs alert us anyway.
        if (oldChannelId && oldResourceId) {
          const stop = await client.stop({
            channelId: oldChannelId,
            resourceId: oldResourceId,
          })
          if (!stop.ok) {
            logger.warn("watch.old_channel_stop_failed", {
              accountId: account.accountId,
              channelId: oldChannelId,
              error: stop.error._tag,
            })
          }
        }

        summary.renewed += 1
        summary.details.push({
          accountId: account.accountId,
          calendarId: account.calendarId,
          outcome: "renewed",
        })
        logger.info("account.channel_renewed", {
          accountId: account.accountId,
          oldExpiry: oldExpiry?.toISOString() ?? null,
          newExpiry: watch.value.expiration.toISOString(),
        })
      }
    }

    const workers: Array<Promise<void>> = []
    for (let i = 0; i < Math.min(RENEW_CONCURRENCY, queue.length); i++)
      workers.push(worker())
    await Promise.all(workers)
    return ok(summary)
  }

  return { register, renewExpiringChannels }
}
