import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^calendar-station-conformance$/,
        replacement: here("./packages/calendar-station-conformance/src/index.ts"),
      },
      {
        find: /^calendar-station\/effect$/,
        replacement: here("./packages/calendar-station/src/effect.ts"),
      },
      {
        find: /^calendar-station$/,
        replacement: here("./packages/calendar-station/src/index.ts"),
      },
      {
        find: /^google-calendar-station$/,
        replacement: here("./packages/google-calendar-station/src/index.ts"),
      },
    ],
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "examples/*/src/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 10_000,
  },
})
