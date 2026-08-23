import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { resolveTarget, type Target } from "../src/target.js";
import { loadCloudToken } from "../src/credentials.js";
import {
  mapDiscoveredModel,
  withAutoModel,
  type DiscoveredModel,
  type PiModel,
} from "../src/models.js";
import { AUTO_MODEL_ID, PROVIDER_ID } from "../src/constants.js";
import { selectDefaultModelId } from "../src/select.js";
import { resolveOAuthConfig, deviceLogin, refreshCredentials } from "../src/oauth.js";

/**
 * Fetch + map BitRouter's `/v1/models` catalog, with the auto route at the
 * head. Throws on a non-OK response so the caller can tell "the gateway said
 * no" from "the gateway has nothing".
 *
 * Entries without a usable string id are dropped rather than failing the whole
 * listing — one malformed row should not cost the provider its whole catalog.
 */
async function discoverModels(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<PiModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: unknown };
  const rows = Array.isArray(payload.data)
    ? payload.data.filter(
        (m): m is DiscoveredModel =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as DiscoveredModel).id === "string" &&
          (m as DiscoveredModel).id.length > 0,
      )
    : [];
  return withAutoModel(rows).map(mapDiscoveredModel);
}

/** Widget key for the "not connected" login prompt (cloud, unauthenticated). */
const AUTH_WIDGET_KEY = "bitrouter-auth";

/** A prominent one-line call-to-action shown until the user connects. */
function loginBanner(): string[] {
  return [
    "  ▸ BitRouter Cloud — run /login to connect (new accounts get free credits)",
  ];
}

/**
 * Select a capable default model. Keeps the current selection only when it's
 * actually available — a stale or unresolvable one (e.g. a persisted model whose
 * provider is now "unknown") is replaced so the session isn't wedged on a model
 * pi can't resolve a key for.
 */
async function selectDefault(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  defaultModelId: string | undefined,
): Promise<void> {
  if (!defaultModelId) return;
  const current = ctx.model;
  if (
    current &&
    ctx.modelRegistry
      .getAvailable()
      .some((m) => m.provider === current.provider && m.id === current.id)
  ) {
    return;
  }
  const model = ctx.modelRegistry.find(PROVIDER_ID, defaultModelId);
  if (model) await pi.setModel(model);
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const env = process.env;
  const target = await resolveSmartTarget(env);
  if (target.mode === "cloud") {
    await registerCloud(pi, target, env);
  } else {
    await registerLocal(pi, target, env);
  }
}

/**
 * Pick the data plane. An explicit `BITROUTER_TARGET` always wins. Otherwise
 * prefer a **reachable local daemon** (zero-login dev flow) and fall back to
 * **cloud** (device-OAuth onboarding) when none is serving models — so a fresh
 * install lands on cloud while a running daemon keeps its no-login experience.
 */
async function resolveSmartTarget(env: NodeJS.ProcessEnv): Promise<Target> {
  if (env.BITROUTER_TARGET === "local" || env.BITROUTER_TARGET === "cloud") {
    return resolveTarget(env);
  }
  const local = resolveTarget({ ...env, BITROUTER_TARGET: "local" });
  if (await localDaemonServesModels(local.baseUrl)) return local;
  return resolveTarget({ ...env, BITROUTER_TARGET: "cloud" });
}

/** True when a local daemon answers `/models` with a non-empty catalog. */
async function localDaemonServesModels(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const payload = (await res.json()) as { data?: unknown[] };
    return Array.isArray(payload.data) && payload.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Local (default): route through the loopback daemon. A placeholder apiKey makes
 * the daemon's models selectable on a skip_auth loopback without a manual
 * /login — pi's getAvailable() filters out providers that have no configured key.
 */
async function registerLocal(
  pi: ExtensionAPI,
  target: Target,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const apiKey = env.BITROUTER_API_KEY ?? "bitrouter-local";
  let models: PiModel[];
  try {
    models = await discoverModels(target.baseUrl, apiKey);
  } catch (err) {
    console.error(
      `[bitrouter] model discovery failed at ${target.baseUrl}/models: ${String(err)}`,
    );
    return;
  }
  // `discoverModels` always leads with the auto route, so the catalog is never
  // empty here — a daemon serving nothing still leaves `bitrouter/auto`
  // selectable, and routing is the gateway's job rather than this extension's.
  // An unreachable daemon is the one case that registers nothing: the `catch`
  // above returns, because a provider whose every request fails is worse than
  // no provider at all.
  if (models.length === 1 && models[0].id === AUTO_MODEL_ID) {
    console.error(
      `[bitrouter] no models listed at ${target.baseUrl}/models; offering ${PROVIDER_ID}/${AUTO_MODEL_ID} alone`,
    );
  }
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: target.baseUrl,
    api: "openai-completions",
    apiKey,
    authHeader: true,
    models,
  });
  const defaultModelId = selectDefaultModelId(models);
  pi.on("session_start", (_event, ctx) => selectDefault(pi, ctx, defaultModelId));
}

