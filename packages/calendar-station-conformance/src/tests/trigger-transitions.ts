import { describe, expect, it } from "vitest"
import { SyncToken as makeSyncToken } from "calendar-station"
import type { JobIdType, StoreAdapter } from "calendar-station"
import { synthEvent } from "../fixtures.js"
import { dt, seedAccount, t0 } from "./_helpers.js"

export const triggerTransitionTests = (fresh: () => Promise<StoreAdapter>): void => {
  describe("trigger state transitions", () => {
    const claim1 = async (store: StoreAdapter): Promise<{ jobId: JobIdType }> => {
      const acct = await seedAccount(store)
      await store.commitEvents({
        accountId: acct.accountId,
        events: [synthEvent({ accountId: acct.accountId, eventId: "e" })],
        newSyncToken: makeSyncToken("st-1"),
        now: t0,
      })
      const c = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(1000),
      })
      if (!c.ok) throw new Error("claim failed")
      return { jobId: c.value[0]!.job.jobId }
    }

    it("markTriggerDone: state=succeeded, completedAt set, no longer claimable", async () => {
      const store = await fresh()
      const { jobId } = await claim1(store)
      await store.markTriggerDone(jobId, dt(2000))
      const c = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(120_000),
      })
      expect(c.ok && c.value.length).toBe(0)
    })

    it("markTriggerFailed with future date: state stays pending, attempts+=1", async () => {
      const store = await fresh()
      const { jobId } = await claim1(store)
      await store.markTriggerFailed(jobId, "boom", dt(120_000), dt(2000))
      const c = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(60_000),
      })
      expect(c.ok && c.value.length).toBe(0)
      const c2 = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(180_000),
      })
      expect(c2.ok && c2.value.length).toBe(1)
      if (c2.ok) {
        expect(c2.value[0]!.job.attempts).toBe(1)
        expect(c2.value[0]!.job.lastError).toBe("boom")
        expect(c2.value[0]!.job.jobId).toBe(jobId)
      }
    })

    it("markTriggerFailed with null: state=failed, completedAt set, no longer claimable", async () => {
      const store = await fresh()
      const { jobId } = await claim1(store)
      await store.markTriggerFailed(jobId, "permanent", null, dt(2000))
      const c = await store.claimTriggerJobs({
        workerId: "w1",
        limit: 10,
        leaseDurationMs: 60_000,
        now: dt(120_000),
      })
      expect(c.ok && c.value.length).toBe(0)
    })
  })
}
