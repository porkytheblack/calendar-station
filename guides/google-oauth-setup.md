# Google OAuth setup for `google-calendar-station`

Step-by-step setup to get from a fresh Google Cloud project to a refresh token you can hand to `station.providers.google.register({ userId, calendarId, refreshToken })`.

This package does **not** implement the OAuth consent UX — your app does that, and hands the resulting refresh token to `register()`. This guide walks the operator through the Google Cloud side and shows two ways to obtain a refresh token: a one-shot CLI script (good enough for testing) and a server-side flow (what your real app should do).

## Prerequisites

- A Google account that can administer a Google Cloud project.
- A backend that can serve the webhook endpoint over **HTTPS with a CA-signed cert**. Self-signed and `localhost` will not work — Google rejects them when calling `events.watch`. For local development, tunnel through ngrok / cloudflared / similar.

## 1. Pick (or create) a Google Cloud project

1. Open <https://console.cloud.google.com/>.
2. Create a new project, or reuse the one you already use for `gmail-station` if you have one — Calendar and Gmail can share the same project, OAuth client, and consent screen. They just need different scopes.
3. Note the project id; you'll see it in the console header.

## 2. Enable the Calendar API

1. Console → **APIs & Services → Library**.
2. Search for **Google Calendar API**.
3. Click **Enable**.

