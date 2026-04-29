---
name: calendar-station
description: Use when integrating the npm packages `calendar-station` (provider-agnostic calendar-watch core) or `google-calendar-station` (Google Calendar provider). Triggers for: wiring up `createStation`, writing or porting a `StoreAdapter`, building a `CalendarEventHandlerFn`, configuring the Google Calendar provider (OAuth, `events.watch` channel lifecycle, webhook ingress), tuning the trigger worker (concurrency, backoff, dead-letter), interpreting tagged errors, scheduling channel renewal, mounting the webhook handler in HTTP frameworks, or any question of the form "how do I do X with calendar-station / google-calendar-station". Do NOT trigger for: Outlook/Microsoft Graph calendar APIs, raw Google Calendar API usage outside this stack, iCalendar (.ics) parsing, or creating/updating events (the stack is read-only watch + list + parse).
---

# calendar-station skill

Authoritative help for consumers of [`calendar-station`](https://www.npmjs.com/package/calendar-station) and [`google-calendar-station`](https://www.npmjs.com/package/google-calendar-station). Keeps the user inside the stack's public contract — does not invent API surface, does not contradict the design.

Sibling stack to [`mail-station`](https://github.com/porkytheblack/mail-station). Same architecture (commit-then-trigger pipeline, branded ids, tagged errors, lease-based outbox), different upstream — webhooks instead of Pub/Sub, `syncToken` instead of `historyId`, calendar events instead of mail messages.

## How this skill is laid out

This skill uses progressive disclosure. `SKILL.md` (this file) covers the model and how to triage requests. Load a reference file only when the user's question lives there:

- `references/api-surface.md` — every exported symbol from both packages, with real signatures
- `references/store-contract.md` — the 10-method `StoreAdapter`, invariants, atomic-commit pattern
- `references/errors.md` — tagged-error unions, ack/nack mapping, what state changes per tag
- `references/worker-and-backoff.md` — concurrency knobs, default backoff curve, dead-lettering
- `references/google-provider.md` — `GoogleCalendarConfig`, register flow, channel lifecycle, syncToken semantics
- `references/webhook-ingress.md` — mounting `handleWebhook` in Express / Hono / Fastify / node:http / Next.js / Effect HttpServer
- `references/oauth-setup.md` — Google Cloud setup steps (consent screen, scopes, refresh token)
- `references/log-events.md` — every stable log event name
- `references/out-of-scope.md` — v1 punts; what to politely refuse

And ready-to-paste boilerplate in `templates/`:

- `templates/wire-station.ts` — minimal `createStation` setup
- `templates/postgres-store.ts` — skeleton `StoreAdapter` for Postgres with invariant comments
- `templates/renewal-cron.ts` — daily channel renewal scheduling
- `templates/handler-with-tagged-errors.ts` — handler returning `Transient`/`Permanent` correctly
- `templates/webhook-mount-express.ts` — wiring `handleWebhook` into Express
- `templates/webhook-mount-node-http.ts` — wiring `handleWebhook` into raw `node:http`

## Core mental model (always have this loaded)

Two packages, one workspace:

- **`calendar-station`** is the provider-agnostic core. It owns the `StoreAdapter` interface, the trigger worker, the `createStation` factory, the `Result<T,E>` API, and the pipeline. It knows nothing about Google.
- **`google-calendar-station`** is a provider plugin. It supplies a `CalendarChangeResolver` (`events.list?syncToken=…` paginated drain + parse), a webhook ingress (HMAC-derived per-channel tokens, sync- or deferred-mode dispatch), a channel-lifecycle manager (`events.watch` + `renewExpiringChannels`), and an OAuth2 refresh client.

Pipeline shape (provider-agnostic):

```
provider webhook receives a change ping
  → ingress decodes X-Goog-* headers, validates HMAC channel token, looks up account by channel id
  → ingress hands a CalendarChangeEvent to the core pipeline
  → core asks the resolver to resolve the event:
      - events.list?syncToken=<account.syncToken>, paginate
      - parse each event into the provider-neutral CalendarEvent
      - return (events, newSyncToken)
  → core commits atomically: events + syncToken + trigger jobs
  → core acks (HTTP 200) the upstream webhook
  → trigger worker (separate loop): claim → handler → markDone | markFailed
```

The user only sees: `createStation(...)`, register accounts, mount the webhook handler, supply an event handler. Everything else is internal.

## Operating rules

1. **Cross-check before you generate code.** If you cite a function, type, or method, it must be in the actual exports. Open `references/api-surface.md` to confirm — never paraphrase from memory.
2. **Single provider in v1.** `createStation` throws if `providers` has more than one key. If a user asks to register Google Calendar + Outlook in one station, refuse and explain the v1 boundary (multi-provider routing is v2).
3. **All adapter and handler functions return `Promise<Result<T, E>>`.** Don't have user code throw — uncaught throws are caught by the kernel as `{ _tag: "Transient" }`, but that's a backstop, not the primary path.
4. **Atomicity is non-negotiable on `commitEvents`.** It must upsert events + advance `syncToken` + enqueue trigger jobs in a single transaction. If the user is implementing a Store, this is the bug-magnet to call out first. See `references/store-contract.md`.
5. **Calendar events upsert; mail messages insert-only.** Unlike mailbox-station, an event with the same `eventId` arriving twice is a *change* (status flip, attendee response, time edit). The Store must overwrite the payload AND enqueue a fresh trigger job so handlers see the update. This is the single biggest behavioral difference from mail-station — call it out when porting.
6. **Webhook URL must be HTTPS with a CA-signed cert.** Google rejects `events.watch` against `http://`, self-signed certs, or unresolvable hostnames. For local dev, point at an ngrok / cloudflared tunnel.
7. **Channels expire in ~7 days; Google has no renewal API.** The user MUST schedule `renewExpiringChannels()` themselves — daily-ish. The package allocates a fresh channel id, swaps, and stops the old one. See `references/google-provider.md`.
8. **Error tags drive runtime behavior.** `ResolverError._tag = "CredentialsRevoked"` mutates account state to `revoked`; `ResolverError._tag = "CalendarGone"` is logged; `StoreError._tag = "Permanent"` during commit acks (not nacks) to prevent redelivery storms. See `references/errors.md`.
9. **Stable log event names are public contract.** When suggesting how to wire alerts/dashboards, use the names in `references/log-events.md`. Don't invent new ones.
10. **`channelTokenSecret` is per-environment.** It's the HMAC secret used to derive `X-Goog-Channel-Token` from each channel id. Don't reuse it across staging/prod, and don't rotate without re-registering accounts (or you'll see a flood of `webhook.token_mismatch` 401s).

## Common requests — recipe pointer

| User asks | Load |
|---|---|
| "wire up the station" / "minimal setup" | `templates/wire-station.ts` |
| "implement a Store for Postgres / SQLite / Redis" | `references/store-contract.md` + `templates/postgres-store.ts` |
| "schedule channel renewal" / "watch is expiring" | `references/google-provider.md` + `templates/renewal-cron.ts` |
| "how do I handle errors in my handler" | `references/errors.md` + `templates/handler-with-tagged-errors.ts` |
| "what does `event.X` log mean" / "what events fire" | `references/log-events.md` |
| "tune the worker" / "concurrency" / "backoff" / "max attempts" | `references/worker-and-backoff.md` |
| "set up Google OAuth" / "consent screen" / "refresh token" | `references/oauth-setup.md` |
| "mount the webhook in Express / Hono / Fastify / Next" | `references/webhook-ingress.md` + matching template |
| "syncToken expired" / "410 GONE" | `references/google-provider.md` (syncToken semantics section) |
| "how do recurring events work" | `references/google-provider.md` (recurrence section) |
| "create / update / delete events" / "Outlook" / "free-busy" | `references/out-of-scope.md` (refuse politely) |

## Things to refuse politely (v1 boundary)

If the user asks for any of these, explain it's deliberately out of scope for v1. The full list lives in `references/out-of-scope.md`; the most common asks:

- **Creating, updating, or deleting events** — the stack is read-only (`events.list` + `events.watch` + `channels.stop`). Use `@googleapis/calendar` directly.
- **Recurring event expansion** — the package emits change events for the recurring row plus any explicit overrides Google sends. Expand RRULE downstream with `rrule` or `rrule-rust`.
- **Free/busy queries, ACL changes, calendar list discovery** — single-calendar-per-account focus.
- **Outlook / Microsoft Graph** — architecture supports it, package is future work.
- **OAuth UX inside the provider** — consumer brings their own OAuth flow and provides the refresh token.
- **Cron scheduling for renewal** — exposed as `renewExpiringChannels()`, user wires it into their scheduler.
- **TLS/cert provisioning for the webhook endpoint** — infra concern.
- **Pub/Sub push delivery** — Google supports it as an alternative; webhook-only for v1.
- **Domain-wide delegation** — per-user OAuth only.

When refusing, lead with the workaround (e.g. for event creation: "use `googleapis.calendar('v3').events.insert` with the same OAuth refresh token you handed to `register()`").

## Conformance shortcut

When the user is writing a Store adapter, point them at the conformance battery:

```ts
import { describe } from "vitest"
import { runStoreConformance } from "calendar-station-conformance"
import { createMyStore } from "./my-store.js"

describe("my-store", () => {
  runStoreConformance({
    name: "my-store",
    makeStore: async () => ({
      store: createMyStore(),
      teardown: async () => { /* drop schema, close conn, etc. */ },
    }),
  })
})
```

If their adapter passes, it satisfies every invariant the core relies on. The `examples/basic-sqlite` example in the repo is a working reference — passes the full battery (23 tests).

## Provider name string

The provider literal is `"google-calendar"` (not `"google"`). Use this exact string when filtering accounts by provider in custom queries. The `Provider` type is currently `"google-calendar"` (single member); it will widen as more providers ship.

## What changed from mail-station (porter's diff)

If the user is porting from `mail-station`, this is the cheat-sheet:

| `mail-station` | `calendar-station` |
|---|---|
| `MailMessage` | `CalendarEvent` |
| `MailboxAccount` | `CalendarAccount` |
| `MailboxEvent` (Pub/Sub payload) | `CalendarChangeEvent` (webhook headers) |
| `MessageHandlerFn` | `CalendarEventHandlerFn` |
| `lastEventCursor: string \| null` | `syncToken: SyncToken \| null` (branded) |
| `watchExpiresAt` | `channelExpiresAt` |
| `getAccountByEmail(provider, email)` | `getAccountByCalendar(provider, userId, calendarId)` AND `getAccountByChannelId(channelId)` (two lookups) |
| `commitMessages` (insert-only) | `commitEvents` (upsert + re-enqueue) |
| `committedMessageIds` (only newly inserted) | `committedEventIds` (every event in the batch) |
| Pub/Sub pull ingress (`startIngress` + supervised loop) | Webhook ingress (`handleWebhook` HTTP handler) |
| `renewExpiringWatches()` | `renewExpiringChannels()` (also rotates channel id, calls `channels.stop` on the old one) |
| `pubsubTopic` / `pubsubSubscription` config | `webhookBaseUrl` / `webhookPath` / `channelTokenSecret` config |
| `HistoryGone` (404 on `history.list`) | `SyncTokenGone` (410 on `events.list?syncToken=…`) |
| Provider literal `"gmail"` | Provider literal `"google-calendar"` |

The trigger worker, backoff curve, ack/nack pipeline mapping, and Effect `/effect` skin are functionally identical.
