import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: string };

interface RawCredentials {
  access_token?: unknown;
  expires_at?: unknown;
}

/** Compute the on-disk credentials path the BitRouter daemon writes. */
export function credentialsPath(env: Record<string, string | undefined>): string {
  const file = "account-credentials.json";
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "bitrouter", file);
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "bitrouter", "data", file);
  }
  return join(env.HOME ?? homedir(), ".local", "share", "bitrouter", file);
}

/** Validate a parsed credential object and extract a usable bearer token. */
export function extractCloudToken(raw: RawCredentials, now: Date): TokenResult {
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    return { ok: false, reason: "credentials file missing access_token" };
  }
  if (typeof raw.expires_at !== "string") {
    return { ok: false, reason: "credentials file missing expires_at" };
  }
  const expires = Date.parse(raw.expires_at);
  if (Number.isNaN(expires)) {
    return { ok: false, reason: "credentials file has unparseable expires_at" };
  }
  if (expires <= now.getTime()) {
    return { ok: false, reason: "cloud access token has expired; run `bitrouter auth login`" };
  }
  return { ok: true, token: raw.access_token };
}

/** Read + validate the daemon credential file. Returns a failure result on any IO/parse error. */
export function loadCloudToken(
  env: Record<string, string | undefined>,
  now: Date,
): TokenResult {
  let text: string;
  try {
    text = readFileSync(credentialsPath(env), "utf8");
  } catch {
    return { ok: false, reason: "no BitRouter cloud credentials; run `bitrouter auth login`" };
  }
  let parsed: RawCredentials;
  try {
    parsed = JSON.parse(text) as RawCredentials;
  } catch {
    return { ok: false, reason: "credentials file is not valid JSON" };
  }
  return extractCloudToken(parsed, now);
}
