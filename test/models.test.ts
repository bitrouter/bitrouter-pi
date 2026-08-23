import { describe, it, expect } from "vitest";
import {
  autoModel,
  hasCapability,
  mapDiscoveredModel,
  providerCount,
  toCost,
  withAutoModel,
  type DiscoveredModel,
} from "../src/models.js";

/**
 * A cloud catalog entry exactly as `GET https://api.bitrouter.ai/v1/models`
 * serves one — nested per-million `pricing`, `max_input_tokens` rather than a
 * `context_window`, capability tokens rather than booleans, and `providers` as
 * a count object.
 */
const CLOUD: DiscoveredModel = {
  id: "anthropic/claude-opus-4.6",
  name: "Anthropic: Claude Opus 4.6",
  max_input_tokens: 200000,
  max_output_tokens: 16384,
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  pricing: {
    input_tokens: { no_cache: 5, cache_read: 0.5, cache_write: 6.25 },
    output_tokens: { text: 25 },
  },
  capabilities: ["reasoning", "structured_outputs", "tools"],
  providers: { total_online: 2 },
};

/** A local-daemon entry: the whole of what `bitrouter start` serves. */
const LOCAL: DiscoveredModel = {
  id: "anthropic/claude-opus-4.6",
  object: "model",
  providers: ["claude-code"],
};

describe("toCost", () => {
  it("flattens BitRouter's nested per-million rates", () => {
    expect(toCost(CLOUD.pricing)).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it("reads an undeclared rate as zero rather than dropping the model", () => {
    expect(toCost(undefined)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("hasCapability / providerCount", () => {
  it("reads capability tokens", () => {
    expect(hasCapability(CLOUD, "reasoning")).toBe(true);
    expect(hasCapability(CLOUD, "web_search")).toBe(false);
    expect(hasCapability(LOCAL, "reasoning")).toBe(false);
  });

  it("counts providers across both plane shapes", () => {
    expect(providerCount(CLOUD)).toBe(2);
    expect(providerCount(LOCAL)).toBe(1);
    expect(providerCount({ id: "x" })).toBeUndefined();
  });
});

describe("mapDiscoveredModel", () => {
  it("maps a cloud entry off the fields cloud actually sends", () => {
    expect(mapDiscoveredModel(CLOUD)).toEqual({
      id: "anthropic/claude-opus-4.6",
      name: "Anthropic: Claude Opus 4.6",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 16384,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      compat: { supportsStore: false, supportsUsageInStreaming: false },
    });
  });

  it("reads reasoning from a capability token, not a boolean", () => {
    expect(mapDiscoveredModel({ ...CLOUD, capabilities: ["tools"] }).reasoning).toBe(false);
    expect(mapDiscoveredModel({ ...CLOUD, capabilities: ["reasoning"] }).reasoning).toBe(true);
  });

  it("falls back to safe defaults for a local entry that describes nothing", () => {
    const m = mapDiscoveredModel(LOCAL);
    expect(m.name).toBe("anthropic/claude-opus-4.6");
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(["text"]);
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(4096);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("infers image input from a capability token", () => {
    const m = mapDiscoveredModel({ id: "x", capabilities: ["image_input"] });
    expect(m.input).toEqual(["text", "image"]);
  });

  it("filters out unsupported modalities, keeping text and image", () => {
    const m = mapDiscoveredModel({
      id: "multimodal-model",
      input_modalities: ["text", "image", "pdf", "audio"],
    });
    expect(m.input).toEqual(["text", "image"]);
  });

  it("falls back to ['text'] when all modalities are unsupported", () => {
    const m = mapDiscoveredModel({ id: "pdf-only-model", input_modalities: ["pdf"] });
    expect(m.input).toEqual(["text"]);
  });
});

describe("withAutoModel", () => {
  it("puts a synthesized auto route at the head of the catalog", () => {
    const out = withAutoModel([CLOUD]);
    expect(out.map((m) => m.id)).toEqual(["bitrouter/auto", "anthropic/claude-opus-4.6"]);
    expect(out[0]).toEqual(autoModel());
  });

  it("offers the auto route even when nothing was discovered", () => {
    expect(withAutoModel([]).map((m) => m.id)).toEqual(["bitrouter/auto"]);
  });

  it("prefers the served entry once BitRouter lists auto itself", () => {
    const served: DiscoveredModel = {
      id: "bitrouter/auto",
      name: "BitRouter Auto",
      max_input_tokens: 1000000,
    };
    const out = withAutoModel([CLOUD, served]);
    expect(out[0]).toBe(served);
    expect(out).toHaveLength(2);
    expect(mapDiscoveredModel(out[0]).contextWindow).toBe(1000000);
  });

  it("never lists the auto route twice", () => {
    const out = withAutoModel([{ id: "bitrouter/auto" }, CLOUD, { id: "bitrouter/auto" }]);
    expect(out.filter((m) => m.id === "bitrouter/auto")).toHaveLength(1);
  });

  it("maps the synthesized entry to a usable pi Model", () => {
    const m = mapDiscoveredModel(autoModel());
    expect(m.id).toBe("bitrouter/auto");
    expect(m.name).toBe("BitRouter Auto");
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(["text", "image"]);
    // The conservative floor, not the ceiling — see the comment on AUTO_CONTEXT.
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(16384);
  });
});
