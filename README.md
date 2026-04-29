# calendar-station

Provider-agnostic calendar-watch system. Two published npm packages plus a conformance test battery, all in a single pnpm workspace.

- **`calendar-station`** — provider-agnostic core: outbox commit, trigger worker, Store interface, handler interface. Promise + `Result` API by default; `/effect` subpath for Effect-TS users.
- **`google-calendar-station`** — Google Calendar provider. Wraps `@googleapis/calendar`, OAuth2 refresh, the `events.watch` channel lifecycle, the webhook ingress, and a pure event parser.
- **`calendar-station-conformance`** — Vitest-driven test battery for verifying user-supplied Store implementations against the documented invariants.

Sibling to [`mail-station`](https://github.com/porkytheblack/mail-station). Same architecture (commit-then-trigger pipeline, branded ids, tagged errors, lease-based outbox), different upstream — webhooks instead of Pub/Sub, `syncToken` instead of `historyId`, calendar events instead of mail messages.

## Workspace layout

```
calendar-station/
├── packages/
│   ├── calendar-station/                # core
│   ├── google-calendar-station/         # Google Calendar provider
│   └── calendar-station-conformance/    # store conformance suite
├── examples/
│   └── basic-sqlite/                    # runnable smoke + sqlite Store adapter
├── guides/
│   └── google-oauth-setup.md            # operator-facing OAuth walkthrough
└── .claude/skills/calendar-station/     # Claude Agent skill (ships in npm tarballs)
```

## Claude Agent skill

The repo ships a [Claude Agent skill](./.claude/skills/calendar-station/SKILL.md) that teaches other agents how to integrate the stack — API surface, store contract, error tags, log events, OAuth setup, webhook mounting, paste-ready templates. The same skill is bundled inside the published `calendar-station` and `google-calendar-station` npm tarballs (under `.claude/skills/calendar-station/`), so an agent that installs either package finds it locally without an extra fetch.

The canonical copy lives at the repo root; each publishable package's `prepack` script syncs it into the package directory at pack time via `scripts/sync-skill.mjs`. To validate locally:

```sh
cd packages/calendar-station && pnpm pack         # builds calendar-station-<version>.tgz
tar -tzf calendar-station-*.tgz | grep .claude     # should list 16 files
```

## Develop

```sh
pnpm install
pnpm typecheck     # tsc -b
pnpm test          # vitest across all packages + examples
```

## Setting up Google OAuth

Before you can register a calendar, you need a Google Cloud project with the Calendar API enabled, an OAuth 2.0 Client ID, and a refresh token for the user whose calendar you want to watch. See [`guides/google-oauth-setup.md`](./guides/google-oauth-setup.md) for the full walkthrough — required scopes (`calendar.readonly`), webhook HTTPS requirements, channel-token-secret generation, and a copy-pasteable refresh-token script.

## Quickstart

```ts
import { createServer } from "node:http"
import { createStation, ok, UserId } from "calendar-station"
import { googleCalendarProvider } from "google-calendar-station"
import { createSqliteStore } from "./sqlite-store.js"

const station = createStation({
  store: createSqliteStore("./calendar.db"),
  handler: async (event) => {
    console.log(event.summary, event.status, event.start.dateTime)
    return ok(undefined)
  },
  providers: {
    google: googleCalendarProvider({
      googleClientId:     process.env.GOOGLE_CLIENT_ID!,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      webhookBaseUrl:     "https://api.example.com",
      webhookPath:        "/webhooks/calendar",
      channelTokenSecret: process.env.CHANNEL_TOKEN_SECRET!,
    }),
  },
})

await station.start()

// Mount the framework-agnostic webhook handler in your HTTP server.
createServer(async (req, res) => {
  const r = await station.providers.google.handleWebhook({ headers: req.headers })
  res.statusCode = r.status
  res.end(r.body ?? "")
}).listen(3000)

await station.providers.google.register({
  userId:     UserId("user-1"),
  calendarId: "primary",
  refreshToken: "<from your OAuth flow>",
})

// Daily-ish: extend channels before they expire (~7 days).
setInterval(
  () => void station.providers.google.renewExpiringChannels(),
  60 * 60_000,
)

process.on("SIGTERM", () => void station.stop())
await station.wait()
```

## What's implemented

- Promise + `Result` API and `/effect` subpath sharing the same kernel.
- 10-method `StoreAdapter` interface with documented invariants (atomic commit, idempotency on `(accountId, eventId)`, lease-based claims, channel-id index).
- Trigger worker with bounded concurrency, configurable backoff (defaults: `30s, 1m, 2m, 4m, 5m, …` capped at 5 min, ±25% jitter), max attempts, dead-lettering.
- Tagged-error pipeline with deterministic ack/nack mapping.
- Stable log event names (`account.registered`, `event.committed`, `account.channel_renewed`, `trigger.dead_lettered`, …).
- Branded IDs (`UserId`, `CalendarAccountId`, `CalendarEventId`, `ChannelId`, `SyncToken`, `JobId`).
- Google Calendar provider: `events.watch` register + `renewExpiringChannels`, `events.list?syncToken=…` paginated drain, 410-recovery resync, parser that normalizes attendees / recurrence / conferences, webhook ingress with HMAC-derived per-channel tokens, sync- or deferred-mode pipeline dispatch, OAuth2 refresh + token writeback.
- Conformance battery covering account lifecycle (including channel rotation), atomic+idempotent commit, claim semantics under lease, state transitions. A meta-test runs the suite against an in-memory reference Store to prove both the suite and the reference are correct.
- An example SQLite Store adapter that passes the conformance suite end-to-end.

## Out of scope (v1)

- Calendar mutation (creating/updating/deleting events) — read-only watch + list + parse.
- OAuth UX inside the provider — consumer handles consent flow and provides the refresh token.
- Recurring event expansion — the package emits change events for the recurring row plus any explicit overrides Google sends; expanding the RRULE is a downstream concern.
- Free/busy queries, ACL changes, calendar list discovery — single-calendar-per-account focus.
- Cron scheduling for renewal — the renewal effect is exposed, the user wires it into their scheduler.
- TLS/cert provisioning for the webhook endpoint — infra concern.
- Pub/Sub push delivery (Google supports it as an alternative; webhook-only for v1).
- Domain-wide delegation — per-user OAuth only.
