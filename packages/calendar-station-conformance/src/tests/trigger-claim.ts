import { describe, expect, it } from "vitest"
import { SyncToken as makeSyncToken } from "calendar-station"
import type { CalendarAccountId, CalendarEvent, StoreAdapter } from "calendar-station"
import { synthEvent } from "../fixtures.js"
import { dt, seedAccount, t0 } from "./_helpers.js"

export const triggerClaimTests = (fresh: () => Promise<StoreAdapter>): void => {
  describe("trigger outbox claim semantics", () => {
    const seed = async (
      store: StoreAdapter,
      n = 3,
    ): Promise<{ accountId: CalendarAccountId }> => {
      const acct = await seedAccount(store)
      const events: CalendarEvent[] = []
      for (let i = 0; i < n; i++) {
        events.push(synthEvent({ accountId: acct.accountId, eventId: `e${i}` }))
      }
      await store.commitEvents({
        accountId: acct.accountId,
        events,
        newSyncToken: makeSyncToken("st-1"),
        now: t0,
      })
      return { accountId: acct.accountId }
    }

    it("respects nextAttemptAt > now (not yet ready)", async () => {
      const store = await fresh()
      await seed(store, 1)
      const claim = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      expect(claim.ok && claim.value.length).toBe(1)
      const job = claim.ok
        ? claim.value[0]!.job.jobId
        : (() => {
            throw new Error()
          })()
      await store.markTriggerFailed(job, "x", dt(60_000), dt(2000))
      const claim2 = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(3000),
      })
      expect(claim2.ok && claim2.value.length).toBe(0)
    })

    it("respects state ≠ pending", async () => {
      const store = await fresh()
      await seed(store, 1)
      const c1 = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      const id = c1.ok
        ? c1.value[0]!.job.jobId
        : (() => {
            throw new Error()
          })()
      await store.markTriggerDone(id, dt(2000))
      const c2 = await store.claimTriggerJobs({
        workerId: "w2",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(3000),
      })
      expect(c2.ok && c2.value.length).toBe(0)
    })

    it("respects valid lease", async () => {
      const store = await fresh()
      await seed(store, 1)
      const c1 = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      expect(c1.ok && c1.value.length).toBe(1)
      const c2 = await store.claimTriggerJobs({
        workerId: "w2",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(5_000),
      })
      expect(c2.ok && c2.value.length).toBe(0)
    })

    it("returns expired-lease jobs as claimable", async () => {
      const store = await fresh()
      await seed(store, 1)
      await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      const c2 = await store.claimTriggerJobs({
        workerId: "w2",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(120_000),
      })
      expect(c2.ok && c2.value.length).toBe(1)
      if (c2.ok) expect(c2.value[0]!.job.claimedBy).toBe("w2")
    })

    it("concurrent claims from two workers: no overlap (mutex invariant)", async () => {
      const store = await fresh()
      await seed(store, 5)
      const [a, b] = await Promise.all([
        store.claimTriggerJobs({
          workerId: "wa",
          limit: 5,
          leaseDurationMs: 60_000,
          now: dt(1000),
        }),
        store.claimTriggerJobs({
          workerId: "wb",
          limit: 5,
          leaseDurationMs: 60_000,
          now: dt(1000),
        }),
      ])
      const ids = (r: typeof a) => (r.ok ? r.value.map((c) => c.job.jobId) : [])
      const set = new Set<string>([...ids(a), ...ids(b)])
      expect(set.size).toBe(ids(a).length + ids(b).length)
      expect(ids(a).length + ids(b).length).toBe(5)
    })

    it("respects limit", async () => {
      const store = await fresh()
      await seed(store, 5)
      const c = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 2,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      expect(c.ok && c.value.length).toBe(2)
    })

    it("returns ClaimedJob with full event joined", async () => {
      const store = await fresh()
      await seed(store, 1)
      const c = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      expect(c.ok).toBe(true)
      if (!c.ok) return
      expect(c.value[0]!.event.eventId).toBe("e0")
      expect(c.value[0]!.event.summary).toMatch(/Event e0/)
    })
  })
}
