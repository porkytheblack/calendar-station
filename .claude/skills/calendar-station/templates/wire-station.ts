// Minimal calendar-station + google-calendar-station wire-up.
// Copy into a fresh Node project and adapt the Store + handler to your needs.
//
// Required env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//               WEBHOOK_BASE_URL (HTTPS, CA-signed cert), CHANNEL_TOKEN_SECRET.
// Optional:     WEBHOOK_PATH (default /webhooks/calendar), PORT (default 3000),
//               REGISTER_CALENDAR + REFRESH_TOKEN to register on startup.

import { createServer } from "node:http"
import { consoleLogger, createStation, ok, UserId } from "calendar-station"
import { googleCalendarProvider } from "google-calendar-station"
import { createMyStore } from "./my-store.js"   // your StoreAdapter — see postgres-store.ts template

const main = async () => {
  const store = createMyStore({ /* connection config */ })

  const station = createStation({
    store,
    logger: consoleLogger,            // omit to use the default; or pass your own structured logger

    handler: async (event, ctx) => {
      // your business logic. Return ok(undefined) on success,
      // err({ _tag: "Transient", message }) to retry,
      // err({ _tag: "Permanent", message }) to dead-letter immediately.
      console.log(
        `[handler] ${event.status} ${event.summary} @ ${
          event.start.dateTime?.toISOString() ?? event.start.date
        } (attempt ${ctx.attempt})`,
      )
      return ok(undefined)
    },

    config: {
      // All optional — these are the defaults; uncomment to override.
      // triggerConcurrency: 8,
      // claimBatchSize:     16,
      // leaseDurationMs:    5 * 60_000,
      // maxAttempts:        10,
      // backoff:            { baseMs: 30_000, factor: 2, maxMs: 5*60_000, jitterFactor: 0.25 },
    },

    providers: {
      google: googleCalendarProvider({
        googleClientId:     process.env.GOOGLE_CLIENT_ID!,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        webhookBaseUrl:     process.env.WEBHOOK_BASE_URL!,    // e.g. https://api.example.com
        webhookPath:        process.env.WEBHOOK_PATH ?? "/webhooks/calendar",
        channelTokenSecret: process.env.CHANNEL_TOKEN_SECRET!,
        // ingressMode: "sync",            // default; "deferred" trades retry safety for lower webhook latency
        // commitTimeoutMs: 8_000,         // default; race the pipeline against Google's tolerance
        // channelTtlMs: 7 * 24 * 60 * 60 * 1000,  // default 7d; what we ask Google for
        // renewalWindowMs: 24 * 60 * 60 * 1000,   // default 24h; what renewExpiringChannels considers
      }),
    },
  })

  await station.start()

  // Mount the webhook handler. The package gives you a request-level function;
  // wire it into whichever HTTP framework you use. node:http shown here for
  // dependency-free demonstration.
  const port = Number(process.env.PORT ?? 3000)
  const path = process.env.WEBHOOK_PATH ?? "/webhooks/calendar"
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== path) {
      res.statusCode = 404
      res.end()
      return
    }
    // Google sends an empty body, but draining it keeps middleware happy.
    for await (const _ of req) { /* discard */ }
    const r = await station.providers.google.handleWebhook({ headers: req.headers })
    res.statusCode = r.status
    res.end(r.body ?? "")
  })
  server.listen(port, () => console.log(`[ingress] listening on :${port}${path}`))

  // Register an account once you have a refresh token from your OAuth flow.
  // Idempotent on (provider, userId, calendarId); subsequent calls return DuplicateAccount.
  if (process.env.REGISTER_CALENDAR && process.env.REFRESH_TOKEN) {
    const r = await station.providers.google.register({
      userId:       UserId(process.env.USER_ID ?? "user-1"),
      calendarId:   process.env.REGISTER_CALENDAR,             // "primary" or a specific id
      refreshToken: process.env.REFRESH_TOKEN,
    })
    if (!r.ok) {
      if (r.error._tag === "DuplicateAccount") {
        console.log(`[register] ${process.env.REGISTER_CALENDAR} already registered — continuing`)
      } else {
        console.error("[register] failed:", r.error)
        await station.stop()
        process.exit(1)
      }
    } else {
      console.log(`[register] ok — accountId=${r.value.accountId}`)
    }
  }

  // Schedule channel renewal. Channels expire in ~7 days; Google has no
  // renewal API, so we create fresh channels before the old ones die.
  // The default renewalWindowMs (24h) means hourly is comfortably idempotent.
  const renewalTimer = setInterval(() => {
    void station.providers.google.renewExpiringChannels().then((r) => {
      if (r.ok && (r.value.failed > 0 || r.value.revoked > 0)) {
        console.warn("[renewal]", r.value)
      }
    })
  }, 60 * 60 * 1000)

  // Graceful shutdown.
  const shutdown = async () => {
    clearInterval(renewalTimer)
    server.close()
    await station.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown())
  process.on("SIGINT",  () => void shutdown())
  await station.wait()
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1) })
