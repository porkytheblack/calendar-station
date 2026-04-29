# API surface

Every public symbol exported from `calendar-station`, `google-calendar-station`, and `calendar-station-conformance`. If a user-supplied symbol isn't in this file, it doesn't exist.

## `calendar-station` exports

### Factory + types

```ts
createStation<P extends Record<string, ProviderFactory>>(input: StationInput<P>): Station<P>

type StationInput<P> = {
  store:    StoreAdapter
  handler:  CalendarEventHandlerFn
  config?:  WorkerConfig         // worker concurrency, backoff, etc.
  providers: P                   // typed map; v1 must have exactly 1 key
  logger?:  StationLogger        // defaults to consoleLogger
}

type Station<P> = {
  start(): Promise<void>
  stop():  Promise<void>
  wait():  Promise<void>
  readonly providers: ProviderApis<P>   // station.providers.google.register(...) etc.
  readonly pipeline:  CalendarPipeline
}
```

### Result type

```ts
type Result<T, E> =
  | { ok: true;  value: T }
  | { ok: false; error: E }

const ok  = <T>(value: T) => ({ ok: true, value })
const err = <E>(error: E) => ({ ok: false, error })

isOk, isErr            // type guards
map, mapErr            // value/error transforms
```

### Branded IDs

```ts
CalendarAccountId, CalendarEventId, ChannelId, JobId, SyncToken, UserId
                       // value-side smart constructors (each is `Brand.nominal<T>()`)
CalendarAccountIdType, CalendarEventIdType, ChannelIdType, JobIdType, SyncTokenType, UserIdType
                       // type aliases

newCalendarAccountId() // crypto.randomUUID-backed
newChannelId()         // crypto.randomUUID-backed
```

Use the constructors to produce branded values: `UserId("user-1")`, `SyncToken("CkASCgo...")`, `ChannelId(uuid)`. Pass them through; don't unwrap.

### Backoff

```ts
defaultBackoff: BackoffConfig = { baseMs: 30_000, factor: 2, maxMs: 5*60_000, jitterFactor: 0.25 }
nextAttemptDelayMs(attempts, config, random?): number
computeNextAttemptAt(now, attempts, config, random?): Date
```

Curve with defaults: 30s, 1m, 2m, 4m, 5m, 5m, … (capped) ±25% jitter.

### Logger

```ts
consoleLogger        // JSON-line stdout
noopLogger           // discards everything

interface StationLogger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}
```

### Data model

```ts
type Provider = "google-calendar"  // single-member union; will widen

type Person = { displayName: string | null; email: string | null }

type ResponseStatus = "needsAction" | "declined" | "tentative" | "accepted"

type Attendee = {
  email:           string | null
  displayName:     string | null
  organizer:       boolean
  self:            boolean
  resource:        boolean       // a meeting room or other resource
  optional:        boolean
  responseStatus:  ResponseStatus
  comment:         string | null
}

type EventTime = {
  // exactly one of dateTime or date is non-null
  dateTime: Date   | null   // precise instant
  date:     string | null   // YYYY-MM-DD for all-day events
  timeZone: string | null   // IANA tz, e.g. "America/Los_Angeles"
}

type EventStatus = "confirmed" | "tentative" | "cancelled"

type ConferenceRef = {
  conferenceId:        string | null
  conferenceSolution:  string | null    // "Google Meet", "Zoom", etc.
  entryPoints: ReadonlyArray<{
    type:  string                       // "video" | "phone" | "more" | ...
    uri:   string | null
    label: string | null
  }>
}

type CalendarEvent = {
  eventId:     CalendarEventId
  icalUid:     string | null      // RFC5545 iCalUID; stable across instances of a series
  accountId:   CalendarAccountId
  provider:    "google-calendar"
  calendarId:  string             // e.g. "primary" or a calendar id

  summary:     string
  description: string
  location:    string | null
  status:      EventStatus
  htmlLink:    string | null

  start:       EventTime
  end:         EventTime
  allDay:      boolean             // true iff start.date is set and dateTime is null

  creator:     Person | null
  organizer:   Person | null
  attendees:   ReadonlyArray<Attendee>

  recurrence:        ReadonlyArray<string>            // RRULE/RDATE/EXDATE strings
  recurringEventId:  CalendarEventId | null           // set on instance overrides
  originalStartTime: EventTime | null                 // for instance overrides

  conference:   ConferenceRef | null
  hangoutLink:  string | null

  createdAt:    Date | null
  updatedAt:    Date | null
  etag:         string | null
  sequence:     number
}

type AccountStatus = "active" | "paused" | "revoked"

type CalendarAccount = {
  accountId:        CalendarAccountId
  userId:           UserId
  provider:         "google-calendar"
  calendarId:       string                   // "primary" or a specific calendar id
  status:           AccountStatus
  credentials:      Record<string, unknown>  // opaque to core; google provider stores { refreshToken, accessToken?, accessTokenExpiresAt? }

  syncToken:        SyncToken | null
  channelId:        ChannelId | null
  resourceId:       string | null            // Google-issued; required to call channels.stop
  channelExpiresAt: Date | null

  createdAt, updatedAt: Date
}

type CalendarChangeEvent = {
  eventId:         string                  // synthetic — channelId + messageNumber
  providerPayload: unknown                 // opaque to core; resolver decodes (the ingress already did the work)
  receivedAt:      Date
}

type TriggerJobState = "pending" | "succeeded" | "failed"
type TriggerJob = {
  jobId:           JobId
  eventId:         CalendarEventId
  accountId:       CalendarAccountId
  state:           TriggerJobState
  attempts:        number
  lastError:       string | null
  nextAttemptAt:   Date | null    // null when state != "pending"
  claimedAt:       Date | null
  claimedBy:       string | null
  leaseExpiresAt:  Date | null
  createdAt:       Date
  completedAt:     Date | null
}
```

