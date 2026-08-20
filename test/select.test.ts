import { describe, it, expect } from "vitest";
import { selectDefaultModelId } from "../src/select.js";
import type { PiModel } from "../src/models.js";

const model = (id: string): PiModel => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStore: false, supportsUsageInStreaming: false },
});

describe("selectDefaultModelId", () => {
  it("returns undefined when nothing was discovered", () => {
    expect(selectDefaultModelId([])).toBeUndefined();
  });

  it("prefers a capable family over the cheapest listed model", () => {
    const models = [model("deepseek-v3"), model("claude-opus-4-8"), model("gpt-4o")];
    expect(selectDefaultModelId(models)).toBe("claude-opus-4-8");
  });

  it("honors the preference order (opus before sonnet before gpt)", () => {
    const models = [model("gpt-5"), model("claude-sonnet-4-5"), model("claude-opus-4-8")];
    expect(selectDefaultModelId(models)).toBe("claude-opus-4-8");
  });

  it("matches case-insensitively on a substring of the id", () => {
    expect(selectDefaultModelId([model("openai/GPT-5-mini")])).toBe("openai/GPT-5-mini");
  });

  it("falls back to the first model when no preferred family is present", () => {
    const models = [model("mystery-model-1"), model("mystery-model-2")];
    expect(selectDefaultModelId(models)).toBe("mystery-model-1");
  });
});
