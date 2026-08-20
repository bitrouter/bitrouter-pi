import { describe, it, expect, vi } from "vitest";
import {
  resolveOAuthConfig,
  deviceLogin,
  refreshCredentials,
  type OAuthConfig,
  type OAuthDeps,
} from "../src/oauth.js";

const CONFIG: OAuthConfig = {
  authServer: "https://as.test",
  clientId: "bitrouter-cli",
  scope: "inference:invoke",
};

const META = {
  device_authorization_endpoint: "https://as.test/oauth/device",
  token_endpoint: "https://as.test/oauth/token",
};

const DEVICE = {
  device_code: "dev_abc",
  user_code: "WXYZ-1234",
  verification_uri: "https://cloud.bitrouter.ai/oauth/device",
  verification_uri_complete:
    "https://cloud.bitrouter.ai/oauth/device?user_code=WXYZ-1234",
  interval: 5,
  expires_in: 900,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch double that answers discovery + device-auth from fixtures and drains
 * `tokenQueue` sequentially for the token endpoint. */
function makeFetch(opts: {
  metadata?: unknown;
  metadataStatus?: number;
  device?: unknown;
  deviceStatus?: number;
  tokenQueue?: { body: unknown; status?: number }[];
}): typeof fetch {
  const tokenQueue = [...(opts.tokenQueue ?? [])];
  return (async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (u.includes(".well-known/oauth-authorization-server")) {
      return jsonResponse(opts.metadata ?? META, opts.metadataStatus ?? 200);
    }
    if (u.endsWith("/oauth/device")) {
      return jsonResponse(opts.device ?? DEVICE, opts.deviceStatus ?? 200);
    }
    if (u.endsWith("/oauth/token")) {
      const next = tokenQueue.shift();
      if (!next) throw new Error("token endpoint polled more than expected");
      return jsonResponse(next.body, next.status ?? 200);
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as unknown as typeof fetch;
}

/** A fake clock advanced by the injected sleep, so poll timing is instant. */
function fakeClock(): { deps: Pick<OAuthDeps, "now" | "sleep">; sleeps: number[] } {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

describe("resolveOAuthConfig", () => {
  it("defaults to the BitRouter AS + bitrouter-cli client", () => {
    const c = resolveOAuthConfig({});
    expect(c.authServer).toBe("https://api.bitrouter.ai");
    expect(c.clientId).toBe("bitrouter-cli");
    expect(c.scope).toContain("inference:invoke");
  });

  it("honors env overrides and strips a trailing slash", () => {
    const c = resolveOAuthConfig({
      BITROUTER_OAUTH_AS: "https://auth.example.com/",
      BITROUTER_OAUTH_CLIENT_ID: "bitrouter-pi",
      BITROUTER_OAUTH_SCOPE: "inference:invoke",
    });
    expect(c).toEqual({
      authServer: "https://auth.example.com",
      clientId: "bitrouter-pi",
      scope: "inference:invoke",
    });
  });
});

describe("deviceLogin", () => {
  it("discovers, shows the device code, polls to success, and maps credentials", async () => {
    const fetchImpl = makeFetch({
      tokenQueue: [
        { body: { error: "authorization_pending" }, status: 400 },
        {
          body: {
            access_token: "acc_1",
            refresh_token: "ref_1",
            expires_in: 3600,
            namespace_id: "ns_1",
          },
        },
      ],
    });
    const clock = fakeClock();
    const onDeviceCode = vi.fn();

    const creds = await deviceLogin(
      CONFIG,
      { onDeviceCode },
      { fetch: fetchImpl, ...clock.deps },
    );

    // pi is handed the one-click URI (embeds the user code) + the code.
    expect(onDeviceCode).toHaveBeenCalledWith({
      userCode: "WXYZ-1234",
      verificationUri: "https://cloud.bitrouter.ai/oauth/device?user_code=WXYZ-1234",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    expect(creds.access).toBe("acc_1");
    expect(creds.refresh).toBe("ref_1");
    expect(creds.namespace_id).toBe("ns_1");
    // expires = now(after two 5s sleeps = 10_000) + 3600_000 - 60_000 skew.
    expect(creds.expires).toBe(10_000 + 3_600_000 - 60_000);
  });

  it("falls back to verification_uri when no complete URI is given", async () => {
    const fetchImpl = makeFetch({
      device: { ...DEVICE, verification_uri_complete: undefined },
      tokenQueue: [{ body: { access_token: "acc" } }],
    });
    const onDeviceCode = vi.fn();
    await deviceLogin(
      CONFIG,
      { onDeviceCode },
      { fetch: fetchImpl, ...fakeClock().deps },
    );
    expect(onDeviceCode.mock.calls[0][0].verificationUri).toBe(
      "https://cloud.bitrouter.ai/oauth/device",
    );
  });

  it("widens the interval after slow_down (RFC 8628 §3.5)", async () => {
    const fetchImpl = makeFetch({
      tokenQueue: [
        { body: { error: "slow_down" }, status: 400 },
        { body: { access_token: "acc" } },
      ],
    });
    const clock = fakeClock();
    await deviceLogin(CONFIG, { onDeviceCode: vi.fn() }, { fetch: fetchImpl, ...clock.deps });
    // pre-poll 5s, then after slow_down the next wait is 5s + 5s = 10s.
    expect(clock.sleeps).toEqual([5000, 10000]);
  });

  it("rejects an untrusted verification_uri", async () => {
    const fetchImpl = makeFetch({
      device: { ...DEVICE, verification_uri_complete: "ftp://evil/", verification_uri: "ftp://evil/" },
      tokenQueue: [{ body: { access_token: "acc" } }],
    });
    await expect(
      deviceLogin(CONFIG, { onDeviceCode: vi.fn() }, { fetch: fetchImpl, ...fakeClock().deps }),
    ).rejects.toThrow(/untrusted verification_uri/);
  });

  it("throws on a terminal authorization error", async () => {
    const fetchImpl = makeFetch({
      tokenQueue: [{ body: { error: "access_denied" }, status: 400 }],
    });
    await expect(
      deviceLogin(CONFIG, { onDeviceCode: vi.fn() }, { fetch: fetchImpl, ...fakeClock().deps }),
    ).rejects.toThrow(/access_denied/);
  });

  it("times out once the device code expires", async () => {
    const fetchImpl = makeFetch({
      device: { ...DEVICE, expires_in: 8 },
      tokenQueue: [
        { body: { error: "authorization_pending" }, status: 400 },
        { body: { error: "authorization_pending" }, status: 400 },
      ],
    });
    await expect(
      deviceLogin(CONFIG, { onDeviceCode: vi.fn() }, { fetch: fetchImpl, ...fakeClock().deps }),
    ).rejects.toThrow(/timed out/);
  });

  it("throws when discovery is unreachable", async () => {
    const fetchImpl = makeFetch({ metadataStatus: 500, tokenQueue: [] });
    await expect(
      deviceLogin(CONFIG, { onDeviceCode: vi.fn() }, { fetch: fetchImpl, ...fakeClock().deps }),
    ).rejects.toThrow(/discovery failed/);
  });
});

describe("refreshCredentials", () => {
  it("exchanges the refresh token and preserves it when not rotated", async () => {
    const fetchImpl = makeFetch({
      tokenQueue: [{ body: { access_token: "acc_2", expires_in: 3600 } }],
    });
    const creds = await refreshCredentials(
      CONFIG,
      { access: "old", refresh: "ref_1", expires: 0 },
      { fetch: fetchImpl, now: () => 1000 },
    );
    expect(creds.access).toBe("acc_2");
    expect(creds.refresh).toBe("ref_1"); // preserved (server didn't rotate)
  });

  it("throws when there is no refresh token", async () => {
    await expect(
      refreshCredentials(CONFIG, { access: "a", refresh: "", expires: 0 }),
    ).rejects.toThrow(/no refresh token/);
  });
});
