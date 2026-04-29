import { err } from "./result.js"
import type { Result } from "./result.js"

/**
 * Wrap an adapter-supplied Promise<Result<T, E>> so that uncaught throws or
 * rejected promises are coerced into a `{ _tag: "Transient" }` error. Backstop
 * for buggy implementations — the documented path is explicit `err(...)`.
 */
export const safeCall = async <T, E extends { readonly _tag: string }>(
  fn: () => Promise<Result<T, E>>,
  asTransient: (message: string, cause: unknown) => E,
): Promise<Result<T, E>> => {
  try {
    const r = await fn()
    if (r && typeof r === "object" && "ok" in r) return r
    return err(asTransient("adapter returned non-Result value", r))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return err(asTransient(message, cause))
  }
}

export const transientStoreError = (message: string, cause: unknown) =>
  ({ _tag: "Transient", message, cause }) as const

export const transientHandlerError = (message: string, cause: unknown) =>
  ({ _tag: "Transient", message, cause }) as const

export const transientResolverError = (message: string, cause: unknown) =>
  ({ _tag: "ProviderTransient", message, cause }) as const
