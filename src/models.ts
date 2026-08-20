// One entry from BitRouter's `GET /v1/models` response. The server also emits
// `tool_call` and `output_modalities`, deliberately omitted here: pi's Model
// shape has no field for them, so reading them would be dead.
export interface DiscoveredModel {
  id: string;
  object?: string;
  providers?: string[];
  name?: string;
  reasoning?: boolean;
  input_modalities?: string[];
  context_window?: number;
  max_output_tokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
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

const PI_INPUT_MODALITIES = new Set<string>(["text", "image"]);

/** Map a (possibly enriched) `/v1/models` entry to pi's Model shape. */
export function mapDiscoveredModel(m: DiscoveredModel): PiModel {
  const c = m.cost ?? {};
  const rawModalities =
    m.input_modalities && m.input_modalities.length > 0 ? m.input_modalities : ["text"];
  const input = rawModalities.filter((x): x is "text" | "image" => PI_INPUT_MODALITIES.has(x));
  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    contextWindow: m.context_window ?? DEFAULT_CONTEXT,
    maxTokens: m.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    cost: {
      input: c.input ?? 0,
      output: c.output ?? 0,
      cacheRead: c.cache_read ?? 0,
      cacheWrite: c.cache_write ?? 0,
    },
    compat: { supportsStore: false, supportsUsageInStreaming: false },
  };
}
