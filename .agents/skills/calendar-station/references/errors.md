# Errors and ack/nack mapping

Every error in the stack is a tagged union. The `_tag` is what drives runtime behavior — what gets logged, what HTTP status the webhook returns (which decides whether Google retries), whether account state mutates.

## The four error taxonomies

```ts
type StoreError =
  | { _tag: "Transient";       message: string; cause?: unknown }
  | { _tag: "Permanent";       message: string; cause?: unknown }
  | { _tag: "AccountNotFound"; accountId?: CalendarAccountId; channelId?: ChannelId; calendarId?: string }
  | { _tag: "DuplicateAccount"; provider: Provider; userId: UserId; calendarId: string }

type ResolverError =
  | { _tag: "MalformedNotification";   details: string }
  | { _tag: "AccountNotFound";          channelId?: ChannelId; calendarId?: string }
  | { _tag: "AccountPaused";            accountId: CalendarAccountId }
  | { _tag: "AccountRevoked";           accountId: CalendarAccountId }
  | { _tag: "ChannelTokenMismatch";     channelId: ChannelId }
  | { _tag: "CalendarGone";             accountId: CalendarAccountId }
  | { _tag: "CredentialsRevoked";       accountId: CalendarAccountId; reason: string }
  | { _tag: "ProviderTransient";        message: string; statusCode?: number; cause?: unknown }
  | { _tag: "ProviderPermanent";        message: string; statusCode?: number; cause?: unknown }

type IngressError =
  | { _tag: "DecodeError";    message: string }
  | { _tag: "UnknownChannel"; channelId: string }
  | { _tag: "TokenMismatch";  channelId: string }

type HandlerError =
  | { _tag: "Transient";  message: string; cause?: unknown }
  | { _tag: "Permanent";  message: string; cause?: unknown }
```

## Pipeline ack/nack mapping

