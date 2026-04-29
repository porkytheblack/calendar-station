import {
  CalendarAccountId as makeAccountId,
  JobId as makeJobId,
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
  UserId,
} from "calendar-station"

/**
 * Reference in-memory implementation of StoreAdapter. Used to:
 *   1. meta-test the conformance suite itself
 *   2. drive integration tests in core and provider packages
 *   3. serve as a worked reference for adapter authors
 *
 * Single Node event-loop: synchronous mutations between awaits are atomic,
 * which gives commitEvents and claimTriggerJobs their mutex semantics for
 * free. Real adapters need explicit locking.
 */
export type ReferenceStore = StoreAdapter & {
  _accounts(): ReadonlyArray<CalendarAccount>
  _events(): ReadonlyArray<CalendarEvent>
  _jobs(): ReadonlyArray<TriggerJob>
}

type AccountRow = CalendarAccount
type EventRow = CalendarEvent & { readonly _key: string }
type JobRow = TriggerJob

const calendarKey = (provider: Provider, userId: UserId, calendarId: string) =>
  `${provider}::${userId}::${calendarId}`
const eventKey = (accountId: CalendarAccountId, eventId: CalendarEventId) =>
  `${accountId}::${eventId}`

export const createReferenceStore = (): ReferenceStore => {
  const accountsById = new Map<CalendarAccountId, AccountRow>()
  const accountsByCalendar = new Map<string, CalendarAccountId>()
  const accountsByChannel = new Map<ChannelId, CalendarAccountId>()
  const eventsByKey = new Map<string, EventRow>()
  const jobsById = new Map<JobId, JobRow>()

  let jobCounter = 0
  const newJobId = (): JobId => makeJobId(`job-${++jobCounter}`)

  const indexChannel = (account: AccountRow, prev?: AccountRow) => {
    if (prev?.channelId && prev.channelId !== account.channelId) {
      accountsByChannel.delete(prev.channelId)
    }
    if (account.channelId) accountsByChannel.set(account.channelId, account.accountId)
  }

  const createAccount = async (
    input: CreateAccountInput,
  ): Promise<Result<CalendarAccount, StoreError>> => {
    const k = calendarKey(input.provider, input.userId, input.calendarId)
    if (accountsByCalendar.has(k)) {
      return err({
        _tag: "DuplicateAccount",
        provider: input.provider,
        userId: input.userId,
        calendarId: input.calendarId,
      })
    }
    const id = makeAccountId(crypto.randomUUID())
    const row: AccountRow = {
      accountId: id,
      userId: input.userId,
      provider: input.provider,
      calendarId: input.calendarId,
      status: "active",
      credentials: { ...input.credentials },
      syncToken: input.syncToken,
      channelId: input.channelId,
      resourceId: input.resourceId,
      channelExpiresAt: input.channelExpiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    }
    accountsById.set(id, row)
    accountsByCalendar.set(k, id)
    indexChannel(row)
    return ok(row)
  }

  const getAccount = async (
    accountId: CalendarAccountId,
  ): Promise<Result<CalendarAccount, StoreError>> => {
    const row = accountsById.get(accountId)
    if (!row) return err({ _tag: "AccountNotFound", accountId })
    return ok(row)
  }

  const getAccountByChannelId = async (
    channelId: ChannelId,
  ): Promise<Result<CalendarAccount, StoreError>> => {
    const id = accountsByChannel.get(channelId)
    if (!id) return err({ _tag: "AccountNotFound", channelId })
    const row = accountsById.get(id)
    if (!row) return err({ _tag: "AccountNotFound", channelId })
    return ok(row)
  }

  const getAccountByCalendar = async (
    provider: Provider,
    userId: UserId,
    calendarId: string,
  ): Promise<Result<CalendarAccount, StoreError>> => {
    const id = accountsByCalendar.get(calendarKey(provider, userId, calendarId))
    if (!id) return err({ _tag: "AccountNotFound", calendarId })
    const row = accountsById.get(id)
    if (!row) return err({ _tag: "AccountNotFound", calendarId })
    return ok(row)
  }

  const updateAccount = async (
    accountId: CalendarAccountId,
    patch: AccountPatch,
  ): Promise<Result<CalendarAccount, StoreError>> => {
    const row = accountsById.get(accountId)
    if (!row) return err({ _tag: "AccountNotFound", accountId })
    const next: AccountRow = {
      ...row,
      status: patch.status ?? row.status,
      credentials: patch.credentials ? { ...patch.credentials } : row.credentials,
      syncToken: patch.syncToken === undefined ? row.syncToken : patch.syncToken,
      channelId: patch.channelId === undefined ? row.channelId : patch.channelId,
      resourceId: patch.resourceId === undefined ? row.resourceId : patch.resourceId,
      channelExpiresAt:
        patch.channelExpiresAt === undefined ? row.channelExpiresAt : patch.channelExpiresAt,
      updatedAt: patch.now,
    }
    accountsById.set(accountId, next)
    indexChannel(next, row)
    return ok(next)
  }

  const listAccountsExpiringChannel = async (
    provider: Provider,
    before: Date,
  ): Promise<Result<ReadonlyArray<CalendarAccount>, StoreError>> => {
    const rows: CalendarAccount[] = []
    for (const row of accountsById.values()) {
      if (row.provider !== provider) continue
      if (!row.channelExpiresAt) continue
      if (row.channelExpiresAt.getTime() < before.getTime()) rows.push(row)
    }
    return ok(rows)
  }

  const commitEvents = async (
    input: CommitEventsInput,
  ): Promise<
    Result<{ committedEventIds: ReadonlyArray<CalendarEventId> }, StoreError>
  > => {
    const account = accountsById.get(input.accountId)
    if (!account) return err({ _tag: "AccountNotFound", accountId: input.accountId })

    // Stage everything; no synchronous failure modes after this point so
    // "all or nothing" trivially holds. Real adapters wrap in a transaction.
    const newlyInserted: EventRow[] = []
    const updated: EventRow[] = []
    for (const e of input.events) {
      const k = eventKey(input.accountId, e.eventId)
      const existing = eventsByKey.get(k)
      if (!existing) {
        newlyInserted.push({ ...e, _key: k })
      } else {
        updated.push({ ...e, _key: k })
      }
    }

    // Apply atomically.
    for (const row of newlyInserted) eventsByKey.set(row._key, row)
    for (const row of updated) eventsByKey.set(row._key, row)
    accountsById.set(input.accountId, {
      ...account,
      syncToken: input.newSyncToken,
      updatedAt: input.now,
    })
    const committed: CalendarEventId[] = []
    // Trigger jobs only for newly-arrived OR changed events. Updated rows
    // re-enqueue so handlers can react to status flips, attendee changes, etc.
    for (const row of [...newlyInserted, ...updated]) {
      const job: JobRow = {
        jobId: newJobId(),
        eventId: row.eventId,
        accountId: input.accountId,
        state: "pending",
        attempts: 0,
        lastError: null,
        nextAttemptAt: input.now,
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        createdAt: input.now,
        completedAt: null,
      }
      jobsById.set(job.jobId, job)
      committed.push(row.eventId)
    }

    return ok({ committedEventIds: committed })
  }

  const claimTriggerJobs = async (
    input: ClaimTriggerInput,
  ): Promise<Result<ReadonlyArray<ClaimedJob>, StoreError>> => {
    const claimed: ClaimedJob[] = []
    const nowMs = input.now.getTime()
    for (const job of jobsById.values()) {
      if (claimed.length >= input.limit) break
      if (job.state !== "pending") continue
      if (job.nextAttemptAt && job.nextAttemptAt.getTime() > nowMs) continue
      if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > nowMs) continue

      const lease = new Date(nowMs + input.leaseDurationMs)
      const next: JobRow = {
        ...job,
        claimedAt: input.now,
        claimedBy: input.workerId,
        leaseExpiresAt: lease,
      }
      jobsById.set(job.jobId, next)

      const e = eventsByKey.get(eventKey(job.accountId, job.eventId))
      if (!e) continue
      const { _key: _omit, ...rest } = e
      claimed.push({ job: next, event: rest as CalendarEvent })
    }
    return ok(claimed)
  }

  const markTriggerDone = async (
    jobId: JobId,
    now: Date,
  ): Promise<Result<void, StoreError>> => {
    const job = jobsById.get(jobId)
    if (!job) return err({ _tag: "Permanent", message: `unknown job ${jobId}` })
    jobsById.set(jobId, {
      ...job,
      state: "succeeded",
      completedAt: now,
      nextAttemptAt: null,
      leaseExpiresAt: null,
    })
    return ok(undefined)
  }

  const markTriggerFailed = async (
    jobId: JobId,
    errorStr: string,
    nextAttemptAt: Date | null,
    now: Date,
  ): Promise<Result<void, StoreError>> => {
    const job = jobsById.get(jobId)
    if (!job) return err({ _tag: "Permanent", message: `unknown job ${jobId}` })
    if (nextAttemptAt === null) {
      jobsById.set(jobId, {
        ...job,
        state: "failed",
        attempts: job.attempts + 1,
        lastError: errorStr,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        completedAt: now,
      })
    } else {
      jobsById.set(jobId, {
        ...job,
        attempts: job.attempts + 1,
        lastError: errorStr,
        nextAttemptAt,
        leaseExpiresAt: null,
        claimedAt: null,
        claimedBy: null,
      })
    }
    return ok(undefined)
  }

  return {
    createAccount,
    getAccount,
    getAccountByChannelId,
    getAccountByCalendar,
    updateAccount,
    listAccountsExpiringChannel,
    commitEvents,
    claimTriggerJobs,
    markTriggerDone,
    markTriggerFailed,
    _accounts: () => Array.from(accountsById.values()),
    _events: () =>
      Array.from(eventsByKey.values()).map(({ _key: _, ...e }) => e as CalendarEvent),
    _jobs: () => Array.from(jobsById.values()),
  }
}
