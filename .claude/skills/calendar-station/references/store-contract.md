# Store contract

The `StoreAdapter` is the single integration seam between `calendar-station` and the user's persistence layer. **10 methods**, all returning `Promise<Result<T, StoreError>>`. Adapter authors implement once for their backend (Postgres, SQLite, Redis, HTTP API, …).

## Method list

```ts
interface StoreAdapter {
  // ---- Account lifecycle ----
  createAccount(input: CreateAccountInput): Promise<Result<CalendarAccount, StoreError>>
  getAccount(accountId: CalendarAccountId): Promise<Result<CalendarAccount, StoreError>>
  getAccountByChannelId(channelId: ChannelId): Promise<Result<CalendarAccount, StoreError>>
  getAccountByCalendar(provider: Provider, userId: UserId, calendarId: string): Promise<Result<CalendarAccount, StoreError>>
  updateAccount(accountId: CalendarAccountId, patch: AccountPatch): Promise<Result<CalendarAccount, StoreError>>
  listAccountsExpiringChannel(provider: Provider, before: Date): Promise<Result<ReadonlyArray<CalendarAccount>, StoreError>>

  // ---- Atomic commit ----
  commitEvents(input: CommitEventsInput): Promise<Result<{ committedEventIds: ReadonlyArray<CalendarEventId> }, StoreError>>

  // ---- Trigger jobs ----
  claimTriggerJobs(input: ClaimTriggerInput): Promise<Result<ReadonlyArray<ClaimedJob>, StoreError>>
  markTriggerDone(jobId: JobId, now: Date): Promise<Result<void, StoreError>>
  markTriggerFailed(jobId: JobId, error: string, nextAttemptAt: Date | null, now: Date): Promise<Result<void, StoreError>>
}
```

## Two account lookups (vs mail-station's one)

Calendar needs both:

- `getAccountByChannelId(channelId)` — used by the **webhook ingress** to map an inbound `X-Goog-Channel-Id` to an account in O(1). Index this column with a unique constraint.
- `getAccountByCalendar(provider, userId, calendarId)` — used by **`register()`** for the pre-flight duplicate check.

`channelId` rotates on every renewal. The lookup must follow the *current* `channelId`; old channel ids should not point anywhere after the swap.

## Invariants the kernel relies on

These are not optional. The conformance battery (`calendar-station-conformance`) tests each one — make the adapter pass it.

### 1. Account uniqueness on `(provider, userId, calendarId)`

`createAccount` must return `err({ _tag: "DuplicateAccount", provider, userId, calendarId })` if a row already exists for the same triple. A single user can register many calendars, and a given calendarId (e.g. `"primary"`) can be registered once per user.

### 2. Channel id uniqueness

`channelId` is a UUID allocated by the watch manager. The adapter should enforce uniqueness via a unique index on the column. On rotation (renewal), the old id is replaced; if you maintain a denormalized lookup table, swap atomically with the row update.

### 3. `commitEvents` is atomic across three writes

In a single transaction:
1. **Upsert** each event in `input.events` keyed by `(accountId, eventId)`. Use `INSERT … ON CONFLICT (account_id, event_id) DO UPDATE SET payload = excluded.payload`. Calendar events change over time (status flips, attendee response updates, time edits) — handlers want to see the latest state.
2. Update `accounts.syncToken = input.newSyncToken` and `updatedAt = input.now`.
3. For **every** event in the input batch (both newly inserted AND updated rows), enqueue a row in `trigger_jobs` with `state='pending'`, `attempts=0`, `nextAttemptAt=input.now`.

Return *every* `CalendarEventId` from the input batch in `committedEventIds` (not just newly-inserted ones, as in mail-station). The pipeline relies on this to know that handlers will fire.

If any step fails, roll back all three; nothing is partially committed.

### 4. Idempotency on `(accountId, eventId)`

Calling `commitEvents` twice with the same payload must produce the same final state of the events table. The natural key is `(accountId, eventId)`. Enforce it with a primary key or unique index. The pipeline relies on this to handle Google's webhook redelivery (Google retries 5xx for hours-to-days).

Note that "same final state of the events table" is different from "no-op": a duplicate commit still enqueues fresh trigger jobs, because the handler may not have been invoked the first time. Fresh jobs on retry are intentional — the worker dedupes via `state != "pending"`.

### 5. Lease-based claim semantics in `claimTriggerJobs`

A job is claimable when:
```sql
state = 'pending'
AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
AND (lease_expires_at IS NULL OR lease_expires_at <= :now)
```

When claiming, set `claimed_at=:now`, `claimed_by=:workerId`, `lease_expires_at=:now + :leaseDurationMs`. **Serialize concurrent claims** (Postgres: `SELECT … FOR UPDATE SKIP LOCKED`; SQLite: `BEGIN IMMEDIATE`). At-most-one in-flight per job across processes.

Return up to `input.limit` rows. The kernel calls in batches of `claimBatchSize` (default 16) and runs them at `triggerConcurrency` (default 8).

`ClaimedJob` is `{ job: TriggerJob, event: CalendarEvent }` — join the event payload from the events table inline so the worker has everything it needs.

