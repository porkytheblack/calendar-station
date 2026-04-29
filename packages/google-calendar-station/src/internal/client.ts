import { calendar, type calendar_v3 } from "@googleapis/calendar"
import { OAuth2Client } from "google-auth-library"
import { err, ok } from "calendar-station"
import type { ResolverError, Result } from "calendar-station"
import type {
  GoogleCalendarClient,
  GoogleCalendarClientFactory,
  ResolvedGoogleCalendarConfig,
} from "./types.js"

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const REQUEST_RETRY_DELAYS_MS = [200, 1_000, 5_000]

type SdkErrorLike = {
  code?: number | string
  status?: number
  response?: { status?: number; data?: unknown }
  message?: string
}

const numericStatus = (e: SdkErrorLike): number | undefined => {
  if (typeof e.code === "number") return e.code
  if (typeof e.code === "string" && /^\d+$/.test(e.code)) return Number(e.code)
  if (typeof e.status === "number") return e.status
  if (e.response?.status) return e.response.status
  return undefined
}

const isInvalidGrant = (e: unknown): boolean => {
  if (!e || typeof e !== "object") return false
  const anyE = e as { message?: unknown; response?: { data?: { error?: unknown } } }
  if (typeof anyE.message === "string" && anyE.message.includes("invalid_grant")) return true
  const errVal = anyE.response?.data?.error
  if (typeof errVal === "string" && errVal === "invalid_grant") return true
  return false
}

export const classify = (e: unknown): ResolverError => {
  const sdk = (e ?? {}) as SdkErrorLike
  if (isInvalidGrant(e)) {
    return {
      _tag: "CredentialsRevoked",
      accountId: undefined as unknown as never,
      reason: sdk.message ?? "invalid_grant",
    }
  }
  const status = numericStatus(sdk)
  const message = sdk.message ?? "google calendar request failed"
  if (status && status >= 500)
    return { _tag: "ProviderTransient", message, statusCode: status, cause: e }
  if (status === 429)
    return { _tag: "ProviderTransient", message, statusCode: status, cause: e }
  if (status && status >= 400)
    return { _tag: "ProviderPermanent", message, statusCode: status, cause: e }
  return { _tag: "ProviderTransient", message, cause: e }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const retrying = async <T>(thunk: () => Promise<T>): Promise<T> => {
  let lastErr: unknown
  for (let attempt = 0; attempt <= REQUEST_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await thunk()
    } catch (e) {
      lastErr = e
      const sdk = (e ?? {}) as SdkErrorLike
      const status = numericStatus(sdk)
      const retryable = status === undefined || RETRYABLE_STATUS.has(status)
      if (!retryable || attempt === REQUEST_RETRY_DELAYS_MS.length) throw e
      await sleep(REQUEST_RETRY_DELAYS_MS[attempt]!)
    }
  }
  throw lastErr
}

/**
 * Production client factory. Uses `@googleapis/calendar` + `google-auth-library`.
 * Each call constructs a fresh OAuth2Client from the account's credentials,
 * subscribes to the `tokens` event for fire-and-forget writeback, returns a
 * Calendar client.
 */
export const defaultGoogleCalendarClientFactory: GoogleCalendarClientFactory = (
  creds,
  options,
): GoogleCalendarClient => {
  const { config, onTokenRefresh } = options

  const buildAuth = (): OAuth2Client => {
    const auth = new OAuth2Client({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
    })
    auth.setCredentials({
      refresh_token: creds.refreshToken,
      access_token: creds.accessToken,
      expiry_date: creds.accessTokenExpiresAt?.getTime(),
    })
    auth.on("tokens", (t) => {
      if (!t.access_token) return
      onTokenRefresh({
        refreshToken: creds.refreshToken,
        accessToken: t.access_token,
        accessTokenExpiresAt: t.expiry_date ? new Date(t.expiry_date) : undefined,
      })
    })
    return auth
  }

  const client = (): calendar_v3.Calendar => calendar({ version: "v3", auth: buildAuth() })

  return {
    validateRefreshToken: async () => {
      try {
        const auth = buildAuth()
        await retrying(() => auth.getAccessToken().then(() => undefined))
        return ok(undefined)
      } catch (e) {
        return err(classify(e))
      }
    },
    eventsList: async ({ calendarId, syncToken, pageToken, maxResults }) => {
      try {
        const params: calendar_v3.Params$Resource$Events$List = {
          calendarId,
          maxResults: maxResults ?? 250,
          singleEvents: false,
          showDeleted: true,
        }
        if (syncToken) params.syncToken = syncToken
        if (pageToken) params.pageToken = pageToken
        const res = await retrying(() => client().events.list(params))
        return ok({
          items: res.data.items ?? [],
          nextPageToken: res.data.nextPageToken ?? undefined,
          nextSyncToken: res.data.nextSyncToken ?? undefined,
        })
      } catch (e) {
        const status = numericStatus((e ?? {}) as SdkErrorLike)
        if (status === 410) return err({ _tag: "SyncTokenGone" } as const)
        return err(classify(e))
      }
    },
    watch: async ({ calendarId, channelId, address, token, ttlMs }) => {
      try {
        const expirationMs = Date.now() + ttlMs
        const res = await retrying(() =>
          client().events.watch({
            calendarId,
            requestBody: {
              id: channelId,
              type: "web_hook",
              address,
              token,
              expiration: String(expirationMs),
            },
          }),
        )
        const resourceId = res.data.resourceId ?? ""
        const expRaw = res.data.expiration
        const expMs = expRaw ? Number(expRaw) : expirationMs
        if (!resourceId) {
          return err({
            _tag: "ProviderPermanent",
            message: "events.watch returned no resourceId",
          })
        }
        return ok({ resourceId, expiration: new Date(expMs) })
      } catch (e) {
        return err(classify(e))
      }
    },
    stop: async ({ channelId, resourceId }) => {
      try {
        await retrying(() =>
          client().channels.stop({ requestBody: { id: channelId, resourceId } }),
        )
        return ok(undefined)
      } catch (e) {
        // 404 means the channel is already gone; treat as success.
        const status = numericStatus((e ?? {}) as SdkErrorLike)
        if (status === 404) return ok(undefined)
        return err(classify(e))
      }
    },
  }
}

export const _client_internals = { classify, isInvalidGrant, RETRYABLE_STATUS }
