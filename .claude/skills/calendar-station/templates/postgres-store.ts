// Skeleton Postgres StoreAdapter for calendar-station.
// Brings in `pg` for the connection pool — adapt to your existing driver if you
// already have one. Critical invariants are commented inline; verify by running
// the conformance battery (`calendar-station-conformance`).
//
// Schema (run before using):
//   CREATE TABLE accounts (
//     account_id          UUID PRIMARY KEY,
//     user_id             TEXT NOT NULL,
//     provider            TEXT NOT NULL,
//     calendar_id         TEXT NOT NULL,
//     status              TEXT NOT NULL CHECK (status IN ('active','paused','revoked')),
//     credentials         JSONB NOT NULL,
//     sync_token          TEXT,
//     channel_id          UUID,
//     resource_id         TEXT,
//     channel_expires_at  TIMESTAMPTZ,
//     created_at          TIMESTAMPTZ NOT NULL,
//     updated_at          TIMESTAMPTZ NOT NULL,
//     UNIQUE (provider, user_id, calendar_id),
//     UNIQUE (channel_id)
//   );
//
//   CREATE TABLE events (
//     account_id  UUID NOT NULL REFERENCES accounts(account_id),
//     event_id    TEXT NOT NULL,
//     payload     JSONB NOT NULL,
//     PRIMARY KEY (account_id, event_id)
//   );
//
//   CREATE TABLE trigger_jobs (
//     job_id            UUID PRIMARY KEY,
//     account_id        UUID NOT NULL,
//     event_id          TEXT NOT NULL,
//     state             TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed')),
//     attempts          INT  NOT NULL DEFAULT 0,
//     last_error        TEXT,
//     next_attempt_at   TIMESTAMPTZ,
//     claimed_at        TIMESTAMPTZ,
//     claimed_by        TEXT,
//     lease_expires_at  TIMESTAMPTZ,
//     created_at        TIMESTAMPTZ NOT NULL,
//     completed_at      TIMESTAMPTZ,
//     FOREIGN KEY (account_id, event_id) REFERENCES events(account_id, event_id)
//   );
//   CREATE INDEX idx_jobs_pending ON trigger_jobs (state, next_attempt_at, lease_expires_at);

import { Pool, type PoolClient } from "pg"
import {
  CalendarAccountId as makeAccountId,
  CalendarEventId as makeEventId,
  ChannelId as makeChannelId,
  JobId as makeJobId,
  SyncToken as makeSyncToken,
  UserId as makeUserId,
  err,
  ok,
} from "calendar-station"
import type {
  AccountPatch,
  CalendarAccount,
  CalendarAccountId,
  CalendarEvent,
  CalendarEventId,
  ChannelId,
  ClaimTriggerInput,
  ClaimedJob,
  CommitEventsInput,
  CreateAccountInput,
  JobId,
  Provider,
  Result,
  StoreAdapter,
  StoreError,
  TriggerJob,
  UserIdType,
} from "calendar-station"

