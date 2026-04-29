import type { calendar_v3 } from "@googleapis/calendar"
import {
  CalendarEventId as makeEventId,
} from "calendar-station"
import type {
  Attendee,
  CalendarAccountId,
  CalendarEvent,
  CalendarEventId,
  ConferenceRef,
  EventStatus,
  EventTime,
  Person,
  ResponseStatus,
} from "calendar-station"

/** Pure: parses a Google Calendar event into the provider-neutral shape. */
export const parseGoogleEvent = (
  raw: calendar_v3.Schema$Event,
  accountId: CalendarAccountId,
  calendarId: string,
): CalendarEvent => ({
  eventId: makeEventId(raw.id ?? ""),
  icalUid: raw.iCalUID ?? null,
  accountId,
  provider: "google-calendar",
  calendarId,
  summary: raw.summary ?? "",
  description: raw.description ?? "",
  location: raw.location ?? null,
  status: mapStatus(raw.status),
  htmlLink: raw.htmlLink ?? null,
  start: parseTime(raw.start),
  end: parseTime(raw.end),
  allDay: !!(raw.start?.date && !raw.start?.dateTime),
  creator: parsePerson(raw.creator),
  organizer: parsePerson(raw.organizer),
  attendees: (raw.attendees ?? []).map(parseAttendee),
  recurrence: raw.recurrence ?? [],
  recurringEventId: raw.recurringEventId ? makeEventId(raw.recurringEventId) : null,
  originalStartTime: raw.originalStartTime ? parseTime(raw.originalStartTime) : null,
  conference: parseConference(raw.conferenceData),
  hangoutLink: raw.hangoutLink ?? null,
  createdAt: parseDate(raw.created),
  updatedAt: parseDate(raw.updated),
  etag: raw.etag ?? null,
  sequence: typeof raw.sequence === "number" ? raw.sequence : 0,
})

const mapStatus = (s: string | null | undefined): EventStatus => {
  if (s === "tentative") return "tentative"
  if (s === "cancelled") return "cancelled"
  return "confirmed"
}

const parseTime = (
  t: calendar_v3.Schema$EventDateTime | undefined | null,
): EventTime => {
  if (!t) return { dateTime: null, date: null, timeZone: null }
  let dateTime: Date | null = null
  if (t.dateTime) {
    const d = new Date(t.dateTime)
    if (!Number.isNaN(d.getTime())) dateTime = d
  }
  return {
    dateTime,
    date: t.date ?? null,
    timeZone: t.timeZone ?? null,
  }
}

const parsePerson = (
  p: { email?: string | null; displayName?: string | null } | null | undefined,
): Person | null => {
  if (!p) return null
  if (!p.email && !p.displayName) return null
  return {
    email: p.email ? p.email.toLowerCase() : null,
    displayName: p.displayName?.length ? p.displayName : null,
  }
}

const parseAttendee = (a: calendar_v3.Schema$EventAttendee): Attendee => ({
  email: a.email ? a.email.toLowerCase() : null,
  displayName: a.displayName?.length ? a.displayName : null,
  organizer: !!a.organizer,
  self: !!a.self,
  resource: !!a.resource,
  optional: !!a.optional,
  responseStatus: mapResponse(a.responseStatus),
  comment: a.comment ?? null,
})

const mapResponse = (s: string | null | undefined): ResponseStatus => {
  if (s === "accepted") return "accepted"
  if (s === "declined") return "declined"
  if (s === "tentative") return "tentative"
  return "needsAction"
}

const parseConference = (
  c: calendar_v3.Schema$ConferenceData | null | undefined,
): ConferenceRef | null => {
  if (!c) return null
  const entryPoints = (c.entryPoints ?? []).map((e) => ({
    type: e.entryPointType ?? "unknown",
    uri: e.uri ?? null,
    label: e.label ?? null,
  }))
  return {
    conferenceId: c.conferenceId ?? null,
    conferenceSolution: c.conferenceSolution?.name ?? null,
    entryPoints,
  }
}

const parseDate = (s: string | null | undefined): Date | null => {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export const _internals = { mapStatus, parseTime, parsePerson, parseAttendee, parseConference }

// Convenience predicate; some downstream callers care.
export const isCancellation = (e: CalendarEvent): boolean => e.status === "cancelled"

// Re-export to avoid surprising the consumer who imports parser internals.
export type { CalendarEventId }
