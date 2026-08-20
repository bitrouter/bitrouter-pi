import type { PiModel } from "./models.js";

/**
 * Preference order (case-insensitive substring match on the model id) for the
 * default model the persistent-chat surface selects on session start. Reasoning
 * over a codebase / drafting routing policy is real work, so we prefer a capable
 * model over the cheapest one; the user can always switch with `/model`.
 */
const PREFERRED = [
  "claude-opus",
  "claude-sonnet",
  "gpt-5",
  "gpt-4o",
  "qwen3-coder",
  "glm-5",
  "glm",
  "kimi",
  "deepseek",
];

/**
 * Pick a capable default model id from the discovered set, or `undefined` when
 * nothing was discovered. Falls back to the first model when none of the
 * preferred families are present.
 */
export function selectDefaultModelId(models: PiModel[]): string | undefined {
  if (models.length === 0) return undefined;
  for (const pref of PREFERRED) {
    const hit = models.find((m) => m.id.toLowerCase().includes(pref));
    if (hit) return hit.id;
  }
  return models[0].id;
}
