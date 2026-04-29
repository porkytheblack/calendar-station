// Effect-typed `/effect` subpath. Re-exports the Effect kernel skin from
// `internal/layer.ts` and the rest of the public API so users on Effect
// can import everything from a single entry point.

export { createStationEffect, StationService, stationLayer } from "./internal/layer.js"
export type { StationEffect } from "./internal/layer.js"

export * from "./index.js"
