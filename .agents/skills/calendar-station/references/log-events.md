# Log events

Stable log event names are part of the public contract. They will not be renamed without a major version bump. Wire dashboards, alerts, and SLO definitions against these names.

## Account lifecycle

| Event | Level | When |
|---|---|---|
| `account.registered` | info | After successful `register` (validate + seed list + watch + persist all succeeded) |
| `account.channel_renewed` | info | After successful `events.watch` re-call during `renewExpiringChannels` |
| `account.revoked` | error | Resolver got `CredentialsRevoked`, OR renewal got `CredentialsRevoked`; account moved to `status="revoked"` |
| `account.revoked_persist_failed` | error | The revoke transition couldn't be written to the Store (alarm) |

## Pipeline / event ingress

| Event | Level | When |
|---|---|---|
| `event.received` | debug | Webhook decoded into a `CalendarChangeEvent` and handed to the pipeline |
| `event.committed` | info | Atomic commit succeeded (`eventsInserted`, `accountId` fields on log entry) |
| `event.dropped` | warn / error | Pipeline acked an event without committing (resolver returned a deterministic error). `reason` field tells you which: `malformed`, `account_not_found`, `account_paused`, `account_revoked`, `channel_token_mismatch`, `calendar_gone`, `provider_transient`, `provider_permanent`, `store_transient`, `store_permanent`, `store_account_not_found`, `store_duplicate` |
| `event.sync_handshake` | debug | `resource_state=sync` — channel-creation handshake |
| `event.sync_token_gone` | warn | syncToken expired (410 GONE); resolver re-paginates without it; no synthetic events emitted for the gap |

## Trigger worker

| Event | Level | When |
|---|---|---|
| `trigger.claimed` | debug | A pending job was claimed by this worker |
| `trigger.succeeded` | info | Handler returned `ok(undefined)`, marked done |
| `trigger.failed` | warn | Handler returned `err(...)`, will retry |
| `trigger.dead_lettered` | error | `attempts === maxAttempts` and last result was Transient — terminal failure (alarm) |
| `trigger.claim_failed` | warn | `claimTriggerJobs` returned an error (Store-level) |
| `trigger.done_persist_failed` | error | `markTriggerDone` failed (alarm — handler succeeded but state didn't advance) |
| `trigger.fail_persist_failed` | error | `markTriggerFailed` failed (alarm — same severity) |
| `trigger.unexpected_error` | error | Uncaught throw inside the worker loop |

## Google provider — webhook ingress

| Event | Level | When |
|---|---|---|
| `ingress.started` | info | `station.start()` finished setting up the provider runtime; logs the registered webhook URL and ingress mode |
| `webhook.decode_failed` | warn | Required X-Goog-* header missing; returned 400 |
| `webhook.token_mismatch` | warn | `X-Goog-Channel-Token` didn't match `HMAC(channelTokenSecret, channelId)`; returned 401 |
| `webhook.unknown_channel` | warn | Channel id has no corresponding account; returned 200 to stop Google retrying |
| `webhook.account_lookup_failed` | error | Store returned a non-AccountNotFound error during lookup; returned 503 |
| `webhook.sync_handshake` | debug | `resource_state=sync` — channel handshake; acked |
| `webhook.calendar_deleted` | warn | `resource_state=not_exists` received; the calendar was deleted |
| `webhook.channel_stop_failed` | warn | `channels.stop` failed during the not_exists handler (best-effort) |
| `webhook.commit_timeout` | warn | Pipeline didn't return within `commitTimeoutMs`; returned 503 |
| `webhook.deferred_failed` | error | Deferred-mode pipeline call rejected (in-process; no retry) |

## Google provider — channel renewal

| Event | Level | When |
|---|---|---|
| `watch.renew_list_failed` | warn | `listAccountsExpiringChannel` failed during renewal cron |
| `watch.compensating_stop_failed` | warn | After register-side compensation, a `channels.stop` cleanup call failed |
| `watch.old_channel_stop_failed` | warn | Best-effort `channels.stop` on the old channel after a successful swap failed; the 7-day TTL is the backstop |

## Google provider — message resolution

| Event | Level | When |
|---|---|---|
| `oauth.writeback_failed` | warn | Refresh-token writeback to Store failed (best-effort; next call refreshes again) |

## Worker process-level

| Event | Level | When |
|---|---|---|
| `worker.crashed` | error | The worker loop itself crashed (alarm) |

## What to alarm on

Bare minimum:

- `trigger.dead_lettered` — handler-level data loss
- `trigger.done_persist_failed` / `trigger.fail_persist_failed` — Store-level data loss
- `account.revoked_persist_failed` — state transition lost
- `worker.crashed` — pipeline silently dead
- `event.dropped` with `reason="store_permanent"` — broken DB
- `webhook.account_lookup_failed` (sustained) — Store unavailability under webhook load

Useful to dashboard but not alarm:

- `webhook.token_mismatch` — non-zero rate suggests a misconfigured deploy or a probe; should normally be zero
- `event.sync_token_gone` — should be rare; sustained rate suggests the worker is offline too long for the retention window
- `account.revoked` — expected but worth tracking (drives reconnect-CTA UX)

## What's intentionally NOT logged

- Per-event handler invocation start (would be one log per event — too noisy; use `trigger.claimed` if you really want this signal)
- Successful OAuth refreshes (only failures via `oauth.writeback_failed`)
- `events.list` page boundaries (one log per page would be too noisy on first-seed of large calendars)
- 200 responses on the webhook itself (the disposition is implied by `event.committed` vs `event.dropped`)
