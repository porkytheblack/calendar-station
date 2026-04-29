# Out of scope (v1)

These features are deliberately not in v1. When a user asks for one, refuse politely and tell them the workaround.

## The list

| Feature | Workaround |
|---|---|
| **Creating, updating, deleting events** | Stack is read-only (`events.list` + `events.watch` + `channels.stop`). Use `googleapis.calendar('v3').events.{insert,update,patch,delete}` directly with the same OAuth refresh token you handed to `register()`. |
| **Free/busy queries** | Out of scope — this is a change-notification package, not a query layer. Use `googleapis.calendar('v3').freebusy.query` directly. |
| **ACL changes** (sharing, permissions) | Use `googleapis.calendar('v3').acl.*` directly. |
| **Calendar list discovery** (enumerate user's calendars) | Use `googleapis.calendar('v3').calendarList.list` directly under the same `calendar.readonly` scope. |
| **Recurring event expansion** (materialize each occurrence) | The package emits change events for the recurring row + any explicit instance overrides Google sends. Expand RRULE downstream with `rrule` or `rrule-rust`. Storing every materialized occurrence is a downstream concern — the size of `RRULE:FREQ=DAILY;COUNT=∞` is unbounded. |
| **Push delivery via Pub/Sub** | Calendar supports Pub/Sub as an alternative push channel; webhook-only for v1. |
| **Outlook / Microsoft Graph provider** | Architecture supports it, package is future. Today: google-calendar-station only. |
| **OAuth UX inside the provider** | Every app's auth UX is different. Consumer runs their own flow and provides the refresh token to `register`. See `oauth-setup.md`. |
| **Multiple calendars per account in a single registration** | Register each calendar separately; each gets its own `CalendarAccount` row. |
| **Domain-wide delegation** (Workspace admin acting on behalf of all users) | Per-user OAuth only. |
| **Cron scheduling for renewal** | `renewExpiringChannels()` is exposed as an effect; consumer wires it into their scheduler (system cron, node-cron, GCP Cloud Scheduler, k8s CronJob, BullMQ). See `templates/renewal-cron.ts`. |
| **TLS / cert provisioning for the webhook** | Infra concern; terminate at your load balancer / CDN. |
| **Account deletion API** | No `deleteAccount`. Consumer can delete the row directly in their Store; the kernel never queries deleted accounts. Stop the channel first via the underlying SDK if you want clean up Google-side. |
| **Multi-handler fan-out per event type** | One handler. Fan out internally based on `event.status`, `event.recurrence`, attendee membership, etc. |
| **Lease heartbeating** | Set `leaseDurationMs` to cover your worst-case handler runtime. No mid-handler renewal. |
| **Per-account (per-key) handler serialization** | All in-flight slots are general-purpose. If you need serial-per-account, gate inside the handler with your own lock (Redis, DB advisory lock). |
| **State-change push callbacks** (`onAccountRevoked`, etc.) | React to log events instead — `account.revoked`, `trigger.dead_lettered`. Wire them through your logger. |
| **Retention policies on stored events or jobs** | Adapter author decides. The kernel doesn't prune. |
| **Cross-account batching** | `commitEvents` is single-account. The kernel never batches across accounts. |
| **Metrics SDKs (Prometheus / OpenTelemetry / statsd)** | Use the structured `StationLogger` to emit metrics yourself. The skill's `references/log-events.md` lists the stable event names. |
| **Resolving conferences to actual Meet/Zoom URIs beyond Google's payload** | The package surfaces what Google returns in `ConferenceData`. If a Zoom link is embedded in `description` instead of the conference field, the consumer has to text-extract it. |
| **iCalendar (.ics) parsing** | Different problem. Use `node-ical` or `ical.js` if you need to parse files. |
| **Synthetic events for the syncToken-gone gap** | When the syncToken expires (410), the resolver silently re-aligns and emits no synthetic events for the gap. If you need gap detection, diff the events table before vs after `event.sync_token_gone`. |
| **Webhook signature verification beyond the channel token** | The `X-Goog-Channel-Token` HMAC is the verification — that's how Google does it. There's no additional signature header. |
| **Bulk re-registration after secret rotation** | If `channelTokenSecret` rotates, you have to re-register accounts (new channel id + new token derivation). The package doesn't ship a migration helper. |

## Refusal phrasing template

When a user asks for one of these, lead with the workaround, not the refusal:

> "v1 doesn't include X — consumer responsibility. The way most users handle it is Y." [optional one-line on why it's out of scope: "Every app's auth UX is different" / "The expanded series can be unbounded; let downstream pick the storage model" / etc.]

Don't volunteer to add it to the package — that's a v2 conversation owned by the maintainers.

## Things that *look* out-of-scope but are actually in-scope

- **Watch on a non-primary calendar** — fully supported; pass the calendar id to `register({ calendarId })`.
- **Recurring event status changes** — when a series is edited or cancelled, Google fires a change for the series row; the package emits it. Same for instance overrides.
- **Google Meet / Hangouts links** — `event.conference.entryPoints` and `event.hangoutLink` are populated when present.
- **Attendee response tracking** — `event.attendees[i].responseStatus` is populated; the row re-fires on response changes thanks to upsert + re-enqueue semantics.
- **Cancelled events** — `event.status === "cancelled"` arrives as a normal change event; the handler decides what to do (e.g. tombstone in your downstream).
