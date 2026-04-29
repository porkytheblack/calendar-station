import { Brand } from "effect"

export type UserId = string & Brand.Brand<"UserId">
export type CalendarAccountId = string & Brand.Brand<"CalendarAccountId">
export type CalendarEventId = string & Brand.Brand<"CalendarEventId">
export type ChannelId = string & Brand.Brand<"ChannelId">
export type SyncToken = string & Brand.Brand<"SyncToken">
export type JobId = string & Brand.Brand<"JobId">

export const UserId = Brand.nominal<UserId>()
export const CalendarAccountId = Brand.nominal<CalendarAccountId>()
export const CalendarEventId = Brand.nominal<CalendarEventId>()
export const ChannelId = Brand.nominal<ChannelId>()
export const SyncToken = Brand.nominal<SyncToken>()
export const JobId = Brand.nominal<JobId>()

export const newCalendarAccountId = (): CalendarAccountId =>
  CalendarAccountId(crypto.randomUUID())

export const newChannelId = (): ChannelId => ChannelId(crypto.randomUUID())
