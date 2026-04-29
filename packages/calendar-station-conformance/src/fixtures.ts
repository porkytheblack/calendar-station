import {
  CalendarAccountId as makeAccountId,
  CalendarEventId as makeEventId,
  ChannelId as makeChannelId,
  SyncToken as makeSyncToken,
  UserId as makeUserId,
} from "calendar-station"
import type {
  CalendarAccountId,
  CalendarEvent,
  CalendarEventId,
  ChannelId,
  SyncToken,
} from "calendar-station"

export const synthEvent = (
  overrides: Omit<Partial<CalendarEvent>, "eventId"> & {
    accountId: CalendarAccountId
    eventId: string
  },
): CalendarEvent => ({
  eventId: makeEventId(overrides.eventId),
  icalUid: overrides.icalUid ?? `${overrides.eventId}@example.com`,
  accountId: overrides.accountId,
  provider: "google-calendar",
  calendarId: overrides.calendarId ?? "primary",
  summary: overrides.summary ?? `Event ${overrides.eventId}`,
  description: overrides.description ?? "",
  location: overrides.location ?? null,
  status: overrides.status ?? "confirmed",
  htmlLink: overrides.htmlLink ?? null,
  start: overrides.start ?? {
    dateTime: new Date("2026-01-01T10:00:00Z"),
    date: null,
    timeZone: "UTC",
  },
  end: overrides.end ?? {
    dateTime: new Date("2026-01-01T11:00:00Z"),
    date: null,
    timeZone: "UTC",
  },
  allDay: overrides.allDay ?? false,
  creator: overrides.creator ?? null,
  organizer: overrides.organizer ?? null,
  attendees: overrides.attendees ?? [],
  recurrence: overrides.recurrence ?? [],
  recurringEventId: overrides.recurringEventId ?? null,
  originalStartTime: overrides.originalStartTime ?? null,
  conference: overrides.conference ?? null,
  hangoutLink: overrides.hangoutLink ?? null,
  createdAt: overrides.createdAt ?? null,
  updatedAt: overrides.updatedAt ?? null,
  etag: overrides.etag ?? null,
  sequence: overrides.sequence ?? 0,
})

export const aUserId = (s = "user-1") => makeUserId(s)
export const anEventId = (s: string): CalendarEventId => makeEventId(s)
export const anAccountId = (): CalendarAccountId => makeAccountId(crypto.randomUUID())
export const aChannelId = (s = "ch-1"): ChannelId => makeChannelId(s)
export const aSyncToken = (s: string): SyncToken => makeSyncToken(s)