### 6. State transitions are explicit

`markTriggerDone(jobId, now)`:
```sql
UPDATE trigger_jobs
SET state='succeeded', completed_at=:now, lease_expires_at=NULL, next_attempt_at=NULL
WHERE job_id=:jobId
```

`markTriggerFailed(jobId, error, nextAttemptAt, now)`:
- If `nextAttemptAt === null` → terminal (dead-letter): `state='failed'`, `completed_at=:now`, increment `attempts`, set `last_error=:error`, clear lease + nextAttempt.
- If `nextAttemptAt !== null` → retry: keep `state='pending'`, increment `attempts`, set `last_error=:error`, set `next_attempt_at=:nextAttemptAt`, clear lease (`claimed_at=NULL, claimed_by=NULL, lease_expires_at=NULL`) so it's re-claimable.

The kernel computes `nextAttemptAt` itself via the configured backoff. Don't try to compute it in the adapter.

### 7. `listAccountsExpiringChannel` filter

```sql
SELECT * FROM accounts
WHERE provider = :provider
  AND channel_expires_at IS NOT NULL
  AND channel_expires_at < :before
```

The renewal cron passes `before = now + renewalWindowMs` (default 24h ahead). Accounts without an active channel (`channel_expires_at IS NULL`) — e.g. just-registered or just-revoked — should not appear.

### 8. Errors are tagged, not exceptions

```ts
type StoreError =
  | { _tag: "Transient";       message: string; cause?: unknown }   // retry-able (network blip, lock)
  | { _tag: "Permanent";       message: string; cause?: unknown }   // structural (schema mismatch, etc.)
  | { _tag: "AccountNotFound"; accountId?: CalendarAccountId; channelId?: ChannelId; calendarId?: string }
  | { _tag: "DuplicateAccount"; provider: Provider; userId: UserId; calendarId: string }
```

Don't throw. Catch DB errors at the adapter boundary and classify into one of these tags. Uncaught throws are a backstop — the kernel catches them and treats as `Transient`.

### 9. Don't normalize the event payload

- Attendee `email` may be null (resource calendars, contact-less invitees). Don't drop them.
- `recurrence` is a list of raw RFC5545 strings (`"RRULE:FREQ=WEEKLY;BYDAY=MO"`, `"EXDATE;TZID=America/Los_Angeles:20260601T100000"`). Don't try to expand them.
- `start.dateTime` and `start.date` are mutually exclusive — exactly one is non-null.
- `etag` and `sequence` are kept verbatim from Google. Don't drop them; they're useful for deeper diffing downstream.

## What's deliberately NOT in the contract

- No `deleteAccount` / `deleteEvent` (out of scope, see `out-of-scope.md`).
- No batch `commitEvents` across multiple accounts (single-account scope per call).
- No retention/pruning policies — the adapter author decides whether to keep `succeeded` and `failed` jobs around for audit, or sweep them on a schedule.
- No encryption-at-rest helpers — `CalendarAccount.credentials` is `Record<string, unknown>`, opaque to the core; encrypt at the adapter layer if your store needs it.

## Schema sketch (Postgres)

```sql
CREATE TABLE accounts (
  account_id          UUID PRIMARY KEY,
  user_id             TEXT NOT NULL,
  provider            TEXT NOT NULL,
  calendar_id         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('active','paused','revoked')),
  credentials         JSONB NOT NULL,
  sync_token          TEXT,
  channel_id          UUID,
  resource_id         TEXT,
  channel_expires_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  UNIQUE (provider, user_id, calendar_id),
  UNIQUE (channel_id)
);

CREATE TABLE events (
  account_id  UUID NOT NULL REFERENCES accounts(account_id),
  event_id    TEXT NOT NULL,
  payload     JSONB NOT NULL,
  PRIMARY KEY (account_id, event_id)
);

CREATE TABLE trigger_jobs (
  job_id            UUID PRIMARY KEY,
  account_id        UUID NOT NULL,
  event_id          TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed')),
  attempts          INT  NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMPTZ,
  claimed_at        TIMESTAMPTZ,
  claimed_by        TEXT,
  lease_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  FOREIGN KEY (account_id, event_id) REFERENCES events(account_id, event_id)
);
CREATE INDEX idx_jobs_pending ON trigger_jobs (state, next_attempt_at, lease_expires_at);
```

See `templates/postgres-store.ts` for a working implementation.

## Verifying with the conformance battery

```ts
// my-store.test.ts
import { describe } from "vitest"
import { runStoreConformance } from "calendar-station-conformance"
import { createMyStore } from "./my-store.js"

describe("my-store", () => {
  runStoreConformance({
    name: "my-store",
    makeStore: async () => ({
      store: createMyStore({ /* fresh per-test schema or :memory: */ }),
      teardown: async () => { /* drop schema, close conn */ },
    }),
  })
})
```

If this passes, every invariant the kernel relies on is satisfied. The reference implementation is `createReferenceStore()` from the same package — useful to compare behavior side-by-side when debugging.