export const createPostgresStore = (pool: Pool): StoreAdapter => {
  // -- helpers -----------------------------------------------------------------

  const wrap = async <T>(fn: () => Promise<Result<T, StoreError>>): Promise<Result<T, StoreError>> => {
    try {
      return await fn()
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // Promote known-retryable errors to Transient (deadlocks, lock timeouts, conn resets).
      // Default to Permanent so structural bugs surface instead of looping silently.
      if (isRetryablePgError(cause)) return err({ _tag: "Transient", message, cause })
      return err({ _tag: "Permanent", message, cause })
    }
  }

  const rowToAccount = (r: any): CalendarAccount => ({
    accountId:        makeAccountId(r.account_id),
    userId:           makeUserId(r.user_id),
    provider:         r.provider as Provider,
    calendarId:       r.calendar_id,
    status:           r.status,
    credentials:      r.credentials,
    syncToken:        r.sync_token ? makeSyncToken(r.sync_token) : null,
    channelId:        r.channel_id ? makeChannelId(r.channel_id) : null,
    resourceId:       r.resource_id,
    channelExpiresAt: r.channel_expires_at,
    createdAt:        r.created_at,
    updatedAt:        r.updated_at,
  })

  const rowToEvent = (e: any): CalendarEvent => ({
    ...e,
    eventId:           makeEventId(e.eventId),
    accountId:         makeAccountId(e.accountId),
    recurringEventId:  e.recurringEventId ? makeEventId(e.recurringEventId) : null,
    start:             { ...e.start, dateTime: e.start?.dateTime ? new Date(e.start.dateTime) : null },
    end:               { ...e.end,   dateTime: e.end?.dateTime   ? new Date(e.end.dateTime)   : null },
    originalStartTime: e.originalStartTime
      ? { ...e.originalStartTime, dateTime: e.originalStartTime.dateTime ? new Date(e.originalStartTime.dateTime) : null }
      : null,
    createdAt:         e.createdAt ? new Date(e.createdAt) : null,
    updatedAt:         e.updatedAt ? new Date(e.updatedAt) : null,
  })

  const rowToJob = (r: any): TriggerJob => ({
    jobId:           makeJobId(r.job_id),
    accountId:       makeAccountId(r.account_id),
    eventId:         makeEventId(r.event_id),
    state:           r.state,
    attempts:        r.attempts,
    lastError:       r.last_error,
    nextAttemptAt:   r.next_attempt_at,
    claimedAt:       r.claimed_at,
    claimedBy:       r.claimed_by,
    leaseExpiresAt:  r.lease_expires_at,
    createdAt:       r.created_at,
    completedAt:     r.completed_at,
  })

  const tx = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect()
    try {
      await c.query("BEGIN")
      const out = await fn(c)
      await c.query("COMMIT")
      return out
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  // -- adapter -----------------------------------------------------------------

  return {
    createAccount: (input: CreateAccountInput) =>
      wrap(async () => {
        const id = makeAccountId(crypto.randomUUID())
        try {
          await pool.query(
            `INSERT INTO accounts (account_id, user_id, provider, calendar_id, status, credentials,
                                   sync_token, channel_id, resource_id, channel_expires_at,
                                   created_at, updated_at)
             VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$10)`,
            [
              id, input.userId, input.provider, input.calendarId,
              input.credentials,
              input.syncToken, input.channelId, input.resourceId,
              input.channelExpiresAt,
              input.now,
            ],
          )
        } catch (e: any) {
          if (e?.code === "23505") {
            return err<StoreError>({
              _tag: "DuplicateAccount",
              provider: input.provider,
              userId:   input.userId as UserIdType,
              calendarId: input.calendarId,
            })
          }
          throw e
        }
        const r = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [id])
        return ok(rowToAccount(r.rows[0]))
      }),

    getAccount: (accountId: CalendarAccountId) =>
      wrap(async () => {
        const r = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [accountId])
        if (r.rowCount === 0) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        return ok(rowToAccount(r.rows[0]))
      }),

    getAccountByChannelId: (channelId: ChannelId) =>
      wrap(async () => {
        const r = await pool.query(`SELECT * FROM accounts WHERE channel_id=$1`, [channelId])
        if (r.rowCount === 0) return err<StoreError>({ _tag: "AccountNotFound", channelId })
        return ok(rowToAccount(r.rows[0]))
      }),

    getAccountByCalendar: (provider, userId, calendarId) =>
      wrap(async () => {
        const r = await pool.query(
          `SELECT * FROM accounts WHERE provider=$1 AND user_id=$2 AND calendar_id=$3`,
          [provider, userId, calendarId],
        )
        if (r.rowCount === 0) return err<StoreError>({ _tag: "AccountNotFound", calendarId })
        return ok(rowToAccount(r.rows[0]))
      }),

    updateAccount: (accountId, patch: AccountPatch) =>
      wrap(async () => {
        // Read-modify-write so partial patches preserve unchanged columns.
        const cur = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [accountId])
        if (cur.rowCount === 0) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        const a = rowToAccount(cur.rows[0])
        await pool.query(
          `UPDATE accounts SET
             status = $2,
             credentials = $3,
             sync_token = $4,
             channel_id = $5,
             resource_id = $6,
             channel_expires_at = $7,
             updated_at = $8
           WHERE account_id=$1`,
          [
            accountId,
            patch.status ?? a.status,
            patch.credentials ?? a.credentials,
            patch.syncToken         === undefined ? a.syncToken         : patch.syncToken,
            patch.channelId         === undefined ? a.channelId         : patch.channelId,
            patch.resourceId        === undefined ? a.resourceId        : patch.resourceId,
            patch.channelExpiresAt  === undefined ? a.channelExpiresAt  : patch.channelExpiresAt,
            patch.now,
          ],
        )
        const r = await pool.query(`SELECT * FROM accounts WHERE account_id=$1`, [accountId])
        return ok(rowToAccount(r.rows[0]))
      }),

    listAccountsExpiringChannel: (provider, before) =>
      wrap(async () => {
        const r = await pool.query(
          `SELECT * FROM accounts
           WHERE provider=$1
             AND channel_expires_at IS NOT NULL
             AND channel_expires_at < $2`,
          [provider, before],
        )
        return ok(r.rows.map(rowToAccount))
      }),

    // ---- THE atomic-commit method ----
    //
    // Upserts events (idempotent on (accountId, eventId)),
    // advances syncToken, enqueues a fresh trigger job for EVERY event in the
    // batch (newly inserted AND updated). All in one tx.
    //
    // Calendar events change over time (status flips, attendee responses, time
    // edits) — handlers want to see the latest state. That's why we re-enqueue
    // on update, unlike mailbox-station's insert-only commit.
    commitEvents: (input: CommitEventsInput) =>
      wrap(() =>
        tx(async (c) => {
          const committed: CalendarEventId[] = []
          for (const e of input.events) {
            await c.query(
              `INSERT INTO events (account_id, event_id, payload)
               VALUES ($1,$2,$3)
               ON CONFLICT (account_id, event_id) DO UPDATE SET payload = EXCLUDED.payload`,
              [input.accountId, e.eventId, e],
            )
            committed.push(e.eventId)
          }
          await c.query(
            `UPDATE accounts SET sync_token=$2, updated_at=$3 WHERE account_id=$1`,
            [input.accountId, input.newSyncToken, input.now],
          )
          for (const eventId of committed) {
            await c.query(
              `INSERT INTO trigger_jobs (job_id, account_id, event_id, state, attempts,
                                         next_attempt_at, created_at)
               VALUES ($1,$2,$3,'pending',0,$4,$5)`,
              [crypto.randomUUID(), input.accountId, eventId, input.now, input.now],
            )
          }
          return ok({ committedEventIds: committed })
        }),
      ),

    // ---- Lease-based claim ----
    //
    // SELECT FOR UPDATE SKIP LOCKED gives at-most-one-in-flight per row across
    // every worker process. Don't relax this — at-least-once handler invocation
    // depends on it.
    claimTriggerJobs: (input: ClaimTriggerInput) =>
      wrap(() =>
        tx(async (c) => {
          const candidates = await c.query(
            `SELECT * FROM trigger_jobs
             WHERE state='pending'
               AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
               AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
             ORDER BY next_attempt_at NULLS FIRST
             FOR UPDATE SKIP LOCKED
             LIMIT $2`,
            [input.now, input.limit],
          )
          const claimed: ClaimedJob[] = []
          for (const row of candidates.rows) {
            const lease = new Date(input.now.getTime() + input.leaseDurationMs)
            await c.query(
              `UPDATE trigger_jobs SET claimed_at=$2, claimed_by=$3, lease_expires_at=$4
               WHERE job_id=$1`,
              [row.job_id, input.now, input.workerId, lease],
            )
            const updated = await c.query(`SELECT * FROM trigger_jobs WHERE job_id=$1`, [row.job_id])
            const ev = await c.query(
              `SELECT payload FROM events WHERE account_id=$1 AND event_id=$2`,
              [row.account_id, row.event_id],
            )
            if (ev.rowCount === 0) continue
            claimed.push({
              job:   rowToJob(updated.rows[0]),
              event: rowToEvent(ev.rows[0].payload),
            })
          }
          return ok(claimed)
        }),
      ),

    markTriggerDone: (jobId: JobId, now: Date) =>
      wrap(async () => {
        await pool.query(
          `UPDATE trigger_jobs
           SET state='succeeded', completed_at=$2, lease_expires_at=NULL, next_attempt_at=NULL
           WHERE job_id=$1`,
          [jobId, now],
        )
        return ok(undefined)
      }),

    markTriggerFailed: (jobId: JobId, errorStr: string, nextAttemptAt: Date | null, now: Date) =>
      wrap(async () => {
        if (nextAttemptAt === null) {
          // terminal: dead-letter
          await pool.query(
            `UPDATE trigger_jobs
             SET state='failed', attempts=attempts+1, last_error=$2,
                 completed_at=$3, lease_expires_at=NULL, next_attempt_at=NULL
             WHERE job_id=$1`,
            [jobId, errorStr, now],
          )
        } else {
          // retry: keep pending, clear lease so it's re-claimable
          await pool.query(
            `UPDATE trigger_jobs
             SET attempts=attempts+1, last_error=$2, next_attempt_at=$3,
                 claimed_at=NULL, claimed_by=NULL, lease_expires_at=NULL
             WHERE job_id=$1`,
            [jobId, errorStr, nextAttemptAt],
          )
        }
        return ok(undefined)
      }),
  }
}

// Postgres SQLSTATE codes worth retrying.
// 40001 = serialization_failure, 40P01 = deadlock_detected, 55P03 = lock_not_available,
// 53300 = too_many_connections, 08006 = connection_failure
const RETRYABLE_PG = new Set(["40001", "40P01", "55P03", "53300", "08006"])
const isRetryablePgError = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code
  return typeof code === "string" && RETRYABLE_PG.has(code)
}
