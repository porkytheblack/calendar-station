// Daily channel renewal. Calendar channels expire after ~7 days, and Google
// has no renewal API — `renewExpiringChannels()` allocates a fresh channel id,
// calls events.watch, swaps, and stops the old channel after the swap succeeds.
//
// The package does NOT bring its own scheduler. Pick whatever your stack uses
// (node-cron, system cron, GCP Cloud Scheduler, k8s CronJob, BullMQ).
//
// The renewal window in the provider config defaults to 24h, which assumes
// daily-or-better cron. If you cron weekly, raise renewalWindowMs proportionally.

// ---------- Option 1: in-process schedule (node-cron) -----------------------

import cron from "node-cron"
import type { Station } from "calendar-station"

export const scheduleDailyChannelRenewal = <P extends { google: { renewExpiringChannels: () => unknown } }>(
  station: Station<P>,
): { stop: () => void } => {
  // 03:14 UTC every day. Pick a time that's quiet in your environment.
  const task = cron.schedule("14 3 * * *", async () => {
    const r = await station.providers.google.renewExpiringChannels()
    if (!r.ok) {
      // RenewError type is `never` per the API — this branch shouldn't be reachable,
      // but TypeScript will flag it if the API ever widens.
      console.error("[renewal] unexpected error", r.error)
      return
    }
    const { renewed, failed, revoked, details } = r.value
    console.log(`[renewal] renewed=${renewed} failed=${failed} revoked=${revoked}`)
    for (const d of details.filter((x) => x.outcome !== "renewed")) {
      console.warn(`[renewal] ${d.calendarId} -> ${d.outcome}${d.error ? `: ${d.error}` : ""}`)
    }
  }, { timezone: "UTC" })
  task.start()
  return { stop: () => task.stop() }
}

// ---------- Option 2: in-process interval (no extra dep) --------------------

export const scheduleHourlyChannelRenewal = <P extends { google: { renewExpiringChannels: () => unknown } }>(
  station: Station<P>,
): { stop: () => void } => {
  // Every hour is comfortably idempotent — the default renewalWindowMs is 24h,
  // so a renewal only fires for accounts whose channel is within 24h of dying.
  const t = setInterval(async () => {
    const r = await station.providers.google.renewExpiringChannels()
    if (r.ok && (r.value.failed > 0 || r.value.revoked > 0)) {
      console.warn("[renewal]", r.value)
    }
  }, 60 * 60 * 1000)
  return { stop: () => clearInterval(t) }
}

// ---------- Option 3: stand-alone process invoked by an external scheduler ---
//
// Save as `bin/renew.ts` and call from system cron / Cloud Scheduler / k8s CronJob.
// Each invocation does one renewal pass and exits.

import { createStation } from "calendar-station"
import { googleCalendarProvider } from "google-calendar-station"
import { createMyStore } from "./my-store.js"

export const renewOnce = async (): Promise<void> => {
  const store = createMyStore({ /* ... */ })
  const station = createStation({
    store,
    handler: async () => ({ ok: true, value: undefined }),  // unused by renewal
    providers: {
      google: googleCalendarProvider({
        googleClientId:     process.env.GOOGLE_CLIENT_ID!,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        webhookBaseUrl:     process.env.WEBHOOK_BASE_URL!,
        webhookPath:        process.env.WEBHOOK_PATH ?? "/webhooks/calendar",
        channelTokenSecret: process.env.CHANNEL_TOKEN_SECRET!,
      }),
    },
  })
  // No need to call station.start() — renewal doesn't open the ingress.
  // It only reads the Store and calls events.watch / channels.stop.
  const r = await station.providers.google.renewExpiringChannels()
  if (!r.ok) {
    console.error("[renewal] unexpected error", r.error)
    process.exit(1)
  }
  const { renewed, failed, revoked } = r.value
  console.log(`[renewal] renewed=${renewed} failed=${failed} revoked=${revoked}`)
}

// Uncomment if running directly:
// renewOnce().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
