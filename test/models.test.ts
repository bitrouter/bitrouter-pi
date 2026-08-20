import { describe, it, expect } from "vitest";
import { mapDiscoveredModel } from "../src/models.js";

describe("mapDiscoveredModel", () => {
  it("maps an enriched entry to a pi Model", () => {
    const m = mapDiscoveredModel({
      id: "claude-opus-4-8",
      object: "model",
      providers: ["anthropic"],
      name: "Claude Opus 4.8",
      reasoning: true,
      input_modalities: ["text", "image"],
      context_window: 200000,
      max_output_tokens: 64000,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    });
    expect(m).toEqual({
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 64000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      compat: { supportsStore: false, supportsUsageInStreaming: false },
    });
  });
  it("falls back to safe defaults when metadata is absent", () => {
    const m = mapDiscoveredModel({ id: "mystery", object: "model", providers: ["x"] });
    expect(m.id).toBe("mystery");
    expect(m.name).toBe("mystery");
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(["text"]);
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(4096);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
  it("filters out unsupported modalities, keeping text and image", () => {
    const m = mapDiscoveredModel({
      id: "multimodal-model",
      input_modalities: ["text", "image", "pdf", "audio"],
    });
    expect(m.input).toEqual(["text", "image"]);
  });
  it("falls back to ['text'] when all modalities are unsupported", () => {
    const m = mapDiscoveredModel({
      id: "pdf-only-model",
      input_modalities: ["pdf"],
    });
    expect(m.input).toEqual(["text"]);
  });
});
