import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bitrouterExtension from "../extensions/bitrouter.js";

/**
 * Behavioral test for the composed provider extension: it must register the
 * `bitrouter` provider with a configured apiKey (so pi surfaces its models) and,
 * on session start, select a default model only when the user has not already
 * chosen one. This is the Phase 1 "launch straight into a working model, no
 * /login" guarantee.
 *
 * Every catalog the extension registers leads with the `auto` route, so a
 * three-model gateway registers four entries and the default selection is
 * `auto` — the rest of the catalog stays selectable behind it.
 */

interface TestCtx {
  model: unknown;
  modelRegistry: {
    find?: (provider: string, id: string) => unknown;
    getAvailable?: () => Array<{ provider: string }>;
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
  };
  ui?: { setWidget: (key: string, content: string[] | undefined) => void };
}
type SessionStartHandler = (
  event: unknown,
  ctx: TestCtx,
) => Promise<void> | void;

function makePi() {
  let sessionStart: SessionStartHandler | undefined;
  const registerProvider = vi.fn();
  const setModel = vi.fn().mockResolvedValue(true);
  const on = vi.fn((event: string, handler: SessionStartHandler) => {
    if (event === "session_start") sessionStart = handler;
  });
  const pi = { registerProvider, setModel, on };
  return {
    pi: pi as unknown as ExtensionAPI,
    registerProvider,
    setModel,
    on,
    getSessionStart: () => sessionStart,
  };
}

const DISCOVERED = {
  data: [{ id: "gpt-4o" }, { id: "claude-opus-4-8" }, { id: "deepseek-v3" }],
};

const META = {
  device_authorization_endpoint: "https://as.test/oauth/device",
  token_endpoint: "https://as.test/oauth/token",
};
const DEVICE = {
  device_code: "dev_abc",
  user_code: "WXYZ-1234",
  verification_uri_complete:
    "https://cloud.bitrouter.ai/oauth/device?user_code=WXYZ-1234",
  interval: 1,
  expires_in: 900,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.BITROUTER_TARGET;
  delete process.env.BITROUTER_API_KEY;
  delete process.env.BITROUTER_BASE_URL;
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => DISCOVERED,
  })) as unknown as typeof fetch;
});

afterEach(() => {
  process.env = { ...savedEnv };
  globalThis.fetch = savedFetch;
  vi.restoreAllMocks();
});

