import type {
  CalendarAccountId,
  CalendarEventId,
  ChannelId,
  JobId,
  SyncToken,
  UserId,
} from "./ids.js"

export type Provider = "google-calendar"

export type Person = {
  readonly displayName: string | null
  readonly email: string | null
}

export type ResponseStatus = "needsAction" | "declined" | "tentative" | "accepted"

export type Attendee = {
  readonly email: string | null
  readonly displayName: string | null
  readonly organizer: boolean
  readonly self: boolean
  readonly resource: boolean
  readonly optional: boolean
  readonly responseStatus: ResponseStatus
  readonly comment: string | null
}

export type EventTime = {
  /** Either a precise instant (dateTime) or a calendar date (allDay). */
  readonly dateTime: Date | null
  readonly date: string | null
  readonly timeZone: string | null
}

export type EventStatus = "confirmed" | "tentative" | "cancelled"

export type ConferenceRef = {
  readonly conferenceId: string | null
  readonly conferenceSolution: string | null
  readonly entryPoints: ReadonlyArray<{
    readonly type: string
    readonly uri: string | null
    readonly label: string | null
  }>
}

export type CalendarEvent = {
  readonly eventId: CalendarEventId
  /** RFC5545 iCalUID. Stable across instances of a recurring series. */
  readonly icalUid: string | null
  readonly accountId: CalendarAccountId
  readonly provider: Provider
  readonly calendarId: string

  readonly summary: string
  readonly description: string
  readonly location: string | null
  readonly status: EventStatus
  readonly htmlLink: string | null

  readonly start: EventTime
  readonly end: EventTime
  /** True if this event is an all-day event (start.date is set, dateTime null). */
  readonly allDay: boolean

  readonly creator: Person | null
  readonly organizer: Person | null
  readonly attendees: ReadonlyArray<Attendee>

  /** RRULE / RDATE / EXDATE strings, in the order Google returns them. */
  readonly recurrence: ReadonlyArray<string>
  /** Set on a single instance that overrides a recurring series. */
  readonly recurringEventId: CalendarEventId | null
  /** Original start time of the overridden instance, if applicable. */
  readonly originalStartTime: EventTime | null

  readonly conference: ConferenceRef | null
  readonly hangoutLink: string | null

  readonly createdAt: Date | null
  readonly updatedAt: Date | null
  /** Google's per-event ETag, if available. */
  readonly etag: string | null
  /** Sequence number for cancellation/update detection. */
  readonly sequence: number
}

export type AccountStatus = "active" | "paused" | "revoked"

