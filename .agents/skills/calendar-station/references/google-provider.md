# Google Calendar provider

`google-calendar-station` plugs into `calendar-station`'s `createStation({ providers })` map. It owns: the Google Calendar API client (with OAuth2 refresh + writeback), the channel-lifecycle manager, the webhook ingress, and the event parser.

## Configuration

```ts
import { googleCalendarProvider } from "google-calendar-station"

const provider = googleCalendarProvider({
  // Required
  googleClientId:     process.env.GOOGLE_CLIENT_ID!,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  webhookBaseUrl:     "https://api.example.com",      // HTTPS, CA-signed cert, public DNS
  webhookPath:        "/webhooks/calendar",           // full URL = base + path
  channelTokenSecret: process.env.CHANNEL_TOKEN_SECRET!, // 32-byte hex; HMAC secret for X-Goog-Channel-Token

  // Optional with sensible defaults
  channelTtlMs:       7 * 24 * 60 * 60 * 1000,        // default 7 days; passed to events.watch
  renewalWindowMs:    24 * 60 * 60 * 1000,            // renew accounts whose channel expires within 24h
  listPageSize:       250,                            // events.list page size (Google max 2500)
  listConcurrency:    4,                              // not used by built-in resolver yet; reserved
  ingressMode:        "sync",                         // "sync" | "deferred"
  commitTimeoutMs:    8_000,                          // soft deadline inside webhook handler

  // For tests
  // clientFactory: (creds, opts) => fakeCalendarClient,
})
```

## GCP-side prerequisites (one-time)

See `oauth-setup.md` for the full walkthrough. Short version:

1. **Enable the Calendar API** in your Google Cloud project (`calendar-json.googleapis.com`). No Pub/Sub needed — Calendar uses webhooks.
2. **Configure the OAuth consent screen** with the scope `https://www.googleapis.com/auth/calendar.readonly`.
3. **Create an OAuth 2.0 Client ID** (type: Web application). Copy client id + secret.
4. **Generate a `channelTokenSecret`** (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
5. **Webhook endpoint must be HTTPS with a CA-signed cert.** Self-signed and `localhost` won't work — Google rejects them when calling `events.watch`. For local dev, tunnel via ngrok / cloudflared.

## Account registration

The user runs their own OAuth flow (out of scope for the package — see `out-of-scope.md`). They end up with a refresh token, scoped at minimum to `calendar.readonly`. Mint with `access_type=offline&prompt=consent` so Google actually issues the refresh token.

```ts
import { UserId } from "calendar-station"

const r = await station.providers.google.register({
  userId:       UserId("user-123"),
  calendarId:   "primary",                             // or a specific calendar id
  refreshToken: "<from your OAuth flow>",
})

if (!r.ok) {
  switch (r.error._tag) {
    case "DuplicateAccount":   // (provider, userId, calendarId) already registered
    case "InvalidGrant":       // refresh token already revoked or wrong scope
    case "ProviderTransient":  // 5xx/429/network — retry
    case "ProviderPermanent":  // 4xx that isn't invalid_grant
    case "StoreError":         // adapter failed (see message for tag)
  }
} else {
  console.log("registered", r.value.accountId)
}
```

What `register` does internally:

1. **Validates** the refresh token via a token-endpoint round trip (fast-fail on `InvalidGrant` before any side effects).
2. **Pre-flight duplicate check** via `getAccountByCalendar(provider, userId, calendarId)`.
3. **Initial seed** — paginated `events.list` (NO `syncToken`) to drain to a stable state. Captures `nextSyncToken` from the final page. Calendar's `events.watch` does NOT return a syncToken (unlike Gmail's `watch` returning `historyId`), so the seed list is mandatory.
4. **events.watch** — allocate a fresh UUID `channelId`, derive `channelToken = HMAC(channelTokenSecret, channelId)`, call with `id, type=web_hook, address=webhookUrl, token, expiration=now+channelTtlMs`. Google returns `resourceId` + actual `expiration`.
5. **Persist** via `Store.createAccount`. Stores `syncToken`, `channelId`, `resourceId`, `channelExpiresAt`, credentials.
6. **Commit seed events** via `Store.commitEvents` — events that already exist on the calendar at registration time get trigger jobs enqueued so handlers see them on first start.

If step 5 fails (e.g. duplicate raced past step 2), the manager calls `channels.stop` to clean up the orphaned watch. The 7-day TTL is the backstop if even that fails.

## Channel lifecycle

Channels expire after ~7 days. Google has **no renewal API** — you create a fresh channel before the old one dies, then stop the old one. The provider does NOT bring its own scheduler. The user calls:

```ts
const summary = await station.providers.google.renewExpiringChannels()
// { renewed, failed, revoked, details: [...] }
```

…on a daily-ish cron (`templates/renewal-cron.ts`). Internally it:

1. `listAccountsExpiringChannel(provider="google-calendar", before=now+renewalWindowMs)`.
2. For each, allocates a fresh UUID `channelId`, calls `events.watch`.
3. Updates `channel_id`, `resource_id`, `channel_expires_at` atomically (via `updateAccount`).
4. Best-effort `channels.stop` on the old channel id + resource id. If this fails, the 7-day TTL eventually expires the old channel anyway; we log `watch.old_channel_stop_failed`.
5. If any account returns `invalid_grant`, status is moved to `revoked` and counted in `summary.revoked`.

Default `renewalWindowMs` is 24h, which assumes daily cron. If your cron runs less frequently (e.g. weekly), you must increase the window proportionally — otherwise channels expire between runs.

There's an inherent overlap window during the swap: notifications might land on the old channel id between the new `events.watch` and the old `channels.stop`. The ingress's `getAccountByChannelId(oldId)` will return `AccountNotFound` after the swap, and the ingress responds **200** in that case — Google stops retrying, the missed change is picked up on the next webhook against the new channel because the syncToken is still valid. No event loss.

