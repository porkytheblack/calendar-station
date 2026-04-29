// Mounting handleWebhook on raw node:http (no framework).
//
// Useful for the example app, for tiny services, or when you want to add
// the webhook endpoint to an existing server without dragging in Express/Hono/etc.

import { createServer, type Server } from "node:http"
import type { Station } from "calendar-station"

type WithGoogle = { google: { handleWebhook: (input: { headers: Record<string, string | string[] | undefined>; body?: string | Buffer | null }) => Promise<{ status: number; body?: string }> } }

export const startWebhookServer = <P extends WithGoogle>(
  port: number,
  path: string,
  station: Station<P>,
): Server => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== path) {
      res.statusCode = 404
      res.end()
      return
    }
    // Google sends an empty body, but draining keeps middleware happy and
    // prevents resource leaks if a proxy ever sends one.
    for await (const _ of req) { /* discard */ }

    const r = await station.providers.google.handleWebhook({ headers: req.headers })
    res.statusCode = r.status
    res.end(r.body ?? "")
  })
  server.listen(port, () => console.log(`[ingress] listening on :${port}${path}`))
  return server
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
//     google: googleCalendarProvider({ /* ... */ }),
//   },
// })
// await station.start()
//
// const server = startWebhookServer(3000, "/webhooks/calendar", station)
//
// process.on("SIGTERM", () => {
//   server.close()
//   void station.stop()
// })

// Notes:
// - Terminate TLS at a reverse proxy / CDN, not in this process. Google rejects
//   self-signed certs and requires HTTPS.
// - For a quick local-dev TLS terminator, ngrok or cloudflared works.
// - If you want to add health/ready endpoints alongside, just add more `if`
//   branches on `req.url` — there's nothing magical about the node:http path.
