import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDiscoveredModel, withAutoModel, type DiscoveredModel } from "../src/models.js";

/**
 * Regression tests against bodies captured verbatim from both BitRouter data
 * planes, so a future change to the field mapping is caught by the wire and
 * not by a hand-written guess at it.
 *
 * The fixtures are trimmed to the fields this package reads; every value in
 * them is exactly what the endpoint served.
 */
function catalog(name: string): DiscoveredModel[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { data: DiscoveredModel[] }).data;
}

function mapped(name: string) {
  const models = withAutoModel(catalog(name)).map(mapDiscoveredModel);
  return { models, byId: Object.fromEntries(models.map((m) => [m.id, m])) };
}

describe("BitRouter Cloud wire shape", () => {
  it("reads the context window off max_input_tokens", () => {
    const { byId } = mapped("cloud-models");
    // Before this mapping existed the extension read `context_window`, which
    // neither plane sends, so every one of these showed pi's 128K default.
    expect(byId["anthropic/claude-fable-5"].contextWindow).toBe(1_000_000);
    expect(byId["anthropic/claude-haiku-4.5"].contextWindow).toBe(200_000);
    expect(byId["anthropic/claude-opus-4.6"].contextWindow).toBe(200_000);
  });

  it("reads the output cap off max_output_tokens", () => {
    const { byId } = mapped("cloud-models");
    expect(byId["anthropic/claude-fable-5"].maxTokens).toBe(128_000);
    expect(byId["anthropic/claude-haiku-4.5"].maxTokens).toBe(8192);
  });

  it("reads per-million cost off the nested pricing block", () => {
    const { byId } = mapped("cloud-models");
    // Previously read as a flat `cost` object, which cloud never sends — so
    // every model was displayed as free.
    expect(byId["anthropic/claude-fable-5"].cost).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    });
  });

  it("reads reasoning off the capability tokens", () => {
    const { byId } = mapped("cloud-models");
    expect(byId["anthropic/claude-fable-5"].reasoning).toBe(true);
    // Haiku advertises `tools` and not `reasoning`.
    expect(byId["anthropic/claude-haiku-4.5"].reasoning).toBe(false);
  });

  it("leads with the auto route", () => {
    const { models } = mapped("cloud-models");
    expect(models[0].id).toBe("bitrouter/auto");
    expect(models).toHaveLength(4); // three served + auto
  });
});

describe("local daemon wire shape", () => {
  it("falls back to pi's defaults, since the daemon describes nothing", () => {
    const { byId } = mapped("local-models");
    // `{ id, object, providers }` is the whole of what `bitrouter start` serves.
    const m = byId["anthropic/claude-fable-5"];
    expect(m.name).toBe("anthropic/claude-fable-5");
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(4096);
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(["text"]);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("still leads with the auto route", () => {
    expect(mapped("local-models").models[0].id).toBe("bitrouter/auto");
  });
});
