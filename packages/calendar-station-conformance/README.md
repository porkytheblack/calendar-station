# calendar-station-conformance

Vitest-driven conformance battery for verifying user-supplied `StoreAdapter` implementations against the documented invariants in [`calendar-station`](https://www.npmjs.com/package/calendar-station) (atomic commit, idempotency on `(accountId, eventId)`, lease-based claims, state transitions, etc.).

```ts
import { describe } from "vitest"
import { runStoreConformance } from "calendar-station-conformance"
import { createMyStore } from "./my-store.js"

describe("my Store adapter", () => {
  runStoreConformance({
    name: "my-store",
    makeStore: async () => ({
      store: createMyStore(),
      teardown: async () => { /* drop schema, close conn, etc. */ },
    }),
  })
})
```

If your adapter passes, it satisfies every contract `calendar-station` relies on. Full details: [github.com/porkytheblack/calendar-station](https://github.com/porkytheblack/calendar-station).
