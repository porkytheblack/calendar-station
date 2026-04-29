# google-calendar-station

Google Calendar provider for [`calendar-station`](https://www.npmjs.com/package/calendar-station). Wraps `@googleapis/calendar`, OAuth2 refresh, the `events.watch` channel lifecycle, the webhook ingress, and a pure event parser.

```ts
import { googleCalendarProvider } from "google-calendar-station"

const provider = googleCalendarProvider({
  googleClientId:     process.env.GOOGLE_CLIENT_ID!,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  webhookBaseUrl:     "https://api.example.com",
  webhookPath:        "/webhooks/calendar",
  channelTokenSecret: process.env.CHANNEL_TOKEN_SECRET!,
})
```

Plug into `createStation({ providers: { google: provider } })` from `calendar-station`. Then call `station.providers.google.register({ userId, calendarId, refreshToken })` to start watching a calendar.

The webhook handler is framework-agnostic. Mount it under whatever HTTP framework you use:

```ts
// Express / Hono / Fastify / Effect HttpServer — your call.
app.post("/webhooks/calendar", async (req, res) => {
  const r = await station.providers.google.handleWebhook({
    headers: req.headers,
    body: req.rawBody,
  })
  res.status(r.status).send(r.body ?? "")
})
```

Schedule `station.providers.google.renewExpiringChannels()` from your cron — channels expire in ~7 days and Google has no renewal API; this creates a fresh channel before the old one dies and stops the old channel after a successful swap.

Full design and API surface: [github.com/porkytheblack/calendar-station](https://github.com/porkytheblack/calendar-station).
