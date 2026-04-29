import type { calendar_v3 } from "@googleapis/calendar"
import type {
  CalendarAccount,
  CalendarAccountId,
  CalendarChangeEvent,
  CalendarEvent,
  CalendarPipeline,
  CalendarEventId,
  ChannelId,
  IngressError,
  ResolverError,
  Result,
  StationLogger,
  StoreAdapter,
  SyncTokenType,
  UserIdType,
} from "calendar-station"

export type GoogleCalendarConfig = {
  /** OAuth2 client id (Google Cloud → APIs & Services → Credentials). */
  readonly googleClientId: string
  readonly googleClientSecret: string
  /** Public base URL of the webhook endpoint, e.g. `https://api.dterminal.net`. */
  readonly webhookBaseUrl: string
  /** Path component, e.g. `/webhooks/calendar`. Full URL = base + path. */
  readonly webhookPath: string
  /**
   * Server-side secret used to derive `X-Goog-Channel-Token` from each
   * channel id (HMAC-SHA256). Validates inbound webhooks; never sent to
   * clients.
   */
  readonly channelTokenSecret: string
  /**
   * Channel TTL request, in ms. Channels max out at 7 days; this is the
   * value passed in `events.watch`. Defaults to 7d.
   */
  readonly channelTtlMs?: number
  /**
   * Renewal lookahead window. accounts.channelExpiresAt within `now + window`
   * are considered candidates for renewal. Defaults to 24h.
   */
  readonly renewalWindowMs?: number
  /** Page size for `events.list`. Defaults to 250 (Google's max is 2500). */
  readonly listPageSize?: number
  /** events.list fan-out / parsing concurrency per resolve(). Defaults to 4. */
  readonly listConcurrency?: number
  /**
   * Webhook ingress mode:
   *   - `"sync"`     : process the change inline; respond 200 only after commit.
   *                    Latency-coupled to the pipeline; higher tail latency on
   *                    Google's side, but no lost events on commit failure.
   *   - `"deferred"` : enqueue the change to an in-memory worker, ack 200 right
   *                    away. Lower tail latency; on commit failure the event is
   *                    lost (Google won't redeliver since we acked). Good for
   *                    high-volume calendars where retries are expensive.
   * Defaults to `"sync"`.
   */
  readonly ingressMode?: "sync" | "deferred"
  /**
   * Soft deadline for the synchronous pipeline call inside the webhook handler.
   * Anything slower returns 5xx so Google retries. Defaults to 8s, well under
   * Google's documented tolerance.
   */
  readonly commitTimeoutMs?: number
  /** Inject a fake transport for tests. */
  readonly clientFactory?: GoogleCalendarClientFactory
}

export type ResolvedGoogleCalendarConfig = {
  readonly googleClientId: string
  readonly googleClientSecret: string
  readonly webhookBaseUrl: string
  readonly webhookPath: string
  readonly channelTokenSecret: string
  readonly channelTtlMs: number
  readonly renewalWindowMs: number
  readonly listPageSize: number
  readonly listConcurrency: number
  readonly ingressMode: "sync" | "deferred"
  readonly commitTimeoutMs: number
  readonly clientFactory?: GoogleCalendarClientFactory
}

export type GoogleCalendarCredentials = {
  readonly refreshToken: string
  readonly accessToken?: string
  readonly accessTokenExpiresAt?: Date
}

/**
 * Per-account API surface used by the resolver and watch manager. Wraps
 * `@googleapis/calendar` plus OAuth2 refresh + retry. Returns `Result` so
 * callers never have to try/catch around SDK quirks.
 */
export type GoogleCalendarClient = {
  /**
   * Validate the refresh token via a token-endpoint round trip. Used by
   * `register` to fast-fail on `invalid_grant` before calling watch.
   */
  validateRefreshToken(): Promise<Result<void, ResolverError>>
  /**
   * `events.list` paginated. Pass `syncToken` for incremental sync; omit it
   * for the initial seed / 410-recovery drain. Returns parsed Google events
   * (for translation by the caller) and the new `nextSyncToken`.
   */
  eventsList(input: {
    calendarId: string
    syncToken?: string
    pageToken?: string
    maxResults?: number
  }): Promise<
    Result<
      {
        items: ReadonlyArray<calendar_v3.Schema$Event>
        nextPageToken?: string
        nextSyncToken?: string
      },
      ResolverError | { _tag: "SyncTokenGone" }
    >
  >
  /** events.watch — start a webhook channel. */
  watch(input: {
    calendarId: string
    channelId: string
    address: string
    token: string
    ttlMs: number
  }): Promise<
    Result<{ resourceId: string; expiration: Date }, ResolverError>
  >
  /** channels.stop — best-effort tear-down on swap or revoke. */
  stop(input: { channelId: string; resourceId: string }): Promise<Result<void, ResolverError>>
}

export type GoogleCalendarClientFactory = (
  credentials: GoogleCalendarCredentials,
  options: {
    config: ResolvedGoogleCalendarConfig
    onTokenRefresh: (creds: GoogleCalendarCredentials) => void
  },
) => GoogleCalendarClient

/**
 * Decoded webhook headers. Built from the raw `X-Goog-*` strings the request
 * handler receives. `body` is unused by Google (always empty) but recorded
 * for the trace.
 */
export type WebhookNotification = {
  readonly channelId: string
  readonly channelToken: string
  readonly resourceId: string
  readonly resourceState: "sync" | "exists" | "not_exists" | string
  readonly messageNumber: string | null
  readonly resourceUri: string | null
  readonly channelExpiration: string | null
}

export type GoogleCalendarProviderApi = {
  register(input: {
    userId: UserIdType
    calendarId: string
    refreshToken: string
  }): Promise<Result<{ accountId: CalendarAccountId }, RegisterError>>
  renewExpiringChannels(): Promise<Result<RenewSummary, never>>
  /**
   * Framework-agnostic webhook handler. Pass headers (lower-cased keys
   * recommended) and the raw body. Returns the response status + body
   * to write back to the client.
   */
  handleWebhook(input: {
    headers: Record<string, string | string[] | undefined>
    body?: string | Buffer | null
  }): Promise<{ status: number; body?: string }>
}

export type RegisterError =
  | { _tag: "DuplicateAccount"; userId: UserIdType; calendarId: string }
  | { _tag: "InvalidGrant"; reason: string }
  | { _tag: "ProviderTransient"; message: string; cause?: unknown }
  | { _tag: "ProviderPermanent"; message: string; cause?: unknown }
  | { _tag: "StoreError"; message: string }

export type RenewSummary = {
  readonly renewed: number
  readonly failed: number
  readonly revoked: number
  readonly details: ReadonlyArray<{
    accountId: CalendarAccountId
    calendarId: string
    outcome: "renewed" | "failed" | "revoked"
    error?: string
  }>
}

export type GoogleCalendarRuntimeDeps = {
  readonly store: StoreAdapter
  readonly pipeline: CalendarPipeline
  readonly logger: StationLogger
  readonly clock: () => Date
  readonly config: ResolvedGoogleCalendarConfig
}

export type {
  CalendarAccount,
  CalendarAccountId,
  CalendarChangeEvent,
  CalendarEvent,
  CalendarEventId,
  ChannelId,
  IngressError,
  ResolverError,
  StoreAdapter,
  SyncTokenType,
  UserIdType,
}