describe("bitrouter provider extension (local)", () => {
  it("registers the provider with a placeholder apiKey so models are selectable", async () => {
    const t = makePi();
    await bitrouterExtension(t.pi);

    expect(t.registerProvider).toHaveBeenCalledTimes(1);
    const [name, config] = t.registerProvider.mock.calls[0];
    expect(name).toBe("bitrouter");
    expect(config).toMatchObject({
      baseUrl: "http://127.0.0.1:4356/v1",
      api: "openai-completions",
      apiKey: "bitrouter-local",
      authHeader: true,
    });
    // three discovered + the auto route at the head
    expect(config.models).toHaveLength(4);
    expect(config.models[0].id).toBe("bitrouter/auto");
  });

  it("uses an explicit BITROUTER_API_KEY when present", async () => {
    process.env.BITROUTER_API_KEY = "brvk_real_key";
    const t = makePi();
    await bitrouterExtension(t.pi);
    expect(t.registerProvider.mock.calls[0][1]).toMatchObject({
      apiKey: "brvk_real_key",
    });
  });

  it("selects the auto route on session start when none is chosen", async () => {
    const t = makePi();
    await bitrouterExtension(t.pi);
    expect(t.on).toHaveBeenCalledWith("session_start", expect.any(Function));

    const found = { id: "bitrouter/auto", provider: "bitrouter" };
    const find = vi.fn(() => found);
    await t.getSessionStart()!({}, { model: undefined, modelRegistry: { find } });

    // Deferring the choice to BitRouter is the point of routing through it.
    expect(find).toHaveBeenCalledWith("bitrouter", "bitrouter/auto");
    expect(t.setModel).toHaveBeenCalledWith(found);
  });

  it("respects a previously selected model that is still available", async () => {
    const t = makePi();
    await bitrouterExtension(t.pi);

    const current = { id: "user-picked", provider: "bitrouter" };
    const find = vi.fn(() => ({ id: "claude-opus-4-8" }));
    await t.getSessionStart()!(
      {},
      { model: current, modelRegistry: { find, getAvailable: () => [current] } },
    );

    expect(t.setModel).not.toHaveBeenCalled();
  });

  it("reselects when the current model is stale / no longer available", async () => {
    const t = makePi();
    await bitrouterExtension(t.pi);

    const fresh = { id: "claude-opus-4-8", provider: "bitrouter" };
    await t.getSessionStart()!(
      {},
      {
        model: { id: "gone", provider: "unknown" }, // stale selection
        modelRegistry: { find: () => fresh, getAvailable: () => [fresh] },
      },
    );

    expect(t.setModel).toHaveBeenCalledWith(fresh);
  });

  it("still offers the auto route when an explicit local daemon lists nothing", async () => {
    process.env.BITROUTER_TARGET = "local"; // force local; skip the smart probe
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    })) as unknown as typeof fetch;
    const t = makePi();
    await bitrouterExtension(t.pi);
    // The daemon answered — it is up, it just has no catalog to show. Routing
    // is the gateway's job, so `bitrouter/auto` stays selectable.
    const config = t.registerProvider.mock.calls[0][1];
    expect(config.models.map((m: { id: string }) => m.id)).toEqual(["bitrouter/auto"]);
  });

  it("registers nothing when an explicit local daemon is unreachable", async () => {
    process.env.BITROUTER_TARGET = "local";
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const t = makePi();
    await bitrouterExtension(t.pi);
    // No daemon at all: a provider whose every request fails is worse than no
    // provider, so this is the one case that registers nothing.
    expect(t.registerProvider).not.toHaveBeenCalled();
  });
});

describe("smart default (no explicit BITROUTER_TARGET)", () => {
  it("uses the local daemon when it serves models", async () => {
    // top-level beforeEach: no BITROUTER_TARGET, fetch returns a non-empty catalog.
    const t = makePi();
    await bitrouterExtension(t.pi);
    const config = t.registerProvider.mock.calls[0][1];
    expect(config.apiKey).toBe("bitrouter-local"); // local path
    expect(config.oauth).toBeUndefined();
  });

  it("falls back to cloud when no local daemon is reachable", async () => {
    process.env.XDG_DATA_HOME = "/nonexistent-bitrouter-test-dir"; // no cred file
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED"); // daemon down
    }) as unknown as typeof fetch;
    const t = makePi();
    await bitrouterExtension(t.pi);
    const config = t.registerProvider.mock.calls[0][1];
    expect(config.oauth?.name).toBe("BitRouter"); // cloud path
    expect(config.models.map((m: { id: string }) => m.id)).toEqual(["bitrouter/auto"]);
  });
});