export type CalendarAccount = {
  readonly accountId: CalendarAccountId
  readonly userId: UserId
  readonly provider: Provider
  /** The Google calendar this account watches; "primary" or a specific id. */
  readonly calendarId: string
  readonly status: AccountStatus
  readonly credentials: Record<string, unknown>

  readonly syncToken: SyncToken | null
  readonly channelId: ChannelId | null
  /** Google-issued resource id, returned by events.watch. Required for stop. */
  readonly resourceId: string | null
  readonly channelExpiresAt: Date | null

  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Provider-shaped change-notification event. The webhook ingress decodes
 * Google's empty-body POST + headers into this shape and feeds it to the
 * pipeline. `providerPayload` holds the parsed headers; `eventId` is a
 * synthetic id (channelId + messageNumber) for tracing.
 */
export type CalendarChangeEvent = {
  readonly eventId: string
  readonly providerPayload: unknown
  readonly receivedAt: Date
}

export type TriggerJobState = "pending" | "succeeded" | "failed"

export type TriggerJob = {
  readonly jobId: JobId
  readonly eventId: CalendarEventId
  readonly accountId: CalendarAccountId
  readonly state: TriggerJobState
  readonly attempts: number
  readonly lastError: string | null
  readonly nextAttemptAt: Date | null
  readonly claimedAt: Date | null
  readonly claimedBy: string | null
  readonly leaseExpiresAt: Date | null
  readonly createdAt: Date
  readonly completedAt: Date | null
}

// ---------- Store I/O ----------

export type CreateAccountInput = {
  readonly userId: UserId
  readonly provider: Provider
  readonly calendarId: string
  readonly credentials: Record<string, unknown>
  readonly syncToken: SyncToken | null
  readonly channelId: ChannelId | null
  readonly resourceId: string | null
  readonly channelExpiresAt: Date | null
  readonly now: Date
}

export type AccountPatch = {
  readonly status?: AccountStatus
  readonly credentials?: Record<string, unknown>
  readonly syncToken?: SyncToken | null
  readonly channelId?: ChannelId | null
  readonly resourceId?: string | null
  readonly channelExpiresAt?: Date | null
  readonly now: Date
}

export type CommitEventsInput = {
  readonly accountId: CalendarAccountId
  readonly events: ReadonlyArray<CalendarEvent>
  readonly newSyncToken: SyncToken
  readonly now: Date
}

export type ClaimTriggerInput = {
  readonly workerId: string
  readonly limit: number
  readonly leaseDurationMs: number
  readonly now: Date
}

export type ClaimedJob = {
  readonly job: TriggerJob
  readonly event: CalendarEvent
}

// ---------- Errors ----------

export type StoreError =
  | { readonly _tag: "Transient"; readonly message: string; readonly cause?: unknown }
  | { readonly _tag: "Permanent"; readonly message: string; readonly cause?: unknown }
  | {
      readonly _tag: "AccountNotFound"
      readonly accountId?: CalendarAccountId
      readonly channelId?: ChannelId
      readonly calendarId?: string
    }
  | {
      readonly _tag: "DuplicateAccount"
      readonly provider: Provider
      readonly userId: UserId
      readonly calendarId: string
    }

export type ResolverError =
  | { readonly _tag: "MalformedNotification"; readonly details: string }
  | { readonly _tag: "AccountNotFound"; readonly channelId?: ChannelId; readonly calendarId?: string }
  | { readonly _tag: "AccountPaused"; readonly accountId: CalendarAccountId }
  | { readonly _tag: "AccountRevoked"; readonly accountId: CalendarAccountId }
  | { readonly _tag: "ChannelTokenMismatch"; readonly channelId: ChannelId }
  | { readonly _tag: "CalendarGone"; readonly accountId: CalendarAccountId }
  | { readonly _tag: "CredentialsRevoked"; readonly accountId: CalendarAccountId; readonly reason: string }
  | { readonly _tag: "ProviderTransient"; readonly message: string; readonly statusCode?: number; readonly cause?: unknown }
  | { readonly _tag: "ProviderPermanent"; readonly message: string; readonly statusCode?: number; readonly cause?: unknown }

export type IngressError =
  | { readonly _tag: "DecodeError"; readonly message: string }
  | { readonly _tag: "UnknownChannel"; readonly channelId: string }
  | { readonly _tag: "TokenMismatch"; readonly channelId: string }

export type HandlerError =
  | { readonly _tag: "Transient"; readonly message: string; readonly cause?: unknown }
  | { readonly _tag: "Permanent"; readonly message: string; readonly cause?: unknown }

// ---------- Pipeline / Resolver / Handler contracts ----------

export type ResolveResult = {
  readonly accountId: CalendarAccountId
  readonly events: ReadonlyArray<CalendarEvent>
  readonly newSyncToken: SyncToken
}

export interface CalendarChangeResolver {
  resolve(
    event: CalendarChangeEvent,
  ): Promise<import("./result.js").Result<ResolveResult, ResolverError>>
}

export type HandlerContext = {
  readonly jobId: JobId
  readonly accountId: CalendarAccountId
  readonly attempt: number
}

export type CalendarEventHandlerFn = (
  event: CalendarEvent,
  ctx: HandlerContext,
) => Promise<import("./result.js").Result<void, HandlerError>>

export interface CalendarPipeline {
  processEvent(event: CalendarChangeEvent): Promise<"ack" | "nack">
}

// ---------- Logger ----------

export interface StationLogger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

// ---------- Store interface ----------

export interface StoreAdapter {
  createAccount(
    input: CreateAccountInput,
  ): Promise<import("./result.js").Result<CalendarAccount, StoreError>>
  getAccount(
    accountId: CalendarAccountId,
  ): Promise<import("./result.js").Result<CalendarAccount, StoreError>>
  getAccountByChannelId(
    channelId: ChannelId,
  ): Promise<import("./result.js").Result<CalendarAccount, StoreError>>
  getAccountByCalendar(
    provider: Provider,
    userId: UserId,
    calendarId: string,
  ): Promise<import("./result.js").Result<CalendarAccount, StoreError>>
  updateAccount(
    accountId: CalendarAccountId,
    patch: AccountPatch,
  ): Promise<import("./result.js").Result<CalendarAccount, StoreError>>
  listAccountsExpiringChannel(
    provider: Provider,
    before: Date,
  ): Promise<import("./result.js").Result<ReadonlyArray<CalendarAccount>, StoreError>>

  commitEvents(
    input: CommitEventsInput,
  ): Promise<
    import("./result.js").Result<
      { readonly committedEventIds: ReadonlyArray<CalendarEventId> },
      StoreError
    >
  >

  claimTriggerJobs(
    input: ClaimTriggerInput,
  ): Promise<import("./result.js").Result<ReadonlyArray<ClaimedJob>, StoreError>>
  markTriggerDone(
    jobId: JobId,
    now: Date,
  ): Promise<import("./result.js").Result<void, StoreError>>
  markTriggerFailed(
    jobId: JobId,
    error: string,
    nextAttemptAt: Date | null,
    now: Date,
  ): Promise<import("./result.js").Result<void, StoreError>>
}

// ---------- Worker config ----------

export type BackoffConfig = {
  readonly baseMs: number
  readonly factor: number
  readonly maxMs: number
  readonly jitterFactor: number
}

export type WorkerConfig = {
  readonly workerId?: string
  readonly triggerConcurrency?: number
  readonly claimBatchSize?: number
  readonly leaseDurationMs?: number
  readonly idlePollIntervalMs?: number
  readonly maxAttempts?: number
  readonly backoff?: Partial<BackoffConfig>
  readonly clock?: () => Date
  readonly random?: () => number
}

export type ResolvedWorkerConfig = {
  readonly workerId: string
  readonly triggerConcurrency: number
  readonly claimBatchSize: number
  readonly leaseDurationMs: number
  readonly idlePollIntervalMs: number
  readonly maxAttempts: number
  readonly backoff: BackoffConfig
  readonly clock: () => Date
  readonly random: () => number
}

// ---------- Provider plugin shape ----------

export interface ProviderRuntime {
  readonly resolver: CalendarChangeResolver
  start(): Promise<void>
  stop(): Promise<void>
  wait(): Promise<void>
}

export interface ProviderFactory<API = unknown> {
  /** internal: wire-up called by createStation */
  build(deps: ProviderBuildDeps): ProviderRuntime & { api: API }
}

export type ProviderBuildDeps = {
  readonly store: StoreAdapter
  readonly pipeline: CalendarPipeline
  readonly logger: StationLogger
  readonly clock: () => Date
}