## syncToken semantics

`syncToken` is to Calendar what `historyId` is to Gmail. Important differences:

- **Initial seed.** Unlike Gmail's `watch` which returns the seed `historyId` for free, Calendar's `events.watch` does NOT return a syncToken. The package does an initial paginated `events.list` (no syncToken) to drain to a stable state and store `nextSyncToken` from the final page. Only after that does the watch's notifications make sense to diff against.
- **Cursor freshness.** syncTokens have an undocumented but real expiration window. If the worker is offline for too long, the next `events.list?syncToken=...` returns 410 GONE.
- **Recovery on 410.** Same recipe as the initial seed: full re-paginate without syncToken to drain to current state, then store the new `nextSyncToken`. v1 just resets and emits no synthetic events for the gap (matches gmail-station's `HistoryGone` behavior). Log: `event.sync_token_gone`.

## Webhook ingress

Different shape from gmail-station's pull ingress. The package exposes `handleWebhook` — a framework-agnostic request handler with the signature:

```ts
station.providers.google.handleWebhook({
  headers: Record<string, string | string[] | undefined>,
  body?:   string | Buffer | null,
}): Promise<{ status: number; body?: string }>
```

The user mounts this in whatever HTTP framework they use. See `webhook-ingress.md` for examples.

The handler:

1. Reads `X-Goog-Channel-Id`, `X-Goog-Channel-Token`, `X-Goog-Resource-State`, `X-Goog-Resource-Id`, `X-Goog-Message-Number` from headers (case-insensitive).
2. Returns **400** if any required header is missing.
3. Verifies `X-Goog-Channel-Token` against `HMAC(channelTokenSecret, channelId)` via constant-time compare. Mismatch → **401**.
4. Looks up the account by channel id via `Store.getAccountByChannelId`. Unknown channel → **200** (don't retry — likely a stale watch from a previous deployment).
5. Branches on resource state:
   - `sync` → **200**. Channel-creation handshake.
   - `not_exists` → call `channels.stop`, clear persisted channel state via `updateAccount({ channelId: null, resourceId: null, channelExpiresAt: null })`, **200**.
   - `exists` → feed the pipeline.
6. **Sync mode**: race the pipeline against `commitTimeoutMs` (default 8s). On commit success → 200; on commit nack → 503; on timeout → 503.
7. **Deferred mode**: enqueue the change to an in-memory queue, return **200** immediately, drain the queue in the background. On commit failure the event is *dropped* — Google won't redeliver since we acked. Trade-off: lower tail latency on the webhook, no redelivery safety net for commit failures.

Google retries 5xx for hours-to-days, similar to Pub/Sub semantics. 4xx are not retried.

## Notification payload

Google sends an empty-body POST. Everything is in headers. The ingress decodes them into:

```ts
type WebhookNotification = {
  channelId:         string                  // X-Goog-Channel-Id
  channelToken:      string                  // X-Goog-Channel-Token
  resourceId:        string                  // X-Goog-Resource-Id
  resourceState:     "sync" | "exists" | "not_exists" | string
  messageNumber:     string | null           // X-Goog-Message-Number; monotonic per channel
  resourceUri:       string | null           // X-Goog-Resource-Uri
  channelExpiration: string | null           // X-Goog-Channel-Expiration; informational
}
```

This shape is the `providerPayload` on the synthesized `CalendarChangeEvent`. The synthetic `eventId` for tracing is `${channelId}::${messageNumber}`.

## OAuth2 refresh writeback

When the underlying OAuth2 client refreshes an access token (every ~1h), `google-calendar-station` writes the new access token + expiry back to the Store via `updateAccount`. Fire-and-forget — if writeback fails, the next call refreshes again. The refresh token itself rarely changes.

## What's stored in `CalendarAccount.credentials`

```ts
{
  refreshToken:        string,
  accessToken?:        string,
  accessTokenExpiresAt?: string  // ISO datetime, since stored as JSON
}
```

Encrypt at the adapter layer if your store needs it — the core treats `credentials` as opaque.

## Recurrence

Google sends **two kinds** of events for recurring series:

- **Series row** — has `recurrence: ["RRULE:..."]`, `id` is the series id, no `recurringEventId`. The pipeline emits one of these per series-level change (creating the series, editing the rule, deleting the whole thing).
- **Instance overrides** — single occurrences edited/cancelled out of band. `recurringEventId` points to the series id. `originalStartTime` carries the slot the override replaces.

The package emits change events for **the rows Google sends**. It does NOT materialize every occurrence of an RRULE — that's the consumer's job (use `rrule` or `rrule-rust` if you need expansion). For most use cases — replicating event metadata into a downstream system — handling the series row plus instance overrides is exactly the right level.

## Single-calendar-per-account

Each `register()` call watches **one** calendar (`primary` or a specific id). To watch multiple calendars, register each separately — each gets its own `CalendarAccount` row, channel id, syncToken, and expiration.

## Pure helpers exported (for tests / one-off processing)

```ts
import {
  decodeWebhook, deriveChannelToken, verifyChannelToken,
  parseGoogleEvent, syntheticEventId, webhookUrl,
} from "google-calendar-station"

decodeWebhook(headers): { ok: true; value: WebhookNotification } | { ok: false; error: string }
deriveChannelToken(secret: string, channelId: string): string  // hex HMAC-SHA256
verifyChannelToken(expected: string, received: string): boolean // constant-time
parseGoogleEvent(raw: Schema$Event, accountId, calendarId): CalendarEvent
webhookUrl(baseUrl: string, path: string): string
```

Useful when writing a custom test fixture or doing one-off inspection of a saved Calendar payload.
