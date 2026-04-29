// Mounting handleWebhook in Express.
//
// The handler is framework-agnostic; you just hand it `headers` and forward
// the response status/body. Google sends an empty body, so no parser needed.

import express from "express"
import type { Station } from "calendar-station"

type WithGoogle = { google: { handleWebhook: (input: { headers: Record<string, string | string[] | undefined>; body?: string | Buffer | null }) => Promise<{ status: number; body?: string }> } }

export const mountWebhook = <P extends WithGoogle>(
  app: express.Express,
  path: string,
  station: Station<P>,
): void => {
  // Don't wrap with body parsers — Google sends an empty body and we don't need it.
  app.post(path, async (req, res) => {
    const r = await station.providers.google.handleWebhook({ headers: req.headers })
    res.status(r.status).send(r.body ?? "")
  })
}

// ---------- Usage ----------

// import { createStation } from "calendar-station"
// import { googleCalendarProvider } from "google-calendar-station"
// import { createMyStore } from "./my-store.js"
//
// const station = createStation({
//   store: createMyStore({ /* ... */ }),
//   handler: async () => ({ ok: true, value: undefined }),
//   providers: {
//     google: googleCalendarProvider({
//       googleClientId:     process.env.GOOGLE_CLIENT_ID!,
//       googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
//       webhookBaseUrl:     "https://api.example.com",
//       webhookPath:        "/webhooks/calendar",
//       channelTokenSecret: process.env.CHANNEL_TOKEN_SECRET!,
//     }),
//   },
// })
// await station.start()
//
// const app = express()
// mountWebhook(app, "/webhooks/calendar", station)
// app.listen(3000)

// Notes:
// - Make sure your reverse proxy / load balancer forwards the X-Goog-* headers
//   (most do by default; some strip non-standard ones).
// - Don't enable response caching on this path; each invocation must hit the
//   handler so syncToken gets advanced and trigger jobs are enqueued.
// - If you use Helmet or similar middleware, exclude this path from any rules
//   that demand a CSRF token or specific Content-Type — Google won't include them.