describe("bitrouter provider extension (cloud)", () => {
  beforeEach(() => {
    process.env.BITROUTER_TARGET = "cloud";
    // No daemon credential file on disk for these tests.
    process.env.XDG_DATA_HOME = "/nonexistent-bitrouter-test-dir";
  });

  it("registers an oauth block for /login even with no token or catalog", async () => {
    const t = makePi();
    await bitrouterExtension(t.pi);

    expect(t.registerProvider).toHaveBeenCalledTimes(1);
    const config = t.registerProvider.mock.calls[0][1];
    expect(config.oauth?.name).toBe("BitRouter");
    // The auto route is offered before any token exists; pi's getAvailable()
    // still hides the provider until a credential resolves.
    expect(config.models.map((m: { id: string }) => m.id)).toEqual(["bitrouter/auto"]);
    expect(config.apiKey).toBeUndefined(); // no token yet → /login supplies it
    expect(
      config.oauth.getApiKey({ access: "acc", refresh: "r", expires: 0 }),
    ).toBe("acc");
  });

  it("discovers the catalog with an explicit BITROUTER_API_KEY + keeps the oauth block", async () => {
    process.env.BITROUTER_API_KEY = "brk_cloud";
    const t = makePi();
    await bitrouterExtension(t.pi);

    const config = t.registerProvider.mock.calls[0][1];
    expect(config.apiKey).toBe("brk_cloud");
    expect(config.authHeader).toBe(true);
    expect(config.models).toHaveLength(4); // three discovered + auto
    expect(config.oauth?.name).toBe("BitRouter");
  });

  it("device-logs-in and re-registers with the freshly discovered catalog", async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes(".well-known/oauth-authorization-server"))
          return jsonResponse(META);
        if (u.endsWith("/oauth/device")) return jsonResponse(DEVICE);
        if (u.endsWith("/oauth/token"))
          return jsonResponse({ access_token: "acc_live", refresh_token: "r", expires_in: 3600 });
        if (u.endsWith("/models")) return jsonResponse(DISCOVERED);
        throw new Error(`unexpected fetch to ${u}`);
      }) as unknown as typeof fetch;

      const t = makePi();
      await bitrouterExtension(t.pi); // initial register: oauth block, empty catalog
      const config = t.registerProvider.mock.calls[0][1];

      const onDeviceCode = vi.fn();
      const loginPromise = config.oauth.login({ onDeviceCode });
      await vi.runAllTimersAsync();
      const creds = await loginPromise;

      expect(onDeviceCode).toHaveBeenCalledTimes(1);
      expect(creds.access).toBe("acc_live");
      // login() re-registered the provider with the discovered catalog + token.
      const last = t.registerProvider.mock.calls.at(-1)![1];
      expect(last.models).toHaveLength(4); // three discovered + auto
      expect(last.models[0].id).toBe("bitrouter/auto");
      expect(last.apiKey).toBe("acc_live");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a prominent /login banner while unauthenticated", async () => {
    const t = makePi();
    await bitrouterExtension(t.pi);
    const setWidget = vi.fn();
    await t.getSessionStart()!(
      {},
      {
        model: undefined,
        ui: { setWidget },
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
          getApiKeyForProvider: async () => undefined,
        },
      },
    );
    expect(setWidget).toHaveBeenCalledWith(
      "bitrouter-auth",
      expect.arrayContaining([expect.stringContaining("/login")]),
    );
  });

  it("selects a model and clears the banner after a successful device login", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes(".well-known/oauth-authorization-server"))
        return jsonResponse(META);
      if (u.endsWith("/oauth/device")) return jsonResponse(DEVICE);
      if (u.endsWith("/oauth/token"))
        return jsonResponse({ access_token: "acc_live", expires_in: 3600 });
      if (u.endsWith("/models")) return jsonResponse(DISCOVERED);
      throw new Error(`unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;

    const t = makePi();
    await bitrouterExtension(t.pi);
    const config = t.registerProvider.mock.calls[0][1];

    const setWidget = vi.fn();
    const model = { id: "bitrouter/auto", provider: "bitrouter" };
    // session_start captures ctx.ui + registry and paints the banner (no catalog yet).
    await t.getSessionStart()!(
      {},
      {
        model: undefined,
        ui: { setWidget },
        modelRegistry: {
          getAvailable: () => [],
          find: () => model,
          getApiKeyForProvider: async () => undefined,
        },
      },
    );
    expect(setWidget).toHaveBeenCalledWith("bitrouter-auth", expect.any(Array));

    vi.useFakeTimers();
    try {
      const loginPromise = config.oauth.login({ onDeviceCode: vi.fn() });
      await vi.runAllTimersAsync();
      await loginPromise;
    } finally {
      vi.useRealTimers();
    }
    // login re-discovered the catalog, selected a model (pi won't for a custom
    // provider), and dropped the banner.
    expect(t.setModel).toHaveBeenCalledWith(model);
    expect(setWidget).toHaveBeenLastCalledWith("bitrouter-auth", undefined);
  });
});
