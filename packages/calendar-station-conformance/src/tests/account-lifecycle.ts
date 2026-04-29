import { describe, expect, it } from "vitest"
import {
  CalendarAccountId as makeAccountId,
  ChannelId as makeChannelId,
  SyncToken as makeSyncToken,
} from "calendar-station"
import type { StoreAdapter, UserIdType } from "calendar-station"
import { aUserId } from "../fixtures.js"
import { dt, seedAccount, t0 } from "./_helpers.js"

export const accountLifecycleTests = (fresh: () => Promise<StoreAdapter>): void => {
  describe("account lifecycle", () => {
    it("createAccount returns a new account with generated accountId", async () => {
      const store = await fresh()
      const r = await store.createAccount({
        userId: aUserId(),
        provider: "google-calendar",
        calendarId: "primary",
        credentials: { refreshToken: "rt" },
        syncToken: null,
        channelId: makeChannelId("ch-a"),
        resourceId: "res-a",
        channelExpiresAt: null,
        now: t0,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.accountId).toBeTruthy()
      expect(r.value.calendarId).toBe("primary")
      expect(r.value.status).toBe("active")
    })

    it("createAccount with existing (provider, userId, calendarId) → DuplicateAccount", async () => {
      const store = await fresh()
      await seedAccount(store)
      const r = await store.createAccount({
        userId: aUserId(),
        provider: "google-calendar",
        calendarId: "primary",
        credentials: {},
        syncToken: null,
        channelId: makeChannelId("ch-dup"),
        resourceId: "res-dup",
        channelExpiresAt: null,
        now: t0,
      })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error._tag).toBe("DuplicateAccount")
    })

    it("getAccount nonexistent → AccountNotFound", async () => {
      const store = await fresh()
      const r = await store.getAccount(makeAccountId("does-not-exist"))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error._tag).toBe("AccountNotFound")
    })

    it("getAccountByChannelId nonexistent → AccountNotFound", async () => {
      const store = await fresh()
      const r = await store.getAccountByChannelId(makeChannelId("ch-nope"))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error._tag).toBe("AccountNotFound")
    })

    it("getAccountByCalendar nonexistent → AccountNotFound", async () => {
      const store = await fresh()
      const r = await store.getAccountByCalendar(
        "google-calendar",
        aUserId() as UserIdType,
        "missing",
      )
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error._tag).toBe("AccountNotFound")
    })

    it("getAccountByChannelId resolves a registered account", async () => {
      const store = await fresh()
      const acct = await seedAccount(store, { channelId: makeChannelId("ch-find-me") })
      const r = await store.getAccountByChannelId(makeChannelId("ch-find-me"))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.accountId).toBe(acct.accountId)
    })

    it("updateAccount changes credentials, status, syncToken, channel fields independently", async () => {
      const store = await fresh()
      const acct = await seedAccount(store)
      const r1 = await store.updateAccount(acct.accountId, {
        credentials: { refreshToken: "new" },
        now: dt(1000),
      })
      expect(r1.ok && (r1.value.credentials as { refreshToken: string }).refreshToken).toBe(
        "new",
      )
      const r2 = await store.updateAccount(acct.accountId, {
        status: "revoked",
        now: dt(2000),
      })
      expect(r2.ok && r2.value.status).toBe("revoked")
      expect(r2.ok && (r2.value.credentials as { refreshToken: string }).refreshToken).toBe(
        "new",
      )
      const r3 = await store.updateAccount(acct.accountId, {
        syncToken: makeSyncToken("st-1"),
        now: dt(3000),
      })
      expect(r3.ok && r3.value.syncToken).toBe("st-1")
      const r4 = await store.updateAccount(acct.accountId, {
        channelExpiresAt: dt(60_000),
        now: dt(4000),
      })
      expect(r4.ok && r4.value.channelExpiresAt?.getTime()).toBe(dt(60_000).getTime())
    })

    it("updateAccount can rotate the channelId; lookup follows the new id", async () => {
      const store = await fresh()
      const acct = await seedAccount(store, { channelId: makeChannelId("ch-old") })
      const r = await store.updateAccount(acct.accountId, {
        channelId: makeChannelId("ch-new"),
        resourceId: "res-new",
        now: dt(1000),
      })
      expect(r.ok && r.value.channelId).toBe("ch-new")
      const lookup = await store.getAccountByChannelId(makeChannelId("ch-new"))
      expect(lookup.ok).toBe(true)
    })

    it("listAccountsExpiringChannel filters by provider AND channelExpiresAt < cutoff", async () => {
      const store = await fresh()
      await seedAccount(store, {
        calendarId: "expiring",
        channelId: makeChannelId("ch-expiring"),
        channelExpiresAt: dt(10_000),
      })
      await seedAccount(store, {
        calendarId: "later",
        channelId: makeChannelId("ch-later"),
        channelExpiresAt: dt(100_000),
      })
      await seedAccount(store, {
        calendarId: "no-watch",
        channelId: null,
        channelExpiresAt: null,
      })
      const r = await store.listAccountsExpiringChannel("google-calendar", dt(50_000))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const cals = r.value.map((a) => a.calendarId).sort()
      expect(cals).toEqual(["expiring"])
    })
  })
}
