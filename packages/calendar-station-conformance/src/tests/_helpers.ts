import { ChannelId as makeChannelId, UserId as makeUserId } from "calendar-station"
import type {
  CalendarAccount,
  ChannelId,
  Provider,
  StoreAdapter,
  SyncTokenType,
} from "calendar-station"

export const t0 = new Date("2026-01-01T00:00:00Z")
export const dt = (ms: number): Date => new Date(t0.getTime() + ms)

export const seedAccount = async (
  store: StoreAdapter,
  overrides: {
    provider?: Provider
    calendarId?: string
    userId?: string
    syncToken?: SyncTokenType | null
    channelId?: ChannelId | null
    resourceId?: string | null
    channelExpiresAt?: Date | null
  } = {},
): Promise<CalendarAccount> => {
  const r = await store.createAccount({
    userId: makeUserId(overrides.userId ?? "user-1"),
    provider: overrides.provider ?? "google-calendar",
    calendarId: overrides.calendarId ?? "primary",
    credentials: { refreshToken: "rt" },
    syncToken: overrides.syncToken ?? null,
    channelId: overrides.channelId ?? makeChannelId(`ch-${overrides.calendarId ?? "primary"}-${overrides.userId ?? "user-1"}`),
    resourceId: overrides.resourceId ?? "res-1",
    channelExpiresAt: overrides.channelExpiresAt ?? null,
    now: t0,
  })
  if (!r.ok) throw new Error(`seedAccount failed: ${JSON.stringify(r.error)}`)
  return r.value
}
