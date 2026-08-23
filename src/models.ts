/**
 * BitRouter's `GET /v1/models` catalog, and the mapping into pi's Model shape.
 *
 * The two data planes answer with genuinely different bodies, and neither is
 * the plain OpenAI shape:
 *
 * - **Local daemon** (`crates/bitrouter-sdk/src/server.rs`) lists ids only —
 *   `{ id, object, providers: string[] }`. Every capability field is absent,
 *   so a local route is described entirely by the defaults below.
 * - **Cloud** (`bitrouter-cloud/src/v1/http/models.rs`) lists a rich catalog:
 *   `max_input_tokens`, `max_output_tokens`, `input_modalities`,
 *   `output_modalities`, `pricing`, `capabilities`, and `providers` as an
 *   object (`{ total_online }`) rather than a list.
 *
 * Note what cloud does *not* send: there is no `context_window`, no `cost`,
 * and no `reasoning` boolean. Reading those names — as this package used to —
 * leaves every model at its default context window and priced at zero. The
 * capability booleans are carried by `capabilities` token strings instead, and
 * the window by `max_input_tokens`.
 */

import { AUTO_MODEL_ID } from "./constants.js";

/** Per-million-token rates, as `bitrouter-cloud/src/service/billing.rs` emits them. */
export interface DiscoveredPricing {
  input_tokens?: {
    /** Cost per million non-cached input tokens. */
    no_cache?: number;
    /** Cost per million cache-read input tokens. */
    cache_read?: number;
    /** Cost per million cache-write input tokens. */
    cache_write?: number;
  };
  output_tokens?: {
    /** Cost per million text output tokens. */
    text?: number;
    reasoning?: number;
    image?: number;
    audio?: number;
  };
}

/**
 * One entry as it arrives on the wire, union of both planes. Everything past
 * `id` is optional: the local daemon sends none of it, and cloud omits any
 * field no provider of that model declares.
 */
export interface DiscoveredModel {
  id: string;
  object?: string;
  name?: string;
  description?: string;
  /** Context window. Cloud's name for it; there is no `context_window` field. */
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  /** Per-million rates; there is no flat `cost` field. */
  pricing?: DiscoveredPricing;
  /**
   * Capability tokens, from `Capability` in
   * `crates/bitrouter-sdk/src/language_model/types.rs`: `reasoning`, `tools`,
   * `structured_outputs`, `image_input`, `file_input`, `web_search`, and so on.
   */
  capabilities?: string[];
  /** `string[]` from the local daemon; `{ total_online }` from cloud. */
  providers?: string[] | { total_online?: number };
}

export interface PiModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /**
   * pi's `openai-completions` API adds OpenAI-specific request fields that
   * BitRouter's gateway rejects with a strict "Extra inputs are not permitted"
   * (it isn't an OpenAI backend): `store: false` (gated by `supportsStore`) and
   * `stream_options` (gated by `supportsUsageInStreaming !== false`). Disable
   * both so pi omits them.
   */
  compat: { supportsStore: boolean; supportsUsageInStreaming: boolean };
}

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Capabilities assumed for the synthesized `auto` entry, used only while
 * BitRouter's own catalog does not list it. They are deliberately the floor
 * rather than the ceiling of what the route can reach: `auto` may land on any
 * model in the tier ladder, and the two wrong answers do not cost the same.
 * Under-claiming compacts a session earlier than it needed to; over-claiming
 * sends a request the chosen model rejects outright, mid-turn. A catalog that
 * lists `auto` replaces every one of these with the served value.
 */
const AUTO_CONTEXT = 128000;
const AUTO_MAX_TOKENS = 16384;

const PI_INPUT_MODALITIES = new Set<string>(["text", "image"]);

/** A capability token BitRouter advertises for a model. */
export function hasCapability(m: DiscoveredModel, token: string): boolean {
  return Array.isArray(m.capabilities) && m.capabilities.includes(token);
}

/**
 * How many providers can serve this model, when the plane says. Cloud answers
 * with a count; the local daemon answers with the provider names.
 */
export function providerCount(m: DiscoveredModel): number | undefined {
  if (Array.isArray(m.providers)) return m.providers.length;
  if (m.providers && typeof m.providers.total_online === "number") {
    return m.providers.total_online;
  }
  return undefined;
}

/**
 * Flatten BitRouter's nested per-million rates into the flat per-million shape
 * pi carries. Both sides are already per-million, so this is a reshape and not
 * a conversion. An undeclared rate reads as 0 — "not priced here" — which is
 * what pi shows for a model whose cost it does not know.
 */
export function toCost(pricing: DiscoveredPricing | undefined): PiModel["cost"] {
  const input = pricing?.input_tokens ?? {};
  const output = pricing?.output_tokens ?? {};
  return {
    input: input.no_cache ?? 0,
    output: output.text ?? 0,
    cacheRead: input.cache_read ?? 0,
    cacheWrite: input.cache_write ?? 0,
  };
}

/**
 * Input modalities, taking the declared list and the capability tokens
 * together — a plane may advertise `image_input` while leaving
 * `input_modalities` empty. pi models only text and image, so everything else
 * BitRouter names is dropped.
 */
function inputModalities(m: DiscoveredModel): ("text" | "image")[] {
  const declared = (m.input_modalities ?? []).filter((x): x is "text" | "image" =>
    PI_INPUT_MODALITIES.has(x),
  );
  const merged = new Set<"text" | "image">(declared);
  if (hasCapability(m, "image_input")) merged.add("image");
  // Text is the floor every supported protocol certainly carries, so a model
  // that declared nothing usable is still a text model rather than no model.
  merged.add("text");
  return (["text", "image"] as const).filter((x) => merged.has(x));
}

/** Map a (possibly enriched) `/v1/models` entry to pi's Model shape. */
export function mapDiscoveredModel(m: DiscoveredModel): PiModel {
  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: hasCapability(m, "reasoning"),
    input: inputModalities(m),
    contextWindow: m.max_input_tokens ?? DEFAULT_CONTEXT,
    maxTokens: m.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    cost: toCost(m.pricing),
    compat: { supportsStore: false, supportsUsageInStreaming: false },
  };
}

/**
 * The synthesized `auto` entry, used only while BitRouter's catalog does not
 * list one itself. The capacities are the conservative floor documented above.
 */
export function autoModel(): DiscoveredModel {
  return {
    id: AUTO_MODEL_ID,
    name: "BitRouter Auto",
    description: "Let BitRouter choose the model for each request.",
    max_input_tokens: AUTO_CONTEXT,
    max_output_tokens: AUTO_MAX_TOKENS,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    capabilities: ["tools", "reasoning"],
  };
}

/**
 * Put the auto route at the head of the catalog, synthesizing it when the
 * gateway does not serve one yet.
 *
 * A served entry still wins if one ever appears, though none does today:
 * `bitrouter/` is resolved before any provider lookup, and BitRouter's registry
 * validator refuses catalog models under it, so the entry has to come from
 * here. The check costs nothing and keeps the placeholder from shadowing a
 * future one. Order matters because the head
 * of this list is what a selector offers first.
 */
export function withAutoModel(discovered: DiscoveredModel[]): DiscoveredModel[] {
  const served = discovered.find((m) => m.id === AUTO_MODEL_ID);
  const rest = discovered.filter((m) => m.id !== AUTO_MODEL_ID);
  return [served ?? autoModel(), ...rest];
}
