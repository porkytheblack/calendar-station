import { resolveWorkerConfig } from "./config.js"
import { consoleLogger } from "./logger.js"
import { createPipeline } from "./pipeline.js"
import { startWorker } from "./worker.js"
import type {
  CalendarEventHandlerFn,
  CalendarPipeline,
  ProviderBuildDeps,
  ProviderFactory,
  StationLogger,
  StoreAdapter,
  WorkerConfig,
} from "./types.js"

export type StationInput<P extends Record<string, ProviderFactory>> = {
  readonly store: StoreAdapter
  readonly handler: CalendarEventHandlerFn
  readonly config?: WorkerConfig
  readonly providers: P
  readonly logger?: StationLogger
}

export type ProviderApis<P extends Record<string, ProviderFactory>> = {
  [K in keyof P]: P[K] extends ProviderFactory<infer A> ? A : never
}

export type Station<P extends Record<string, ProviderFactory>> = {
  start(): Promise<void>
  stop(): Promise<void>
  wait(): Promise<void>
  readonly providers: ProviderApis<P>
  readonly pipeline: CalendarPipeline
}

export const createStation = <P extends Record<string, ProviderFactory>>(
  input: StationInput<P>,
): Station<P> => {
  const logger = input.logger ?? consoleLogger
  const workerConfig = resolveWorkerConfig(input.config)

  let pipeline: CalendarPipeline | null = null
  const built: Record<string, ReturnType<ProviderFactory["build"]>> = {}
  const apis: Record<string, unknown> = {}

  const providerKeys = Object.keys(input.providers) as Array<keyof P & string>
  if (providerKeys.length === 0) {
    throw new Error("createStation: at least one provider is required")
  }
  if (providerKeys.length > 1) {
    throw new Error(
      "createStation: v1 supports a single provider; multi-provider routing is v2",
    )
  }

  const providerKey = providerKeys[0]!
  const factory = input.providers[providerKey]
  if (!factory) {
    throw new Error(`createStation: missing provider '${providerKey}'`)
  }

  // Forwarding pipeline: lets the provider's ingress hand events back to a
  // pipeline that's constructed *after* the provider runtime is built.
  const forwardingPipeline: CalendarPipeline = {
    processEvent: async (event) => {
      if (!pipeline) throw new Error("station.start has not been called")
      return pipeline.processEvent(event)
    },
  }

  const buildDeps: ProviderBuildDeps = {
    store: input.store,
    pipeline: forwardingPipeline,
    logger,
    clock: workerConfig.clock,
  }

  const providerRuntime = factory.build(buildDeps)
  built[providerKey] = providerRuntime
  apis[providerKey] = providerRuntime.api

  pipeline = createPipeline({
    store: input.store,
    resolver: providerRuntime.resolver,
    logger,
    clock: workerConfig.clock,
  })

  let worker: ReturnType<typeof startWorker> | null = null
  let started = false
  let stopping = false
  let waitDone: Promise<void> | null = null

  const start = async (): Promise<void> => {
    if (started) return
    started = true
    worker = startWorker({
      store: input.store,
      handler: input.handler,
      config: workerConfig,
      logger,
    })
    for (const key of providerKeys) {
      const rt = built[key]
      if (rt) await rt.start()
    }
    waitDone = (async () => {
      await Promise.all([
        worker.done,
        ...providerKeys.map((k) => built[k]?.wait() ?? Promise.resolve()),
      ])
    })()
  }

  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    for (const key of providerKeys) {
      const rt = built[key]
      if (rt) await rt.stop()
    }
    worker?.stop()
    if (waitDone) await waitDone
  }

  const wait = async (): Promise<void> => {
    if (!waitDone) return
    await waitDone
  }

  return {
    start,
    stop,
    wait,
    providers: apis as ProviderApis<P>,
    pipeline: forwardingPipeline,
  }
}