You do *not* need to enable Pub/Sub for this package — Calendar uses webhooks, not Pub/Sub. (If you also run `gmail-station` in the same project, Pub/Sub stays enabled for Gmail; Calendar simply doesn't use it.)

## 3. Configure the OAuth consent screen

1. Console → **APIs & Services → OAuth consent screen**.
2. Choose **External** unless you're a Workspace admin restricting to your org (then **Internal**).
3. Fill in the app name, user support email, developer contact email.
4. **Scopes** step: click **Add or remove scopes** and add:

   ```
   https://www.googleapis.com/auth/calendar.readonly
   ```

   That's the only scope `google-calendar-station` v1 needs. It permits `events.list`, `events.watch`, `channels.stop` — read-only watch + list. Do **not** request `calendar` (read/write) unless your app's own UI needs it; the smaller scope sails through verification.
5. **Test users** step (External + Testing publishing status only): add the Google accounts you'll use to develop with. Until you publish, only listed test users can grant consent.
6. Save. Leave publishing status as **Testing** while you iterate; switch to **In production** once verification passes.

### About verification

`calendar.readonly` is *not* a sensitive or restricted scope, so app verification is straightforward. You'll still go through the standard verification checklist before flipping to production, but no security assessment / annual review like with Gmail's `gmail.readonly`.

## 4. Create an OAuth 2.0 Client ID

1. Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type:** *Web application* (even if your "app" is a CLI — the type controls how redirects work; web is the most flexible).
3. **Authorized redirect URIs:** add every URI you'll use for the OAuth callback. At minimum:
   - `http://localhost:53682` — for the local-CLI flow in §6.
   - `https://api.example.com/oauth/google/callback` — for your production backend.
4. Click **Create**. Copy the **Client ID** and **Client secret**; you'll set them as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

If you're sharing the OAuth client with `gmail-station` in the same project, you can keep using its existing client id and secret — just make sure the Calendar scope is added to the consent screen.

## 5. Webhook endpoint requirements

Before you ever call `events.watch`, you need a public HTTPS URL with a valid CA-signed certificate that responds 200 to Google's webhook POSTs. Google rejects:

- `http://` URLs.
- Self-signed certs.
- IP addresses without a domain (no `https://1.2.3.4/webhooks`).
- Hostnames that don't resolve from Google's network.

Two ways to satisfy this:

- **Production:** terminate TLS at your load balancer / CDN (ALB, Cloudflare, fly.io, Vercel, …) using its managed cert.
- **Development:** tunnel a public HTTPS URL to your local box. ngrok and cloudflared both work; ngrok's free tier rotates the URL on every restart, which is annoying for `events.watch` since the channel embeds the URL — pin a reserved domain or use cloudflared.

Choose a stable path; `/webhooks/calendar` is the convention used by the example. The full URL `webhookBaseUrl + webhookPath` is what gets registered with Google.

## 6. Get a refresh token

Pick the flow that fits.

### Option A — one-shot CLI (testing)

Useful for poking at the package end-to-end without building a real OAuth flow.

```ts
// scripts/get-refresh-token.ts
// run: node --experimental-strip-types scripts/get-refresh-token.ts
import { OAuth2Client } from "google-auth-library"
import { createServer } from "node:http"
import { exec } from "node:child_process"

const REDIRECT = "http://localhost:53682"
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]

const client = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: REDIRECT,
})

const url = client.generateAuthUrl({
  access_type: "offline",        // <-- mandatory for a refresh_token
  prompt: "consent",             // <-- forces refresh_token even on re-grant
  scope: SCOPES,
})

console.log("Open this URL in a browser:\n", url)
exec(`xdg-open "${url}" || open "${url}"`)

createServer(async (req, res) => {
  const code = new URL(req.url!, REDIRECT).searchParams.get("code")
  if (!code) { res.statusCode = 400; res.end("missing code"); return }
  res.end("done — check your terminal")
  const { tokens } = await client.getToken(code)
  console.log("\nrefresh_token:", tokens.refresh_token)
  process.exit(0)
}).listen(53682)
```

Two important flags:

- `access_type: "offline"` — without this, Google returns only a short-lived access token, no refresh token.
- `prompt: "consent"` — by default, if the user has already granted access for these scopes, Google **omits** the refresh token. Forcing `prompt=consent` makes it return a fresh one every time.

Set the env vars and run it; the refresh token prints to your terminal. Keep it secret.

### Option B — server-side flow (production)

Your real app probably already has an OAuth flow. The shape:

1. Redirect the user to `client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/calendar.readonly"], state })`.
2. On callback, exchange `code` for tokens via `client.getToken(code)`.
3. Persist `tokens.refresh_token` in your user-account table (encrypted at rest).
4. Call `station.providers.google.register({ userId, calendarId, refreshToken })`.

If a user revokes access via <https://myaccount.google.com/permissions>, the next call will fail with `CredentialsRevoked` — `google-calendar-station` flips the account to `status: "revoked"` automatically. Show that user a "reconnect" CTA.

## 7. Configure `googleCalendarProvider`

```ts
import { googleCalendarProvider } from "google-calendar-station"

const provider = googleCalendarProvider({
  googleClientId:     process.env.GOOGLE_CLIENT_ID!,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  webhookBaseUrl:     "https://api.example.com",
  webhookPath:        "/webhooks/calendar",
  channelTokenSecret: process.env.CHANNEL_TOKEN_SECRET!, // long random string, see §8
})
```

`channelTokenSecret` is used to derive a per-channel HMAC token that's sent to Google in `events.watch` and verified on every inbound webhook. Don't reuse it across environments.

```sh
# generate one:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 8. Choose a `calendarId`

`register({ calendarId, ... })` accepts:

- `"primary"` — the user's main calendar. Most apps want this.
- A specific calendar id, e.g. `"abc123@group.calendar.google.com"`. Use Google's `calendarList.list` (under `calendar.readonly`) to enumerate; or paste the id from the calendar settings page in the Google Calendar UI.

Each registration watches **one** calendar. To watch multiple, register separately — each one gets its own `CalendarAccount` row with its own channel.

## 9. Schedule channel renewal

Channels expire in 7 days; Google has no renewal API. The package exposes:

```ts
await station.providers.google.renewExpiringChannels()
```

Call this from your scheduler at least daily. A safe choice:

```ts
import { setInterval } from "node:timers"
setInterval(
  () => void station.providers.google.renewExpiringChannels(),
  60 * 60 * 1000, // hourly is fine; the renewal window default is 24h, so it's idempotent
)
```

Or wire it into whatever cron / background-job framework you use. The renewal lookahead is configurable via `renewalWindowMs` (default 24h).

## Troubleshooting

| Symptom                                        | Cause / fix                                                                                          |
|------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `register` returns `InvalidGrant`              | Refresh token revoked or wrong client secret. Re-run the OAuth flow with `prompt: "consent"`.        |
| `events.watch` 400 "address must use HTTPS"    | Webhook URL is `http://` or has an invalid cert. Fix TLS / use a tunnel with a real cert.            |
| `events.watch` 400 "Invalid channel id"        | The channel id you passed (a UUID) clashes with an existing live channel. Allocate a new UUID.       |
| Webhooks never arrive                          | Verify the URL is reachable from the public internet; check `https://yourdomain/webhooks/calendar` in a browser. Look for the channel-creation `sync` POST in your logs immediately after `register`. |
| `webhook.token_mismatch` log on every request  | `channelTokenSecret` rotated without re-registering accounts. Either re-register or restore the old secret. |
| `event.sync_token_gone` log                    | Worker was offline long enough that the syncToken expired. The package recovers automatically by re-paginating; no action needed. |
| `account.revoked` log fires                    | User revoked access via Google account permissions UI. Surface a reconnect CTA in your app.          |

## Summary checklist

- [ ] Google Cloud project picked / created.
- [ ] Calendar API enabled.
- [ ] OAuth consent screen has the `calendar.readonly` scope.
- [ ] OAuth 2.0 Client ID created (Web application); client id + secret in env.
- [ ] Webhook endpoint reachable over HTTPS with a valid CA cert.
- [ ] `channelTokenSecret` generated (32 bytes) and set.
- [ ] Refresh token obtained for at least one test user.
- [ ] `station.providers.google.register({ ... })` returned `{ ok: true }`.
- [ ] `renewExpiringChannels()` scheduled.
