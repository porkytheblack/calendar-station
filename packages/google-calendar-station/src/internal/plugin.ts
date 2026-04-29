import type {
  ProviderBuildDeps,
  ProviderFactory,
  ProviderRuntime,
} from "calendar-station"
import { startIngress } from "./ingress.js"
import { createGoogleCalendarResolver } from "./resolver.js"
import { createWatchManager } from "./watch.js"
import type {
  GoogleCalendarConfig,
  GoogleCalendarProviderApi,
  ResolvedGoogleCalendarConfig,
} from "./types.js"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

const resolveConfig = (input: GoogleCalendarConfig): ResolvedGoogleCalendarConfig => ({
  googleClientId: input.googleClientId,
  googleClientSecret: input.googleClientSecret,
  webhookBaseUrl: input.webhookBaseUrl,
  webhookPath: input.webhookPath,
  channelTokenSecret: input.channelTokenSecret,
  channelTtlMs: input.channelTtlMs ?? SEVEN_DAYS_MS,
  renewalWindowMs: input.renewalWindowMs ?? ONE_DAY_MS,
  listPageSize: input.listPageSize ?? 250,
  listConcurrency: input.listConcurrency ?? 4,
  ingressMode: input.ingressMode ?? "sync",
  commitTimeoutMs: input.commitTimeoutMs ?? 8_000,
  ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
})

export const googleCalendarProvider = (
  input: GoogleCalendarConfig,
): ProviderFactory<GoogleCalendarProviderApi> => ({
  build: (deps: ProviderBuildDeps): ProviderRuntime & { api: GoogleCalendarProviderApi } => {
    const config = resolveConfig(input)
    const runtimeDeps = { ...deps, config }
    const resolver = createGoogleCalendarResolver(runtimeDeps)
    const watchManager = createWatchManager(runtimeDeps)
    const ingress = startIngress(runtimeDeps)

    const api: GoogleCalendarProviderApi = {
      register: watchManager.register,
      renewExpiringChannels: watchManager.renewExpiringChannels,
      handleWebhook: ingress.handle,
    }

    return {
      resolver,
      api,
      start: () => ingress.start(),
      stop: () => ingress.stop(),
      wait: () => ingress.wait(),
    }
  },
})
