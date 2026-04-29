// Public Promise + Result API for calendar-station.

export {
  CalendarAccountId,
  CalendarEventId,
  ChannelId,
  JobId,
  SyncToken,
  UserId,
  newCalendarAccountId,
  newChannelId,
} from "./internal/ids.js"

export type {
  CalendarAccountId as CalendarAccountIdType,
  CalendarEventId as CalendarEventIdType,
  ChannelId as ChannelIdType,
  JobId as JobIdType,
  SyncToken as SyncTokenType,
  UserId as UserIdType,
} from "./internal/ids.js"

export { ok, err, isOk, isErr, map, mapErr } from "./internal/result.js"
export type { Result } from "./internal/result.js"

export { defaultBackoff, computeNextAttemptAt, nextAttemptDelayMs } from "./internal/backoff.js"

export { consoleLogger, noopLogger } from "./internal/logger.js"

export { createStation } from "./internal/station.js"
export type { Station, StationInput, ProviderApis } from "./internal/station.js"

export { createPipeline } from "./internal/pipeline.js"
export type { PipelineDeps } from "./internal/pipeline.js"

export { resolveWorkerConfig } from "./internal/config.js"

export type {
  Provider,
  Person,
  ResponseStatus,
  Attendee,
  EventTime,
  EventStatus,
  ConferenceRef,
  CalendarEvent,
  AccountStatus,
  CalendarAccount,
  CalendarChangeEvent,
  TriggerJob,
  TriggerJobState,
  CreateAccountInput,
  AccountPatch,
  CommitEventsInput,
  ClaimTriggerInput,
  ClaimedJob,
  StoreError,
  ResolverError,
  IngressError,
  HandlerError,
  ResolveResult,
  CalendarChangeResolver,
  CalendarEventHandlerFn,
  HandlerContext,
  CalendarPipeline,
  StationLogger,
  StoreAdapter,
  WorkerConfig,
  ResolvedWorkerConfig,
  BackoffConfig,
  ProviderRuntime,
  ProviderFactory,
  ProviderBuildDeps,
} from "./internal/types.js"