/**
 * Cloud: route through BitRouter Cloud. Always register an `oauth` block so
 * `/login bitrouter` runs the device-authorization flow; discover the model
 * catalog with whatever token is available — an explicit BITROUTER_API_KEY, the
 * daemon's account-credentials.json, or (after a prior /login) the token pi
 * persisted, picked up at session start.
 */
async function registerCloud(
  pi: ExtensionAPI,
  target: Target,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const oauthConfig = resolveOAuthConfig(env);
  let defaultModelId: string | undefined;
  // Captured at session_start so login() (invoked later by pi) can select a
  // model and clear the "not connected" banner once a token lands.
  let activeUi: ExtensionContext["ui"] | undefined;
  let activeRegistry: ExtensionContext["modelRegistry"] | undefined;

  const register = (apiKey: string | undefined, models: PiModel[]): void => {
    defaultModelId = selectDefaultModelId(models);
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: target.baseUrl,
      api: "openai-completions",
      ...(apiKey ? { apiKey, authHeader: true } : {}),
      models,
      oauth,
    });
  };

  const discoverAndRegister = async (
    token: string | undefined,
  ): Promise<void> => {
    // The auto route is present from the first registration, before any token
    // exists: it is what the post-login `setModel` selects, and pi's
    // `getAvailable()` still hides the provider until a credential resolves,
    // so offering it early costs a user nothing.
    let models: PiModel[] = withAutoModel([]).map(mapDiscoveredModel);
    if (token) {
      try {
        models = await discoverModels(target.baseUrl, token);
      } catch (err) {
        console.error(`[bitrouter] cloud model discovery failed: ${String(err)}`);
      }
    }
    register(token, models);
  };

  const oauth: NonNullable<ProviderConfig["oauth"]> = {
    name: "BitRouter",
    login: async (callbacks) => {
      const creds = await deviceLogin(oauthConfig, callbacks);
      // Re-discover with the fresh token so the catalog appears this session.
      await discoverAndRegister(creds.access);
      // pi does NOT auto-pick a default for a custom provider after /login, so
      // select one here (the registered apiKey resolves the key immediately),
      // then drop the "not connected" banner.
      if (activeRegistry && defaultModelId) {
        const model = activeRegistry.find(PROVIDER_ID, defaultModelId);
        if (model) await pi.setModel(model);
      }
      activeUi?.setWidget(AUTH_WIDGET_KEY, undefined);
      return creds;
    },
    refreshToken: (creds) => refreshCredentials(oauthConfig, creds),
    getApiKey: (creds) => creds.access,
  };

  // Load-time token: an explicit env key, else the daemon's credential file.
  let initialToken = env.BITROUTER_API_KEY;
  if (!initialToken) {
    const tok = loadCloudToken(env, new Date());
    if (tok.ok) initialToken = tok.token;
  }
  await discoverAndRegister(initialToken);

  pi.on("session_start", async (_event, ctx) => {
    activeUi = ctx.ui;
    activeRegistry = ctx.modelRegistry;
    // A prior /login may have persisted a token but left no catalog (the load
    // above had none). Resolve it now — pi auto-refreshes — and discover.
    let hasModels = ctx.modelRegistry
      .getAvailable()
      .some((m) => m.provider === PROVIDER_ID);
    if (!hasModels) {
      let token: string | undefined;
      try {
        token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      } catch {
        token = undefined;
      }
      if (token) {
        await discoverAndRegister(token);
        hasModels = ctx.modelRegistry
          .getAvailable()
          .some((m) => m.provider === PROVIDER_ID);
      }
    }
    // Prominent prompt while unauthenticated; cleared once a catalog exists.
    ctx.ui.setWidget(AUTH_WIDGET_KEY, hasModels ? undefined : loginBanner());
    await selectDefault(pi, ctx, defaultModelId);
  });
}
