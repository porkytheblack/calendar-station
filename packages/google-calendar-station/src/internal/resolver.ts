import { SyncToken as makeSyncToken, err, ok } from "calendar-station"
import type {
  CalendarAccount,
  CalendarChangeEvent,
  CalendarChangeResolver,
  CalendarEvent,
  ChannelId,
  ResolveResult,
  ResolverError,
  Result,
  StoreError,
} from "calendar-station"
import { defaultGoogleCalendarClientFactory } from "./client.js"
import { parseGoogleEvent } from "./parser.js"
import { deriveChannelToken, verifyChannelToken } from "./webhook.js"
import type {
  GoogleCalendarClient,
  GoogleCalendarCredentials,
  GoogleCalendarRuntimeDeps,
  WebhookNotification,
} from "./types.js"

const MAX_PAGES = 1000 // safety stop; calendars rarely emit anywhere near this in one tick

export const createGoogleCalendarResolver = (
  deps: GoogleCalendarRuntimeDeps,
): CalendarChangeResolver => {
  const { store, logger, clock, config } = deps

  const buildClient = (account: CalendarAccount): GoogleCalendarClient => {
    const creds = readCredentials(account)
    const factory = config.clientFactory ?? defaultGoogleCalendarClientFactory
    return factory(creds, {
      config,
      onTokenRefresh: (next) => {
        void store
          .updateAccount(account.accountId, {
            credentials: { ...account.credentials, ...next },
            now: clock(),
          })
          .catch((cause) => {
            logger.warn("oauth.writeback_failed", {
              accountId: account.accountId,
              error: cause instanceof Error ? cause.message : String(cause),
            })
          })
      },
    })
  }

  const resolve = async (
    event: CalendarChangeEvent,
  ): Promise<Result<ResolveResult, ResolverError>> => {
    const payload = event.providerPayload as WebhookNotification | null
    if (!payload || typeof payload !== "object" || !("channelId" in payload)) {
      return err({ _tag: "MalformedNotification", details: "missing webhook payload" })
    }

    const channelId = payload.channelId as string
    // Look up the account by channel id.
    const acctR = await store.getAccountByChannelId(channelId as ChannelId)
    if (!acctR.ok) {
      if (acctR.error._tag === "AccountNotFound") {
        return err({ _tag: "AccountNotFound", channelId: channelId as ChannelId })
      }
      return err({ _tag: "ProviderTransient", message: storeErrMessage(acctR.error) })
    }
    const account = acctR.value
    if (account.status === "paused") return err({ _tag: "AccountPaused", accountId: account.accountId })
    if (account.status === "revoked")
      return err({ _tag: "AccountRevoked", accountId: account.accountId })

    // Verify the channel token. Defense-in-depth: the ingress already does
    // this and 401s on mismatch, but if a deferred queue swallowed the
    // header check we fail closed here too.
    const expected = deriveChannelToken(config.channelTokenSecret, channelId)
    if (!verifyChannelToken(expected, payload.channelToken ?? "")) {
      return err({ _tag: "ChannelTokenMismatch", channelId: channelId as ChannelId })
    }

    if (payload.resourceState === "not_exists") {
      return err({ _tag: "CalendarGone", accountId: account.accountId })
    }
    if (payload.resourceState !== "exists") {
      // `sync` is the channel-creation handshake — return zero events
      // and don't advance the syncToken (we already seeded it during register).
      logger.debug("event.sync_handshake", {
        accountId: account.accountId,
        channelId,
      })
      return ok({
        accountId: account.accountId,
        events: [],
        newSyncToken: account.syncToken ?? makeSyncToken(""),
      })
    }

    const client = buildClient(account)
    return await drainList(client, account, logger, config.listPageSize, true)
  }

  return { resolve }
}

/**
 * Iterate `events.list` pages (with or without a syncToken) until
 * `nextSyncToken` shows up. Used both during incremental resolves and during
 * 410-recovery resync.
 */
export const drainList = async (
  client: GoogleCalendarClient,
  account: CalendarAccount,
  logger: GoogleCalendarRuntimeDeps["logger"],
  pageSize: number,
  useStoredSyncToken: boolean,
): Promise<Result<ResolveResult, ResolverError>> => {
  const events: CalendarEvent[] = []
  let pageToken: string | undefined
  let newSyncToken: string | null = null
  let pages = 0

  while (pages < MAX_PAGES) {
    pages++
    const params: Parameters<GoogleCalendarClient["eventsList"]>[0] = {
      calendarId: account.calendarId,
      maxResults: pageSize,
    }
    if (useStoredSyncToken && account.syncToken) {
      params.syncToken = account.syncToken
    }
    if (pageToken) params.pageToken = pageToken
    const r = await client.eventsList(params)
    if (!r.ok) {
      if (r.error._tag === "SyncTokenGone") {
        // Recovery: drain without syncToken to reset to the current state.
        // Matches gmail-station's HistoryGone semantics — no synthetic
        // events for the gap, just realign and emit nothing this tick.
        logger.warn("event.sync_token_gone", {
          accountId: account.accountId,
          oldToken: account.syncToken ?? null,
        })
        return drainList(client, account, logger, pageSize, false)
      }
      if (r.error._tag === "CredentialsRevoked") {
        return err({
          _tag: "CredentialsRevoked",
          accountId: account.accountId,
          reason: r.error.reason,
        })
      }
      return err(r.error)
    }
    for (const item of r.value.items) {
      if (!item.id) continue
      events.push(parseGoogleEvent(item, account.accountId, account.calendarId))
    }
    if (r.value.nextSyncToken) newSyncToken = r.value.nextSyncToken
    pageToken = r.value.nextPageToken
    if (!pageToken) break
  }

  if (!newSyncToken) {
    // Google guarantees nextSyncToken on the final page; if absent, treat
    // as transient and let the pipeline nack so we'll redrive.
    return err({
      _tag: "ProviderTransient",
      message: "events.list completed without nextSyncToken",
    })
  }

  return ok({
    accountId: account.accountId,
    events,
    newSyncToken: makeSyncToken(newSyncToken),
  })
}

const readCredentials = (account: CalendarAccount): GoogleCalendarCredentials => {
  const c = account.credentials as Record<string, unknown>
  const refreshToken = typeof c.refreshToken === "string" ? c.refreshToken : ""
  const accessToken = typeof c.accessToken === "string" ? c.accessToken : undefined
  const expiresAt = c.accessTokenExpiresAt
  let accessTokenExpiresAt: Date | undefined
  if (expiresAt instanceof Date) accessTokenExpiresAt = expiresAt
  else if (typeof expiresAt === "string" || typeof expiresAt === "number") {
    const t = new Date(expiresAt)
    if (!Number.isNaN(t.getTime())) accessTokenExpiresAt = t
  }
  return { refreshToken, accessToken, accessTokenExpiresAt }
}

const storeErrMessage = (e: StoreError): string => {
  switch (e._tag) {
    case "Transient":
    case "Permanent":
      return e.message
    case "AccountNotFound":
      return `account not found ${e.accountId ?? e.channelId ?? e.calendarId ?? ""}`
    case "DuplicateAccount":
      return `duplicate account ${e.calendarId}`
  }
}
