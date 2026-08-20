import { bitrouter } from "./constants.js";

export type TargetMode = "local" | "cloud";
export interface Target {
  mode: TargetMode;
  baseUrl: string;
}

const LOCAL_DEFAULT = bitrouter.local.apiBaseUrl;
const CLOUD_DEFAULT = bitrouter.cloud.apiBaseUrl;

/** Resolve which BitRouter data plane the provider should target. */
export function resolveTarget(env: Record<string, string | undefined>): Target {
  const mode: TargetMode = env.BITROUTER_TARGET === "cloud" ? "cloud" : "local";
  if (mode === "cloud") {
    return { mode, baseUrl: env.BITROUTER_BASE_URL ?? CLOUD_DEFAULT };
  }
  return { mode, baseUrl: env.BITROUTER_BASE_URL ?? LOCAL_DEFAULT };
}
