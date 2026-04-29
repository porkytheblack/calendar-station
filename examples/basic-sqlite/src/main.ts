import { createServer } from "node:http"
import { createStation, ok, UserId } from "calendar-station"
import { googleCalendarProvider } from "google-calendar-station"
import { createSqliteStore } from "./sqlite-store.js"

/**
 * Runnable smoke test that wires up:
 *   - SQLite-backed Store adapter (this directory)
 *   - The provider-agnostic `calendar-station` core
 *   - The `google-calendar-station` provider plugin
 *   - A tiny http server that mounts the webhook handler
 *
 * Set the env vars below, drop a Google refresh token in REFRESH_TOKEN, and
 * run `node --experimental-strip-types src/main.ts` to start the watcher.
 */
const main = async () => {
  const env = (key: string): string => {
    const v = process.env[key]
    if (!v) throw new Error(`missing env: ${key}`)
    return v
  }

  const store = createSqliteStore(process.env.SQLITE_PATH ?? "./calendar.db")

  const station = createStation({
    store,
    handler: async (event) => {
      console.log(
        `[handler] ${event.status} ${event.summary} @ ${
          event.start.dateTime?.toISOString() ?? event.start.date
        }`,
      )
      return ok(undefined)
    },
    providers: {
      google: googleCalendarProvider({
        googleClientId: env("GOOGLE_CLIENT_ID"),
        googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
        webhookBaseUrl: env("WEBHOOK_BASE_URL"),
        webhookPath: process.env.WEBHOOK_PATH ?? "/webhooks/calendar",
        channelTokenSecret: env("CHANNEL_TOKEN_SECRET"),
      }),
    },
  })

  await station.start()

  const port = Number(process.env.PORT ?? 3000)
  const path = process.env.WEBHOOK_PATH ?? "/webhooks/calendar"
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== path) {
      res.statusCode = 404
      res.end()
      return
    }
    // Drain the (empty) body for completeness.
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const r = await station.providers.google.handleWebhook({
      headers: req.headers,
      body: Buffer.concat(chunks),
    })
    res.statusCode = r.status
    res.end(r.body ?? "")
  })
  server.listen(port, () => console.log(`[ingress] listening on :${port}${path}`))

  if (process.env.REGISTER_CALENDAR && process.env.REFRESH_TOKEN) {
    const r = await station.providers.google.register({
      userId: UserId(process.env.USER_ID ?? "user-1"),
      calendarId: process.env.REGISTER_CALENDAR,
      refreshToken: process.env.REFRESH_TOKEN,
    })
    console.log("[register]", r)
  }

  const shutdown = async () => {
    server.close()
    await station.stop()
    store.close()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown())
  process.on("SIGINT", () => void shutdown())
  await station.wait()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