### Handler contract

```ts
type HandlerContext = { jobId: JobId; accountId: CalendarAccountId; attempt: number }

type CalendarEventHandlerFn = (
  event: CalendarEvent,
  ctx:   HandlerContext,
) => Promise<Result<void, HandlerError>>

type HandlerError =
  | { _tag: "Transient";  message: string; cause?: unknown }
  | { _tag: "Permanent";  message: string; cause?: unknown }
```

`Transient` → retry per backoff. `Permanent` → dead-letter immediately. Uncaught throws are treated as `Transient` (kernel backstop).

### Store

See `store-contract.md`. Exports: `StoreAdapter` interface, the input/output types (`CreateAccountInput`, `AccountPatch`, `CommitEventsInput`, `ClaimTriggerInput`, `ClaimedJob`).

### Worker config

```ts
type WorkerConfig = {
  workerId?:           string                 // defaults to host-pid-rand
  triggerConcurrency?: number                 // default 8
  claimBatchSize?:     number                 // default 16; must be >= triggerConcurrency
  leaseDurationMs?:    number                 // default 5 min
  idlePollIntervalMs?: number                 // default 1s
  maxAttempts?:        number                 // default 10
  backoff?:            Partial<BackoffConfig>
  clock?:              () => Date             // for tests
  random?:             () => number           // for tests
}

resolveWorkerConfig(input?: WorkerConfig): ResolvedWorkerConfig   // exposes the merged result
```

### Pipeline + provider plugin shape (rarely-needed internals, but exported)

```ts
createPipeline(deps: PipelineDeps): CalendarPipeline   // for tests / custom providers

interface ProviderRuntime {
  resolver: CalendarChangeResolver
  start(): Promise<void>
  stop():  Promise<void>
  wait():  Promise<void>
}
interface ProviderFactory<API = unknown> {
  build(deps: ProviderBuildDeps): ProviderRuntime & { api: API }
}
type ProviderBuildDeps = { store: StoreAdapter; pipeline: CalendarPipeline; logger: StationLogger; clock: () => Date }

interface CalendarChangeResolver {
  resolve(event: CalendarChangeEvent): Promise<Result<ResolveResult, ResolverError>>
}

type ResolveResult = {
  accountId:    CalendarAccountId
  events:       ReadonlyArray<CalendarEvent>
  newSyncToken: SyncToken
}
```

## `calendar-station/effect` exports

Same kernel, Effect-typed skin:

```ts
import { createStationEffect, StationService, stationLayer } from "calendar-station/effect"
```

Use only if the consumer is already on Effect-TS. The Promise + Result API is the default.

## `google-calendar-station` exports

```ts
googleCalendarProvider(input: GoogleCalendarConfig): ProviderFactory<GoogleCalendarProviderApi>

defaultGoogleCalendarClientFactory   // production OAuth2 + @googleapis/calendar
parseGoogleEvent                     // Schema$Event → CalendarEvent (pure)
decodeWebhook                        // headers map → WebhookNotification
deriveChannelToken                   // (secret, channelId) → HMAC-SHA256 hex
verifyChannelToken                   // constant-time string compare
syntheticEventId                     // (channelId, messageNumber) → "ch::n"
webhookUrl                           // (baseUrl, path) → joined URL
```

### `GoogleCalendarConfig`

