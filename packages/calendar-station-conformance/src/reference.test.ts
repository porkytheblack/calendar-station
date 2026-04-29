import { runStoreConformance } from "./index.js"
import { createReferenceStore } from "./reference-store.js"

// Meta-test: the reference Store must pass the full battery. Proves both
// the suite catches violations and the reference impl is correct.
runStoreConformance({
  name: "in-memory reference store",
  makeStore: async () => ({
    store: createReferenceStore(),
    teardown: async () => {},
  }),
})