When the resolver returns `err(...)` or `commitEvents` returns `err(...)`, the pipeline maps the tag to one of: **ack** (don't redeliver — webhook returns 200), **nack** (redeliver — webhook returns 503), or **state-change-then-ack**:

| Source | Tag | Webhook status | Side effect |
|---|---|---|---|
| Resolver | `MalformedNotification` | **200 (ack)** | `event.dropped` log |
| Resolver | `AccountNotFound` | **200 (ack)** | log; the channel is unknown — likely a stale watch from a previous deployment |
| Resolver | `AccountPaused` / `AccountRevoked` | **200 (ack)** | log; we shouldn't be processing |
| Resolver | `ChannelTokenMismatch` | **200 (ack)** | log; should not happen (ingress 401s first) — surfaces if deferred-mode swallowed the header check |
| Resolver | `CalendarGone` | **200 (ack)** | log `event.dropped` reason=`calendar_gone`. Ingress already stops the channel and clears state when it sees `not_exists`; this is a defensive duplicate path |
| Resolver | `CredentialsRevoked` | **200 (ack)** + state change | `updateAccount({ status: "revoked" })`, log `account.revoked` |
| Resolver | `ProviderTransient` | **503 (nack)** | Google retries with exponential backoff |
| Resolver | `ProviderPermanent` | **200 (ack)** | unrecoverable upstream — drop |
| Resolver | `SyncTokenGone` (special) | n/a — handled in resolver | log `event.sync_token_gone`, full re-paginate, no synthetic events for the gap |
| Store on commit | `Transient` / `AccountNotFound` | **503 (nack)** | redeliver |
| Store on commit | `Permanent` | **200 (ack)** + alarm | high-severity log; broken DB; redelivery would storm |
| Store on commit | `DuplicateAccount` | n/a here | only emitted by `createAccount` |

**Why `Store.Permanent` acks instead of nacks during commit:** a structurally broken DB will fail every redelivery; nacking creates a hot loop with Google retrying for hours-to-days. Acking with an alarm log forces operator intervention. This is a critical operational nuance — surface it to the user when they ask about commit-failure behavior.

## Webhook ingress decisions (before the pipeline runs)

The ingress has its own short-circuit before the pipeline ever sees the event:

| Condition | Webhook status | Why |
|---|---|---|
| Missing `X-Goog-Channel-Id` / `X-Goog-Resource-Id` / `X-Goog-Resource-State` | **400** | malformed; Google won't retry deterministic 4xx |
| `X-Goog-Channel-Token` doesn't match `HMAC(channelTokenSecret, channelId)` | **401** | someone is spoofing or `channelTokenSecret` rotated mid-flight |
| `getAccountByChannelId` returns `AccountNotFound` | **200** | unknown channel — could be from a prior deployment; ack so Google stops retrying |
| `getAccountByChannelId` returns `Transient` / `Permanent` | **503** | Store is sad; Google retries |
| `resourceState === "sync"` | **200** | channel-creation handshake; ack and forget |
| `resourceState === "not_exists"` | **200** | calendar deleted; ingress calls `channels.stop` and clears persisted channel state |
| `resourceState === "exists"`, sync mode, pipeline acks | **200** | normal happy path |
| `resourceState === "exists"`, sync mode, pipeline nacks | **503** | propagate retry signal |
| `resourceState === "exists"`, sync mode, commit timeout | **503** | exceeded `commitTimeoutMs` (default 8s); Google retries |
| `resourceState === "exists"`, deferred mode | **200** | always — pipeline runs in-background after ack |

## Handler error mapping

When the user's `handler` returns `err({...})`:

| Tag | Worker action |
|---|---|
| `Transient` | `markTriggerFailed(jobId, message, computeNextAttemptAt(...), now)` — retry per backoff |
| `Permanent` | `markTriggerFailed(jobId, message, null, now)` — terminal: `state='failed'`, dead-letter log |

When `attempts` reaches `WorkerConfig.maxAttempts` (default 10) and the latest result was `Transient`, the kernel converts it to terminal: `state='failed'`, log `trigger.dead_lettered`. The user does not need to track attempt count themselves.

**Uncaught throws inside the handler** are caught by the kernel and treated as `Transient` — but this is a backstop. Encourage users to return `err({ _tag: "Transient" | "Permanent", message })` explicitly so the intent is visible in logs.

## Patterns

### Classifying a database error in a Store adapter

```ts
const wrap = async <T>(fn: () => T | Result<T, StoreError>): Promise<Result<T, StoreError>> => {
  try {
    const r = fn()
    if (isResult(r)) return r
    return ok(r as T)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // Default to Permanent — surfaces the bug. Promote specific errors to Transient
    // (deadlocks, lock wait timeouts, connection resets) only with confidence.
    if (isRetryableDbError(cause)) return err({ _tag: "Transient", message, cause })
    return err({ _tag: "Permanent", message, cause })
  }
}
```

### Classifying a Google Calendar SDK error in a custom resolver

`google-calendar-station`'s built-in client already does this; only relevant if writing a fresh resolver:

```ts
if (e.message?.includes("invalid_grant")) return err({ _tag: "CredentialsRevoked", accountId, reason: e.message })
if (status === 410)                       return err({ _tag: "SyncTokenGone" })          // resolver internal
if (status >= 500 || status === 429)      return err({ _tag: "ProviderTransient", message, statusCode: status, cause: e })
if (status >= 400)                        return err({ _tag: "ProviderPermanent", message, statusCode: status, cause: e })
return err({ _tag: "ProviderTransient", message: e.message ?? "unknown", cause: e })
```

`SyncTokenGone` is internal to the resolver — it doesn't reach the pipeline. The resolver catches the 410, drains `events.list` without a syncToken to realign, and returns the new `nextSyncToken`. Synthetic events are NOT emitted for the gap.

### Reading errors out of the handler context

`handler` receives `(event, ctx)` where `ctx = { jobId, accountId, attempt }`. On retry, `ctx.attempt` increments — useful for logging "this is attempt 3 of max 10", but don't use it for the backoff math (the kernel handles that).

## What does NOT exist

- No `onAccountRevoked` / `onChannelExpired` callbacks (out of scope, see `out-of-scope.md`). React to log events instead.
- No retry helpers for transient handler errors — return `err({ _tag: "Transient" })` and the kernel retries.
- No partial-commit recovery — `commitEvents` is atomic; either all three writes land or none do.
- No "synthetic events for the gap" when the syncToken expires — the resolver re-aligns silently. If your handler needs gap detection, diff the events table before vs after `event.sync_token_gone`.
