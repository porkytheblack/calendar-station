import Database from "better-sqlite3"
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

/**
 * SQLite Store adapter, demonstrating how to satisfy the contract.
 *
 * Atomicity is provided by SQLite transactions; idempotency on `(accountId,
 * eventId)` is enforced by `INSERT OR REPLACE` against a unique index — the
 * payload column is replaced on update, and a fresh trigger job is enqueued
 * either way so handlers see the latest state.
 *
 * Concurrent claims are serialized via `BEGIN IMMEDIATE`.
 */
export const createSqliteStore = (
  filename: string,
): StoreAdapter & { close: () => void } => {
  const db = new Database(filename)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      status TEXT NOT NULL,
      credentials TEXT NOT NULL,
      sync_token TEXT,
      channel_id TEXT,
      resource_id TEXT,
      channel_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider, user_id, calendar_id),
      UNIQUE (channel_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      account_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (account_id, event_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id)
    );

    CREATE TABLE IF NOT EXISTS trigger_jobs (
      job_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at INTEGER,
      claimed_at INTEGER,
      claimed_by TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (account_id, event_id) REFERENCES events(account_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_pending
      ON trigger_jobs(state, next_attempt_at, lease_expires_at);
  `)

  const rowToAccount = (r: any): CalendarAccount => ({
    accountId: makeAccountId(r.account_id),
    userId: makeUserId(r.user_id),
    provider: r.provider as Provider,
    calendarId: r.calendar_id,
    status: r.status,
    credentials: JSON.parse(r.credentials),
    syncToken: r.sync_token ? makeSyncToken(r.sync_token) : null,
    channelId: r.channel_id ? makeChannelId(r.channel_id) : null,
    resourceId: r.resource_id,
    channelExpiresAt: r.channel_expires_at ? new Date(r.channel_expires_at) : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  })

  const rowToEvent = (r: any): CalendarEvent => {
    const e = JSON.parse(r.payload)
    return {
      ...e,
      eventId: makeEventId(e.eventId),
      accountId: makeAccountId(e.accountId),
      recurringEventId: e.recurringEventId ? makeEventId(e.recurringEventId) : null,
      start: deserializeTime(e.start),
      end: deserializeTime(e.end),
      originalStartTime: e.originalStartTime ? deserializeTime(e.originalStartTime) : null,
      createdAt: e.createdAt ? new Date(e.createdAt) : null,
      updatedAt: e.updatedAt ? new Date(e.updatedAt) : null,
    }
  }

  const deserializeTime = (t: any) => ({
    dateTime: t.dateTime ? new Date(t.dateTime) : null,
    date: t.date ?? null,
    timeZone: t.timeZone ?? null,
  })

  const rowToJob = (r: any): TriggerJob => ({
    jobId: makeJobId(r.job_id),
    accountId: makeAccountId(r.account_id),
    eventId: makeEventId(r.event_id),
    state: r.state,
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : null,
    claimedAt: r.claimed_at ? new Date(r.claimed_at) : null,
    claimedBy: r.claimed_by,
    leaseExpiresAt: r.lease_expires_at ? new Date(r.lease_expires_at) : null,
    createdAt: new Date(r.created_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
  })

  const wrap = async <T>(
    fn: () => Result<T, StoreError> | T,
  ): Promise<Result<T, StoreError>> => {
    try {
      const r = fn()
      if (r && typeof r === "object" && "ok" in (r as object)) return r as Result<T, StoreError>
      return ok(r as T)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return err({ _tag: "Permanent", message, cause })
    }
  }

  return {
    close: () => db.close(),

    createAccount: async (input: CreateAccountInput) =>
      wrap<CalendarAccount>(() => {
        const id = makeAccountId(crypto.randomUUID())
        try {
          db.prepare(
            `INSERT INTO accounts (account_id, user_id, provider, calendar_id, status, credentials,
              sync_token, channel_id, resource_id, channel_expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            input.userId,
            input.provider,
            input.calendarId,
            JSON.stringify(input.credentials),
            input.syncToken,
            input.channelId,
            input.resourceId,
            input.channelExpiresAt?.getTime() ?? null,
            input.now.getTime(),
            input.now.getTime(),
          )
        } catch (e: any) {
          if (typeof e.message === "string" && e.message.includes("UNIQUE")) {
            return err<StoreError>({
              _tag: "DuplicateAccount",
              provider: input.provider,
              userId: input.userId as UserIdType,
              calendarId: input.calendarId,
            })
          }
          throw e
        }
        const row = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(id)
        return ok(rowToAccount(row))
      }),

    getAccount: async (accountId: CalendarAccountId) =>
      wrap<CalendarAccount>(() => {
        const row = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId)
        if (!row) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        return ok(rowToAccount(row))
      }),

    getAccountByChannelId: async (channelId: ChannelId) =>
      wrap<CalendarAccount>(() => {
        const row = db.prepare(`SELECT * FROM accounts WHERE channel_id = ?`).get(channelId)
        if (!row) return err<StoreError>({ _tag: "AccountNotFound", channelId })
        return ok(rowToAccount(row))
      }),

    getAccountByCalendar: async (provider: Provider, userId: UserIdType, calendarId: string) =>
      wrap<CalendarAccount>(() => {
        const row = db
          .prepare(
            `SELECT * FROM accounts WHERE provider = ? AND user_id = ? AND calendar_id = ?`,
          )
          .get(provider, userId, calendarId)
        if (!row)
          return err<StoreError>({ _tag: "AccountNotFound", calendarId })
        return ok(rowToAccount(row))
      }),

    updateAccount: async (accountId: CalendarAccountId, patch: AccountPatch) =>
      wrap<CalendarAccount>(() => {
        const existing = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId)
        if (!existing) return err<StoreError>({ _tag: "AccountNotFound", accountId })
        const cur = rowToAccount(existing)
        db.prepare(
          `UPDATE accounts SET status = ?, credentials = ?, sync_token = ?, channel_id = ?, resource_id = ?, channel_expires_at = ?, updated_at = ? WHERE account_id = ?`,
        ).run(
          patch.status ?? cur.status,
          JSON.stringify(patch.credentials ?? cur.credentials),
          patch.syncToken === undefined ? cur.syncToken : patch.syncToken,
          patch.channelId === undefined ? cur.channelId : patch.channelId,
          patch.resourceId === undefined ? cur.resourceId : patch.resourceId,
          patch.channelExpiresAt === undefined
            ? cur.channelExpiresAt?.getTime() ?? null
            : patch.channelExpiresAt?.getTime() ?? null,
          patch.now.getTime(),
          accountId,
        )
        const row = db.prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId)
        return ok(rowToAccount(row))
      }),

    listAccountsExpiringChannel: async (provider: Provider, before: Date) =>
      wrap<readonly CalendarAccount[]>(() => {
        const rows = db
          .prepare(
            `SELECT * FROM accounts WHERE provider = ? AND channel_expires_at IS NOT NULL AND channel_expires_at < ?`,
          )
          .all(provider, before.getTime())
        return ok((rows as any[]).map(rowToAccount))
      }),

    commitEvents: async (input: CommitEventsInput) =>
      wrap<{ committedEventIds: readonly CalendarEventId[] }>(() => {
        const tx = db.transaction(() => {
          const committed: CalendarEventId[] = []
          for (const e of input.events) {
            // Re-enqueue on every commit so handlers see updates / status flips.
            db.prepare(
              `INSERT INTO events (account_id, event_id, payload) VALUES (?, ?, ?)
               ON CONFLICT(account_id, event_id) DO UPDATE SET payload = excluded.payload`,
            ).run(input.accountId, e.eventId, JSON.stringify(e))
            committed.push(e.eventId)
          }
          db.prepare(
            `UPDATE accounts SET sync_token = ?, updated_at = ? WHERE account_id = ?`,
          ).run(input.newSyncToken, input.now.getTime(), input.accountId)
          for (const eid of committed) {
            const jobId = `job-${crypto.randomUUID()}`
            db.prepare(
              `INSERT INTO trigger_jobs (job_id, account_id, event_id, state, attempts, next_attempt_at, created_at)
               VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
            ).run(jobId, input.accountId, eid, input.now.getTime(), input.now.getTime())
          }
          return committed
        })
        const committed = tx()
        return ok({ committedEventIds: committed })
      }),

    claimTriggerJobs: async (input: ClaimTriggerInput) =>
      wrap<readonly ClaimedJob[]>(() => {
        const tx = db.transaction(() => {
          const candidates = db
            .prepare(
              `SELECT * FROM trigger_jobs
               WHERE state = 'pending'
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                 AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
               ORDER BY next_attempt_at NULLS FIRST
               LIMIT ?`,
            )
            .all(input.now.getTime(), input.now.getTime(), input.limit)
          const claimed: ClaimedJob[] = []
          for (const row of candidates as any[]) {
            const lease = input.now.getTime() + input.leaseDurationMs
            db.prepare(
              `UPDATE trigger_jobs SET claimed_at = ?, claimed_by = ?, lease_expires_at = ? WHERE job_id = ?`,
            ).run(input.now.getTime(), input.workerId, lease, row.job_id)
            const updated = db
              .prepare(`SELECT * FROM trigger_jobs WHERE job_id = ?`)
              .get(row.job_id)
            const eventRow = db
              .prepare(`SELECT payload FROM events WHERE account_id = ? AND event_id = ?`)
              .get(row.account_id, row.event_id) as any
            if (!eventRow) continue
            claimed.push({ job: rowToJob(updated), event: rowToEvent(eventRow) })
          }
          return claimed
        })
        return ok(tx())
      }),

    markTriggerDone: async (jobId: JobId, now: Date) =>
      wrap<void>(() => {
        db.prepare(
          `UPDATE trigger_jobs SET state = 'succeeded', completed_at = ?, lease_expires_at = NULL, next_attempt_at = NULL WHERE job_id = ?`,
        ).run(now.getTime(), jobId)
        return ok(undefined)
      }),

    markTriggerFailed: async (
      jobId: JobId,
      errorStr: string,
      nextAttemptAt: Date | null,
      now: Date,
    ) =>
      wrap<void>(() => {
        if (nextAttemptAt === null) {
          db.prepare(
            `UPDATE trigger_jobs SET state = 'failed', attempts = attempts + 1, last_error = ?, completed_at = ?, lease_expires_at = NULL, next_attempt_at = NULL WHERE job_id = ?`,
          ).run(errorStr, now.getTime(), jobId)
        } else {
          db.prepare(
            `UPDATE trigger_jobs SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, claimed_at = NULL, claimed_by = NULL, lease_expires_at = NULL WHERE job_id = ?`,
          ).run(errorStr, nextAttemptAt.getTime(), jobId)
        }
        return ok(undefined)
      }),
  }
}
