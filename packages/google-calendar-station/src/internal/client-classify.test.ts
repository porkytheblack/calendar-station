import { describe, expect, it } from "vitest"
import { _client_internals } from "./client.js"

const { classify, isInvalidGrant } = _client_internals

describe("client classify()", () => {
  it("invalid_grant on the SDK error message → CredentialsRevoked", () => {
    const r = classify(new Error("invalid_grant: ..."))
    expect(r._tag).toBe("CredentialsRevoked")
  })

  it("response.data.error === 'invalid_grant' → CredentialsRevoked", () => {
    const e: any = { message: "Bad Request", response: { data: { error: "invalid_grant" } } }
    const r = classify(e)
    expect(r._tag).toBe("CredentialsRevoked")
  })

  it("5xx → ProviderTransient", () => {
    const r = classify({ code: 503, message: "service unavailable" })
    expect(r._tag).toBe("ProviderTransient")
  })

  it("429 → ProviderTransient", () => {
    const r = classify({ code: 429, message: "rate limited" })
    expect(r._tag).toBe("ProviderTransient")
  })

  it("4xx (non-429) → ProviderPermanent", () => {
    const r = classify({ code: 403, message: "forbidden" })
    expect(r._tag).toBe("ProviderPermanent")
  })

  it("no status → ProviderTransient (network blip)", () => {
    const r = classify(new Error("ECONNRESET"))
    expect(r._tag).toBe("ProviderTransient")
  })

  it("isInvalidGrant accepts both surface forms", () => {
    expect(isInvalidGrant(new Error("invalid_grant"))).toBe(true)
    expect(isInvalidGrant({ response: { data: { error: "invalid_grant" } } })).toBe(true)
    expect(isInvalidGrant({ message: "401" })).toBe(false)
  })
})
