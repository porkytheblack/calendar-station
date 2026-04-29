import { describe, expect, it } from "vitest"
import { CalendarAccountId as makeAccountId } from "calendar-station"
import { parseGoogleEvent } from "./parser.js"

const accountId = makeAccountId("acc-1")

describe("parseGoogleEvent", () => {
  it("parses a confirmed timed event with attendees and conference", () => {
    const e = parseGoogleEvent(
      {
        id: "evt-1",
        iCalUID: "uid-1@example.com",
        status: "confirmed",
        summary: "Team sync",
        description: "weekly",
        location: "Room 1",
        htmlLink: "https://calendar.google.com/event?eid=...",
        start: { dateTime: "2026-04-29T10:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-04-29T11:00:00Z", timeZone: "UTC" },
        creator: { email: "Alice@Example.com", displayName: "Alice" },
        organizer: { email: "Bob@Example.com" },
        attendees: [
          { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
          { email: "carol@example.com", responseStatus: "needsAction", optional: true },
          { email: "dave@example.com", responseStatus: "declined", organizer: true, self: true },
        ],
        conferenceData: {
          conferenceId: "abc-defg-hij",
          conferenceSolution: { name: "Google Meet" },
          entryPoints: [
            { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij", label: "meet" },
          ],
        },
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        created: "2026-04-01T00:00:00Z",
        updated: "2026-04-15T00:00:00Z",
        etag: "\"123\"",
        sequence: 2,
      },
      accountId,
      "primary",
    )

    expect(e.eventId).toBe("evt-1")
    expect(e.icalUid).toBe("uid-1@example.com")
    expect(e.status).toBe("confirmed")
    expect(e.summary).toBe("Team sync")
    expect(e.location).toBe("Room 1")
    expect(e.allDay).toBe(false)
    expect(e.start.dateTime?.toISOString()).toBe("2026-04-29T10:00:00.000Z")
    expect(e.end.dateTime?.toISOString()).toBe("2026-04-29T11:00:00.000Z")
    expect(e.start.timeZone).toBe("UTC")
    expect(e.creator?.email).toBe("alice@example.com")
    expect(e.organizer?.email).toBe("bob@example.com")
    expect(e.attendees).toHaveLength(3)
    expect(e.attendees[0]?.responseStatus).toBe("accepted")
    expect(e.attendees[1]?.optional).toBe(true)
    expect(e.attendees[2]?.organizer).toBe(true)
    expect(e.attendees[2]?.self).toBe(true)
    expect(e.conference?.conferenceSolution).toBe("Google Meet")
    expect(e.conference?.entryPoints[0]?.type).toBe("video")
    expect(e.hangoutLink).toBe("https://meet.google.com/abc-defg-hij")
    expect(e.sequence).toBe(2)
    expect(e.etag).toBe("\"123\"")
  })

  it("treats events with start.date (no dateTime) as all-day", () => {
    const e = parseGoogleEvent(
      {
        id: "all-day",
        status: "confirmed",
        start: { date: "2026-04-29" },
        end: { date: "2026-04-30" },
      },
      accountId,
      "primary",
    )
    expect(e.allDay).toBe(true)
    expect(e.start.date).toBe("2026-04-29")
    expect(e.start.dateTime).toBeNull()
  })

  it("maps cancelled status", () => {
    const e = parseGoogleEvent(
      { id: "x", status: "cancelled" },
      accountId,
      "primary",
    )
    expect(e.status).toBe("cancelled")
  })

  it("captures recurrence + recurringEventId for instance overrides", () => {
    const series = parseGoogleEvent(
      {
        id: "series",
        status: "confirmed",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      },
      accountId,
      "primary",
    )
    expect(series.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"])
    expect(series.recurringEventId).toBeNull()

    const instance = parseGoogleEvent(
      {
        id: "series_20260504T100000Z",
        status: "confirmed",
        recurringEventId: "series",
        originalStartTime: { dateTime: "2026-05-04T10:00:00Z", timeZone: "UTC" },
      },
      accountId,
      "primary",
    )
    expect(instance.recurringEventId).toBe("series")
    expect(instance.originalStartTime?.dateTime?.toISOString()).toBe(
      "2026-05-04T10:00:00.000Z",
    )
  })

  it("handles empty / minimal event without crashing", () => {
    const e = parseGoogleEvent({ id: "min" }, accountId, "primary")
    expect(e.eventId).toBe("min")
    expect(e.summary).toBe("")
    expect(e.attendees).toEqual([])
    expect(e.recurrence).toEqual([])
    expect(e.creator).toBeNull()
    expect(e.organizer).toBeNull()
    expect(e.conference).toBeNull()
  })
})
