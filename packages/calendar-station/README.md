# calendar-station

Provider-agnostic calendar-watch core. Outbox commit, trigger worker, Store interface, handler interface. Promise + `Result` API by default; `/effect` subpath for Effect-TS users.

```ts
import { createStation, ok, UserId } from "calendar-station"
import { googleCalendarProvider } from "google-calendar-station"

const station = createStation({
  store,                       // your StoreAdapter implementation
  handler: async (event) => {  // your business logic per change
    console.log(event.summary, event.status)
    return ok(undefined)
  },
  providers: { google: googleCalendarProvider({ /* ... */ }) },
})

await station.start()
```

Sibling to [`mailbox-station`](https://www.npmjs.com/package/mailbox-station) — same architecture (commit-then-trigger, branded ids, tagged errors), different upstream. Webhooks instead of Pub/Sub, `syncToken` instead of `historyId`, calendar events instead of mail messages.

Full design and API surface: [github.com/porkytheblack/calendar-station](https://github.com/porkytheblack/calendar-station).
