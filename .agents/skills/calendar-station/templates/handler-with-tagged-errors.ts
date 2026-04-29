// Handler that returns Result<void, HandlerError> with the right tags.
// Tags drive runtime behavior:
//   { _tag: "Transient", message } -> retry per backoff (up to maxAttempts, then dead-letter)
//   { _tag: "Permanent", message } -> dead-letter immediately
//
// Uncaught throws are caught by the kernel and treated as Transient (backstop),
// but you should classify yourself so the intent shows up in logs.

import { err, ok } from "calendar-station"
import type { CalendarEvent, HandlerContext, HandlerError, Result } from "calendar-station"

// Replace these with your real downstream calls.
declare const upsertCalendarRow:           (e: CalendarEvent) => Promise<void>
declare const tombstoneCalendarRow:        (eventId: string)  => Promise<void>
declare const notifyAttendeesViaThirdParty: (e: CalendarEvent) => Promise<void>
declare const isQuotaError: (e: unknown) => boolean
declare const isAuthError:  (e: unknown) => boolean

export const handler = async (
  event: CalendarEvent,
  ctx:   HandlerContext,
): Promise<Result<void, HandlerError>> => {
  // Idempotency note: handlers are invoked at-least-once. Calendar events
  // re-fire on every change (status flip, attendee response, time edit), so
  // your idempotency key should usually be (accountId, eventId, sequence) or
  // (accountId, eventId, etag) — that lets you no-op on duplicate retries
  // while still picking up real changes.

  // ---- step 1: fast path — cancellations ----
  if (event.status === "cancelled") {
    try {
      await tombstoneCalendarRow(event.eventId)
      return ok(undefined)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : "unknown"
      return err<HandlerError>({ _tag: "Transient", message: `tombstone: ${m}`, cause: e })
    }
  }

  // ---- step 2: persistent write with retry-on-blip semantics ----
  try {
    await upsertCalendarRow(event)
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : "unknown"
    return err<HandlerError>({ _tag: "Transient", message: `upsert: ${m}`, cause: e })
  }

  // ---- step 3: external API call that may rate-limit ----
  try {
    await notifyAttendeesViaThirdParty(event)
  } catch (e: unknown) {
    if (isQuotaError(e)) {
      // 429 / rate-limit / quota-exceeded → backoff and retry
      const m = e instanceof Error ? e.message : "rate limited"
      return err<HandlerError>({ _tag: "Transient", message: `notify quota: ${m}`, cause: e })
    }
    if (isAuthError(e)) {
      // 401/403 → don't loop forever; the operator must rotate credentials
      const m = e instanceof Error ? e.message : "auth failed"
      return err<HandlerError>({ _tag: "Permanent", message: `notify auth: ${m}`, cause: e })
    }
    // Default unknown failure to Transient. Promote to Permanent only with confidence.
    const m = e instanceof Error ? e.message : "unknown"
    return err<HandlerError>({ _tag: "Transient", message: `notify: ${m}`, cause: e })
  }

  return ok(undefined)
}

// HandlerContext fields you can read:
//   ctx.jobId     — branded JobId; useful for log correlation
//   ctx.accountId — branded CalendarAccountId; same
//   ctx.attempt   — 1-based attempt counter (1 on first try, increments on retries)
//
// Don't use ctx.attempt for the backoff math — the kernel handles that. Use it
// for "this is attempt 3 of max 10" log lines if you want operator visibility.

// Useful CalendarEvent fields the handler is likely to care about:
//   event.eventId            — branded; stable per Google event
//   event.icalUid            — RFC5545 iCalUID; stable across instances of a series
//   event.status             — "confirmed" | "tentative" | "cancelled"
//   event.start / event.end  — { dateTime: Date|null, date: string|null, timeZone: string|null }
//   event.allDay             — true iff start.date is set and dateTime is null
//   event.attendees[]        — { email, displayName, organizer, self, resource, optional, responseStatus, comment }
//   event.recurrence[]       — RRULE/RDATE/EXDATE strings (don't expand here unless you need to)
//   event.recurringEventId   — set on instance overrides
//   event.originalStartTime  — for instance overrides; the slot the override replaces
//   event.conference         — { conferenceId, conferenceSolution, entryPoints[] }
//   event.hangoutLink        — Google Meet shortcut, if any
//   event.sequence / event.etag — useful as idempotency keys
