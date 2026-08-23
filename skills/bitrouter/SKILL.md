---
name: bitrouter-pi
description: >
  Use this skill when driving pi with the BitRouter provider — choosing
  local vs cloud target, configuring env vars, logging in to BitRouter Cloud,
  obtaining keys, and troubleshooting model discovery. Trigger when the user
  mentions the BitRouter pi package, BITROUTER_TARGET, BITROUTER_API_KEY,
  brvk_ keys, or wants to point pi at a local BitRouter daemon or BitRouter
  Cloud.
version: 1.1.0
license: Apache-2.0
metadata:
  author: BitRouterAI
  tags: [bitrouter, pi, llm, proxy, ai-gateway]
---

# BitRouter Provider for pi

The `@bitrouter/pi` package registers a `bitrouter` provider in pi. Models are
**discovered dynamically** at startup via `GET ${baseUrl}/models` — there is no
hard-coded model list to maintain.

## 1. Pick a target

| `BITROUTER_TARGET` | Base URL (default) | When to use |
|---|---|---|
| _(unset — the default)_ | auto | Use the local daemon if it answers `/models` with a non-empty catalog; otherwise cloud. |
| `local` | `http://127.0.0.1:4356/v1` | Force the local BitRouter daemon (BYOK). |
| `cloud` | `https://api.bitrouter.ai/v1` | Force BitRouter Cloud (managed, no per-provider keys). |

Override the URL for either mode with `BITROUTER_BASE_URL`:

```bash
BITROUTER_BASE_URL=http://192.168.1.10:4356/v1 pi
```

## 2. Authentication

### Local target

The local daemon defaults to `skip_auth: true` (loopback requests admitted with
no key), so the provider works with no key at all. If auth is enabled, mint a
`brvk_` virtual key:

```bash
bitrouter key sign --user <id>
```

```bash
export BITROUTER_API_KEY=brvk_...
```

### Cloud target

Run `/login` in pi and pick **BitRouter**. That starts the RFC 8628
device-authorization flow — pi displays a user code plus a verification URL,
the user approves in a browser, and pi persists and auto-refreshes the
credentials. Until then pi shows a one-line banner prompting the login.

Two shortcuts skip `/login` when a token already exists:

1. `BITROUTER_API_KEY` — used directly as the bearer token if set.
2. The BitRouter daemon's credential file, written by `bitrouter auth login`:
   - Linux: `$XDG_DATA_HOME/bitrouter/account-credentials.json`
     (falls back to `$HOME/.local/share/bitrouter/account-credentials.json`)
   - macOS: `$HOME/.local/share/bitrouter/account-credentials.json`
   - Windows: `%LOCALAPPDATA%\bitrouter\data\account-credentials.json`

An expired or missing credential file is not an error — it just means the login
banner stays up until `/login` runs.

## 3. The auto route and model discovery

`bitrouter/auto` is the default. It carries `auto` as the request's model and
lets BitRouter's routing policy pick the model per request; it leads every
catalog the extension registers, and `session_start` selects it when the user
has not already chosen a model that is still available.

It is the default, not the only option — the full catalog is registered behind
it, so `/model` can pin any specific model BitRouter serves.

On startup the extension calls `GET ${baseUrl}/models` and maps each entry to
pi's Model shape (id, name, reasoning, input modalities, contextWindow,
maxTokens, cost). The two planes answer differently: the local daemon sends
`{ id, object, providers }` and nothing more, while cloud sends
`max_input_tokens`, `pricing` (per million tokens), and `capabilities` tokens
such as `reasoning` and `tools`. Neither sends `context_window`, a flat `cost`
object, or boolean capability fields.

An **unreachable** endpoint means the provider is not registered — check that
the daemon is running and that `BITROUTER_BASE_URL` points at the correct host.
An endpoint that answers with an empty catalog still registers, with the auto
route alone. On **cloud** the provider is registered regardless so that
`/login` is available; the catalog fills in once a token lands.

## 4. MCP

MCP is **not bundled** in this package. BitRouter itself is an MCP gateway
(`/mcp` routes in `bitrouter.yaml`). Use `bitrouter mcp serve` to expose
upstream MCP servers through the daemon, then configure pi's MCP client to
point at it.

## 5. Quick reference

```bash
# Auto — local daemon if it is up, else cloud
pi

# Local — no key (skip_auth default)
BITROUTER_TARGET=local pi

# Local — with a brvk_ key
BITROUTER_TARGET=local BITROUTER_API_KEY=brvk_... pi

# Cloud — then run /login inside pi and pick BitRouter
BITROUTER_TARGET=cloud pi

# Override base URL
BITROUTER_BASE_URL=https://my.proxy/v1 BITROUTER_TARGET=cloud pi
```

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Login banner will not go away | Run `/login` and pick BitRouter; new accounts get free credits |
| `no models discovered` | Daemon not running or wrong URL — check `bitrouter status` and `BITROUTER_BASE_URL` |
| `model discovery failed at …` | The base URL is unreachable from this machine |
| `cloud model discovery failed: HTTP 401` | Token expired or absent — run `/login` |
| Local discovery fails with `HTTP 401` | Set `BITROUTER_API_KEY=brvk_...` or enable `skip_auth` in `bitrouter.yaml` |
