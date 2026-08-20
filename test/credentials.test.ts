import { describe, it, expect } from "vitest";
import { extractCloudToken } from "../src/credentials.js";

const base = {
  token_type: "Bearer",
  authorization_server: "https://api.bitrouter.ai",
};

describe("extractCloudToken", () => {
  it("returns the access token when not expired", () => {
    const now = new Date("2026-06-23T00:00:00Z");
    const r = extractCloudToken(
      { ...base, access_token: "tok_123", expires_at: "2026-06-24T00:00:00Z" },
      now,
    );
    expect(r).toEqual({ ok: true, token: "tok_123" });
  });
  it("flags an expired token", () => {
    const now = new Date("2026-06-23T00:00:00Z");
    const r = extractCloudToken(
      { ...base, access_token: "tok_123", expires_at: "2026-06-22T00:00:00Z" },
      now,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expired/i);
  });
  it("rejects a malformed credential", () => {
    const now = new Date("2026-06-23T00:00:00Z");
    const r = extractCloudToken({ nope: true } as unknown as Record<string, unknown>, now);
    expect(r.ok).toBe(false);
  });
});
