// Effect-typed kernel skin. Wraps the Promise/Result kernel
// (`createStation` in ./station.ts) into Effect-shaped lifecycle and
// pipeline accessors plus an Effect Layer for users with Effect codebases.

import { Context, Effect, Layer } from "effect"
import { createStation } from "./station.js"
import type { Station, StationInput } from "./station.js"
import type {
  CalendarChangeEvent,
  CalendarPipeline,
  ProviderFactory,
} from "./types.js"

export type StationEffect<P extends Record<string, ProviderFactory>> = {
  readonly start: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
  readonly wait: Effect.Effect<void>
  readonly processEvent: (event: CalendarChangeEvent) => Effect.Effect<"ack" | "nack">
  readonly providers: Station<P>["providers"]
  readonly pipeline: CalendarPipeline
}

const lift = <P extends Record<string, ProviderFactory>>(
  station: Station<P>,
): StationEffect<P> => ({
  start: Effect.promise(() => station.start()),
  stop: Effect.promise(() => station.stop()),
  wait: Effect.promise(() => station.wait()),
  processEvent: (event: CalendarChangeEvent) =>
    Effect.promise(() => station.pipeline.processEvent(event)),
  providers: station.providers,
  pipeline: station.pipeline,
})

export const createStationEffect = <P extends Record<string, ProviderFactory>>(
  input: StationInput<P>,
): Effect.Effect<StationEffect<P>> => Effect.sync(() => lift(createStation(input)))

export class StationService extends Context.Tag("calendar-station/StationService")<
  StationService,
  {
    readonly start: Effect.Effect<void>
    readonly stop: Effect.Effect<void>
    readonly wait: Effect.Effect<void>
    readonly processEvent: (event: CalendarChangeEvent) => Effect.Effect<"ack" | "nack">
    readonly providers: Record<string, unknown>
  }
>() {}

export const stationLayer = <P extends Record<string, ProviderFactory>>(
  input: StationInput<P>,
): Layer.Layer<StationService> =>
  Layer.scoped(
    StationService,
    Effect.gen(function* () {
      const station = createStation(input)
      yield* Effect.addFinalizer(() => Effect.promise(() => station.stop()))
      const lifted = lift(station)
      return {
        start: lifted.start,
        stop: lifted.stop,
        wait: lifted.wait,
        processEvent: lifted.processEvent,
        providers: station.providers as Record<string, unknown>,
      }
    }),
  )
