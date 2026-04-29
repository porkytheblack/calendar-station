import { afterEach, describe } from "vitest"
import type { StoreAdapter } from "calendar-station"
import { accountLifecycleTests } from "./tests/account-lifecycle.js"
import { commitEventsTests } from "./tests/commit-events.js"
import { triggerClaimTests } from "./tests/trigger-claim.js"
import { triggerTransitionTests } from "./tests/trigger-transitions.js"

export { createReferenceStore } from "./reference-store.js"
export type { ReferenceStore } from "./reference-store.js"
export { synthEvent, aUserId, anAccountId, anEventId, aChannelId, aSyncToken } from "./fixtures.js"

export type ConformanceInput = {
  readonly name: string
  readonly makeStore: () => Promise<{
    store: StoreAdapter
    teardown?: () => Promise<void>
  }>
}

/**
 * Run the conformance battery against a Store implementation.
 * Calls Vitest `describe`/`it` internally — invoke from a `*.test.ts` file.
 *
 * `makeStore` is invoked fresh per test (default isolation), so adapter authors
 * can use `:memory:` databases or per-test schemas.
 */
export const runStoreConformance = (input: ConformanceInput): void => {
  let active: { store: StoreAdapter; teardown?: () => Promise<void> } | null = null

  const fresh = async (): Promise<StoreAdapter> => {
    active = await input.makeStore()
    return active.store
  }

  describe(`store conformance: ${input.name}`, () => {
    afterEach(async () => {
      if (active?.teardown) await active.teardown()
      active = null
    })

    accountLifecycleTests(fresh)
    commitEventsTests(fresh)
    triggerClaimTests(fresh)
    triggerTransitionTests(fresh)
  })
}
