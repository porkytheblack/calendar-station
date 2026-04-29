# Google OAuth setup (operator's reference)

What an operator must do in Google Cloud before `register()` can succeed. Mirrors `guides/google-oauth-setup.md` in the repo; this file is the agent-friendly summary. Send users to the repo guide for the long form.

## Required scope

```
https://www.googleapis.com/auth/calendar.readonly
```

That's the only scope `google-calendar-station` v1 needs. Permits `events.list`, `events.watch`, `channels.stop`. Don't request `calendar` (read/write) unless the consumer's own UI needs it; the smaller scope sails through verification.

## Cloud setup steps

1. **Pick / create a Google Cloud project.** Can be shared with `gmail-station` if the consumer also uses that.
2. **Enable the Calendar API** (`calendar-json.googleapis.com`). Console → APIs & Services → Library → search "Google Calendar API" → Enable. **No Pub/Sub needed** — Calendar uses webhooks.
3. **Configure the OAuth consent screen** with the `calendar.readonly` scope. External vs Internal as appropriate. Add test users while in Testing publishing status.
4. **Create an OAuth 2.0 Client ID** of type *Web application*. Add authorized redirect URIs:
   - `http://localhost:53682` (or whatever the local one-shot script uses)
   - `https://api.example.com/oauth/google/callback` (production)
5. Copy `client_id` + `client_secret`; set as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Webhook endpoint requirements

- **HTTPS only.** Google rejects `http://` URLs.
- **CA-signed certificate.** Self-signed certs are rejected.
- **Public DNS hostname.** No raw IPs.
- **Reachable from Google's network.** Behind a corporate VPN won't work.

For local development, tunnel via:

- **ngrok** — works; the free tier rotates the URL on every restart, which is annoying since the channel embeds the URL. Pin a reserved domain or upgrade.
- **cloudflared** — free, stable URLs.

## `channelTokenSecret`

The HMAC secret used to derive `X-Goog-Channel-Token` from each channel id. Server-side only; never sent to clients. Generate:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Don't reuse it across environments** (dev / staging / prod each get their own). **Don't rotate without re-registering accounts** — you'll see a flood of `webhook.token_mismatch` 401s on the next inbound notifications, since the channels Google has on file were registered with the old secret.

## Getting a refresh token (one-shot CLI for testing)

```ts
import { OAuth2Client } from "google-auth-library"
import { createServer } from "node:http"

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

createServer(async (req, res) => {
  const code = new URL(req.url!, REDIRECT).searchParams.get("code")
  if (!code) { res.statusCode = 400; res.end("missing code"); return }
  res.end("done — check your terminal")
  const { tokens } = await client.getToken(code)
  console.log("\nrefresh_token:", tokens.refresh_token)
  process.exit(0)
}).listen(53682)
```

The two flags that trip people up:

- `access_type: "offline"` — without this, Google returns only a short-lived access token, no refresh token.
- `prompt: "consent"` — by default, if the user has already granted access for these scopes, Google **omits** the refresh token from the response. Forcing `prompt=consent` makes it return a fresh one every time.

## Production OAuth flow (server-side)

The package does NOT implement the consent UX. The consumer's app handles it. Shape:

1. Redirect user to `client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/calendar.readonly"], state })`.
2. On callback, exchange `code` for tokens via `client.getToken(code)`.
3. Persist `tokens.refresh_token` in the consumer's user-account table (encrypted at rest).
4. Call `station.providers.google.register({ userId, calendarId, refreshToken })`.

If the user revokes via <https://myaccount.google.com/permissions>, the next call returns `CredentialsRevoked` and `google-calendar-station` flips the account to `status: "revoked"` automatically. Surface a "reconnect" CTA.

## Picking a `calendarId`

`register({ calendarId })` accepts:

- `"primary"` — the user's main calendar. Most apps want this.
- A specific calendar id, e.g. `"abc123@group.calendar.google.com"`. Enumerate via `calendar.calendarList.list` (under the same `calendar.readonly` scope), or paste from the Calendar UI's "Settings and sharing" page for the calendar.

Each registration watches **one** calendar. To watch multiple, register separately — each gets its own `CalendarAccount`.

## Verification

When the consumer goes to publish, Google's standard OAuth verification applies. `calendar.readonly` is **not** sensitive or restricted, so:

- No security assessment / annual review (unlike Gmail's `gmail.readonly`).
- Standard verification is straightforward — submit the consent screen + a homepage + a privacy policy.

## Common mistakes

| Symptom | Fix |
|---|---|
| `register()` returns `InvalidGrant` | Refresh token revoked or wrong client secret. Re-run the OAuth flow with `prompt: "consent"`. |
| `events.watch` 400 "address must use HTTPS" | Webhook URL is `http://` or has an invalid cert. Fix TLS / use a real-cert tunnel. |
| `events.watch` 400 "Invalid channel id" | UUID clash with an existing live channel. The package allocates a new UUID per call, so this only happens if you're calling watch yourself outside the package. |
| Webhooks never arrive | Verify the URL is reachable from public internet. Look for the `sync`-resource-state POST in your logs immediately after `register()` — that's Google's handshake. |
| `webhook.token_mismatch` log on every request | `channelTokenSecret` was rotated without re-registering accounts. Restore the old secret or re-register. |
| `event.sync_token_gone` log | Worker was offline long enough that the syncToken expired. Package recovers automatically by re-paginating; no action needed. |
| `account.revoked` log fires | User revoked access via Google account permissions UI. Surface a reconnect CTA in the app. |
