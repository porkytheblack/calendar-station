# Mounting the webhook ingress

`google-calendar-station` exposes a framework-agnostic request handler:

```ts
station.providers.google.handleWebhook({
  headers: Record<string, string | string[] | undefined>,
  body?:   string | Buffer | null,
}): Promise<{ status: number; body?: string }>
```

You mount this under whichever HTTP framework you already use. Status codes returned drive Google's retry behavior — see `errors.md` for the full mapping.

## Ground rules

- **The path must match `webhookPath` in your config.** If you set `webhookPath: "/webhooks/calendar"`, mount the handler at `/webhooks/calendar`.
- **Method:** POST only. Reject other methods with 404 or 405.
- **Body parsing:** Google sends an empty body. You don't need a JSON parser. Pass headers; body is optional and unused by `handleWebhook`.
- **Response body:** the handler returns at most a small string (rarely set). Don't add additional headers/middleware that block on a body.
- **TLS:** terminate at your load balancer / CDN. Google requires HTTPS with a CA-signed cert.

## node:http (no framework)

```ts
import { createServer } from "node:http"

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/calendar") {
    res.statusCode = 404
    res.end()
    return
  }
  // Drain the (empty) body for completeness.
  for await (const _ of req) { /* discard */ }

  const r = await station.providers.google.handleWebhook({ headers: req.headers })
  res.statusCode = r.status
  res.end(r.body ?? "")
})
server.listen(3000)
```

See `templates/webhook-mount-node-http.ts` for a runnable copy.

## Express

```ts
import express from "express"

const app = express()

// Don't wrap with body parsers — Google sends an empty body and we don't need it.
app.post("/webhooks/calendar", async (req, res) => {
  const r = await station.providers.google.handleWebhook({ headers: req.headers })
  res.status(r.status).send(r.body ?? "")
})

app.listen(3000)
```

See `templates/webhook-mount-express.ts` for a runnable copy.

## Hono

```ts
import { Hono } from "hono"

const app = new Hono()

app.post("/webhooks/calendar", async (c) => {
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((v, k) => { headers[k] = v })
  const r = await station.providers.google.handleWebhook({ headers })
  return c.body(r.body ?? "", r.status as Parameters<typeof c.body>[1])
})

export default app
```

## Fastify

```ts
import Fastify from "fastify"

const app = Fastify({ logger: true })

app.post("/webhooks/calendar", async (req, reply) => {
  const r = await station.providers.google.handleWebhook({ headers: req.headers })
  reply.code(r.status).send(r.body ?? "")
})

await app.listen({ port: 3000 })
```

## Next.js (App Router)

```ts
// app/webhooks/calendar/route.ts
import { NextRequest, NextResponse } from "next/server"
import { station } from "@/lib/station"   // your createStation export

export const dynamic = "force-dynamic"   // never cache

export async function POST(req: NextRequest) {
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => { headers[k] = v })
  const r = await station.providers.google.handleWebhook({ headers })
  return new NextResponse(r.body ?? "", { status: r.status })
}
```

Two Next-specific notes:
- `force-dynamic` prevents the route from being statically analyzed.
- If you're on Vercel serverless, every webhook spins up a fresh instance — `station` and the Store connection pool need to handle that. Consider `Vercel Edge` only if your Store driver is Edge-compatible.

## Effect HttpServer (`@effect/platform-node`)

```ts
import { HttpServer } from "@effect/platform"
import { Effect } from "effect"

const router = HttpServer.router.empty.pipe(
  HttpServer.router.post(
    "/webhooks/calendar",
    Effect.gen(function* () {
      const req = yield* HttpServer.request.ServerRequest
      const headers = req.headers
      const r = yield* Effect.promise(() =>
        station.providers.google.handleWebhook({ headers }),
      )
      return HttpServer.response.text(r.body ?? "", { status: r.status })
    }),
  ),
)
```

## Behind a reverse proxy / load balancer

Watch out for header forwarding:

- Make sure `X-Goog-Channel-Id`, `X-Goog-Channel-Token`, `X-Goog-Resource-Id`, `X-Goog-Resource-State`, `X-Goog-Message-Number` reach your app. Most reverse proxies forward arbitrary headers by default; some strip non-standard ones.
- If you terminate TLS at a CDN / Cloudflare, ensure the cert is CA-signed and the path doesn't go through a `Cache-Control` rule that returns cached 200s.
- `X-Forwarded-For` and `X-Forwarded-Proto` are fine but not required by the package.

## Testing the mount locally

Combine `decodeWebhook` and `deriveChannelToken` to fake an inbound request:

```ts
import { deriveChannelToken } from "google-calendar-station"

const channelId = "<the registered channel id>"
const token = deriveChannelToken(process.env.CHANNEL_TOKEN_SECRET!, channelId)

await fetch("http://localhost:3000/webhooks/calendar", {
  method: "POST",
  headers: {
    "x-goog-channel-id":     channelId,
    "x-goog-channel-token":  token,
    "x-goog-resource-id":    "<resource id from registration>",
    "x-goog-resource-state": "exists",
    "x-goog-message-number": "1",
  },
})
```

A sync-handshake fake (which the real channel sends right after `events.watch`):

```ts
headers: {
  "x-goog-channel-id":     channelId,
  "x-goog-channel-token":  token,
  "x-goog-resource-id":    "<resource id>",
  "x-goog-resource-state": "sync",
  "x-goog-message-number": "1",
}
```

This produces a 200 with no pipeline activity.

## Choosing `ingressMode`

| | Sync (default) | Deferred |
|---|---|---|
| Webhook latency | bounded by `commitTimeoutMs` (8s default) | bounded by HTTP overhead only (~ms) |
| On commit failure | Google retries (503) | event is **lost** |
| Throughput ceiling | tied to commit speed | bounded only by ingress decode + memory |
| Recommended for | most users | high-volume calendars where retries are expensive and your handler is idempotent against gaps |

If unsure, start with `sync`. The 8s default is well under Google's tolerance, and 503s are recoverable.
