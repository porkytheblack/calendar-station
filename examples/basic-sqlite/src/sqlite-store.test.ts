import { runStoreConformance } from "calendar-station-conformance"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteStore } from "./sqlite-store.js"

// Verifies the example's adapter satisfies the published contract.
// Adapter authors do this against their own Store via this same suite.
runStoreConformance({
  name: "examples/basic-sqlite",
  makeStore: async () => {
    const dir = mkdtempSync(join(tmpdir(), "calendar-station-"))
    const store = createSqliteStore(join(dir, "test.db"))
    return {
      store,
      teardown: async () => {
        store.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
