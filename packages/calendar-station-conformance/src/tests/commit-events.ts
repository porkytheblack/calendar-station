import { describe, expect, it } from "vitest"
import { SyncToken as makeSyncToken } from "calendar-station"
import type { CalendarEvent, StoreAdapter } from "calendar-station"
import { synthEvent } from "../fixtures.js"
import { dt, seedAccount, t0 } from "./_helpers.js"

export const commitEventsTests = (fresh: () => Promise<StoreAdapter>): void => {
  describe("commitEvents atomicity & idempotency", () => {
    it("inserts new events, advances syncToken, enqueues 1 trigger job per event", async () => {
      const store = await fresh()
      const acct = await seedAccount(store)
      const events: CalendarEvent[] = [
        synthEvent({ accountId: acct.accountId, eventId: "e1" }),
        synthEvent({ accountId: acct.accountId, eventId: "e2" }),
      ]
      const r = await store.commitEvents({
        accountId: acct.accountId,
        events,
        newSyncToken: makeSyncToken("st-1"),
        now: t0,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.committedEventIds.length).toBe(2)

      const a = await store.getAccount(acct.accountId)
      expect(a.ok && a.value.syncToken).toBe("st-1")

      const claimed = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      expect(claimed.ok && claimed.value.length).toBe(2)
    })

    it("re-committing the same event updates and re-enqueues (handlers see changes)", async () => {
      const store = await fresh()
      const acct = await seedAccount(store)
      const e1 = synthEvent({ accountId: acct.accountId, eventId: "e1", summary: "v1" })
      await store.commitEvents({
        accountId: acct.accountId,
        events: [e1],
        newSyncToken: makeSyncToken("st-1"),
        now: t0,
      })
      const e1v2 = synthEvent({ accountId: acct.accountId, eventId: "e1", summary: "v2" })
      const r = await store.commitEvents({
        accountId: acct.accountId,
        events: [e1v2],
        newSyncToken: makeSyncToken("st-2"),
        now: dt(1000),
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.committedEventIds.length).toBe(1)

      const a = await store.getAccount(acct.accountId)
      expect(a.ok && a.value.syncToken).toBe("st-2")

      const claimed = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(2000),
      })
      // Two jobs total — one per commit (the second representing the change).
      expect(claimed.ok && claimed.value.length).toBe(2)
      // The latest stored row reflects the v2 summary.
      if (claimed.ok) {
        const latest = claimed.value.find((c) => c.event.summary === "v2")
        expect(latest).toBeTruthy()
      }
    })

    it("partial new + updated batch: 5 events → 5 jobs, all returned in committedEventIds", async () => {
      const store = await fresh()
      const acct = await seedAccount(store)
      await store.commitEvents({
        accountId: acct.accountId,
        events: [
          synthEvent({ accountId: acct.accountId, eventId: "a" }),
          synthEvent({ accountId: acct.accountId, eventId: "b" }),
        ],
        newSyncToken: makeSyncToken("st-1"),
        now: t0,
      })
      const r = await store.commitEvents({
        accountId: acct.accountId,
        events: [
          synthEvent({ accountId: acct.accountId, eventId: "a", summary: "updated" }),
          synthEvent({ accountId: acct.accountId, eventId: "b", summary: "updated" }),
          synthEvent({ accountId: acct.accountId, eventId: "c" }),
          synthEvent({ accountId: acct.accountId, eventId: "d" }),
          synthEvent({ accountId: acct.accountId, eventId: "e" }),
        ],
        newSyncToken: makeSyncToken("st-2"),
        now: dt(1000),
      })
      expect(r.ok && r.value.committedEventIds.length).toBe(5)

      const claimed = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 100,
        leaseDurationMs: 60_000,
        now: dt(2000),
      })
      // 2 from first commit + 5 from second.
      expect(claimed.ok && claimed.value.length).toBe(7)
    })

    it("empty events array still advances syncToken", async () => {
      const store = await fresh()
      const acct = await seedAccount(store)
      const r = await store.commitEvents({
        accountId: acct.accountId,
        events: [],
        newSyncToken: makeSyncToken("st-1"),
        now: t0,
      })
      expect(r.ok && r.value.committedEventIds.length).toBe(0)
      const a = await store.getAccount(acct.accountId)
      expect(a.ok && a.value.syncToken).toBe("st-1")
    })
  })
}
