import { describe, expect, it } from "vitest"
import { ok, err } from "./result.js"
import { safeCall, transientStoreError } from "./shim.js"

describe("safeCall", () => {
  it("passes through a normal Result", async () => {
    const r = await safeCall(async () => ok(42), transientStoreError)
    expect(r.ok && r.value).toBe(42)
  })

  it("converts thrown errors to Transient", async () => {
    const r = await safeCall(async () => {
      throw new Error("boom")
    }, transientStoreError)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("Transient")
    expect(r.error.message).toBe("boom")
  })

  it("propagates explicit err()", async () => {
    const r = await safeCall(async () => err({ _tag: "Permanent" as const, message: "schema" }), transientStoreError)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error._tag).toBe("Permanent")
  })

  it("converts non-Result return value to Transient", async () => {
    const r = await safeCall(
      async () => "not a result" as unknown as ReturnType<typeof ok>,
      transientStoreError,
    )
    expect(r.ok).toBe(false)
  })
})