```ts
type GoogleCalendarConfig = {
  // Required
  googleClientId:     string                 // OAuth client id
  googleClientSecret: string                 // OAuth client secret
  webhookBaseUrl:     string                 // e.g. "https://api.example.com" (HTTPS, CA-signed)
  webhookPath:        string                 // e.g. "/webhooks/calendar"
  channelTokenSecret: string                 // 32-byte hex. HMAC secret for X-Goog-Channel-Token

  // Optional with sensible defaults
  channelTtlMs?:      number                 // default 7 days; passed to events.watch
  renewalWindowMs?:   number                 // default 24h; lookahead window for renewExpiringChannels
  listPageSize?:      number                 // default 250 (Google max 2500)
  listConcurrency?:   number                 // default 4
  ingressMode?:       "sync" | "deferred"    // default "sync"
  commitTimeoutMs?:   number                 // default 8s; soft deadline inside webhook handler

  // For tests
  clientFactory?:     GoogleCalendarClientFactory
}
```

### Ingress modes

- `"sync"` — webhook handler awaits the pipeline; HTTP 200 only after commit. Latency-coupled to commit; no lost events on commit failure (Google retries on 5xx).
- `"deferred"` — webhook handler enqueues into an in-memory queue and returns 200 immediately. Lower tail latency. On commit failure the event is *dropped* (Google won't redeliver since we acked). Good for high-volume calendars where retries are expensive.

### `GoogleCalendarProviderApi` (what `station.providers.google` exposes)

```ts
register(input: { userId: UserIdType; calendarId: string; refreshToken: string })
  : Promise<Result<{ accountId: CalendarAccountId }, RegisterError>>

renewExpiringChannels(): Promise<Result<RenewSummary, never>>

handleWebhook(input: {
  headers: Record<string, string | string[] | undefined>
  body?:   string | Buffer | null
}): Promise<{ status: number; body?: string }>
```

`RegisterError` tags: `DuplicateAccount` | `InvalidGrant` | `ProviderTransient` | `ProviderPermanent` | `StoreError`.

`RenewSummary`:
```ts
{
  renewed: number
  failed:  number
  revoked: number   // accounts whose refresh token was rejected; status moved to "revoked"
  details: Array<{ accountId; calendarId; outcome: "renewed"|"failed"|"revoked"; error? }>
}
```

`handleWebhook` returns `{ status, body? }`:
| Status | Meaning |
|---|---|
| 200 | acked (pipeline committed, sync handshake, unknown-channel ignore, or deferred-mode immediate-ack) |
| 400 | malformed headers (missing channel id / resource id / state) |
| 401 | channel token mismatch (HMAC verify failed) |
| 503 | pipeline nack, commit timeout, or shutting down — Google retries |

### `WebhookNotification`

```ts
type WebhookNotification = {
  channelId:         string
  channelToken:      string                            // value sent by Google in X-Goog-Channel-Token
  resourceId:        string
  resourceState:     "sync" | "exists" | "not_exists" | string
  messageNumber:     string | null
  resourceUri:       string | null
  channelExpiration: string | null
}
```

`resourceState` semantics:
- `sync` — channel-creation handshake (one POST immediately after `events.watch`). Ack-and-forget.
- `exists` — actual change. Triggers `events.list?syncToken=…`.
- `not_exists` — calendar resource deleted. Ingress stops the channel and clears persisted channel state.

## `calendar-station-conformance` exports

```ts
runStoreConformance(input: ConformanceInput): void

type ConformanceInput = {
  name: string
  makeStore: () => Promise<{ store: StoreAdapter; teardown?: () => Promise<void> }>
}

createReferenceStore()      // in-memory reference; passes the suite by definition
type ReferenceStore = StoreAdapter & {
  _accounts(): ReadonlyArray<CalendarAccount>
  _events():   ReadonlyArray<CalendarEvent>
  _jobs():     ReadonlyArray<TriggerJob>
}

// fixtures
synthEvent(overrides: Partial<CalendarEvent> & { accountId; eventId }): CalendarEvent
aUserId(s?: string): UserIdType
anAccountId(): CalendarAccountId
anEventId(s: string): CalendarEventId
aChannelId(s?: string): ChannelId
aSyncToken(s: string): SyncToken
```

Invoke `runStoreConformance` from a `*.test.ts` — it calls Vitest's `describe`/`it` internally.

The current battery is 23 tests covering: account lifecycle (including channel rotation by id), atomic + idempotent commit (with re-enqueue on update), claim semantics under lease (mutex across concurrent workers), and trigger state transitions (done / retry / dead-letter).
