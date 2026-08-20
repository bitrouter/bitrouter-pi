import { describe, it, expect } from "vitest";
import { resolveTarget } from "../src/target.js";

describe("resolveTarget", () => {
  it("defaults to local daemon", () => {
    const t = resolveTarget({});
    expect(t).toEqual({ mode: "local", baseUrl: "http://127.0.0.1:4356/v1" });
  });
  it("honors BITROUTER_BASE_URL override for local", () => {
    const t = resolveTarget({ BITROUTER_BASE_URL: "http://127.0.0.1:9999/v1" });
    expect(t.baseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(t.mode).toBe("local");
  });
  it("selects cloud when BITROUTER_TARGET=cloud", () => {
    const t = resolveTarget({ BITROUTER_TARGET: "cloud" });
    expect(t).toEqual({ mode: "cloud", baseUrl: "https://api.bitrouter.ai/v1" });
  });
});
