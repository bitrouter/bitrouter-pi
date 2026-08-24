import { AUTO_MODEL_ID } from "./constants.js";
import type { PiModel } from "./models.js";

/**
 * Preference order (case-insensitive substring match on the model id) for the
 * default model the persistent-chat surface selects on session start, used only
 * once {@link AUTO_MODEL_ID} has been ruled out. Reasoning over a codebase /
 * drafting routing policy is real work, so we prefer a capable model over the
 * cheapest one; the user can always switch with `/model`.
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
 * Pick the default model id from the discovered set, or `undefined` when
 * nothing was discovered.
 *
 * The auto route wins whenever it is present: deferring the choice to
 * BitRouter is the whole point of routing through it, and the ladder behind
 * `auto` is a better per-request judge than a fixed preference list. The list
 * below is the fallback for a gateway serving no auto route at all, and falls
 * back again to the first model when none of the preferred families are there.
 */
export function selectDefaultModelId(models: PiModel[]): string | undefined {
  if (models.length === 0) return undefined;
  if (models.some((m) => m.id === AUTO_MODEL_ID)) return AUTO_MODEL_ID;
  for (const pref of PREFERRED) {
    const hit = models.find((m) => m.id.toLowerCase().includes(pref));
    if (hit) return hit.id;
  }
  return models[0].id;
}
