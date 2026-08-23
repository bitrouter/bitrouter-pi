# @bitrouter/pi

A [pi package](https://pi.dev/docs/latest/packages) that registers a `bitrouter`
provider in [pi](https://pi.dev). It selects `bitrouter/auto` for you, discovers
the available models from your BitRouter instance at startup — there is no model
list to maintain — and, on cloud, runs an OAuth device-authorization login from
inside pi.

BitRouter can run two ways:

- **Local daemon** (`http://127.0.0.1:4356`) — BYOK, your keys, your machine.
- **BitRouter Cloud** (`https://api.bitrouter.ai/v1`) — managed proxy, one bill.

By default the extension picks for you: if a local daemon is serving models it
uses that (zero-login dev flow), otherwise it falls back to cloud and prompts
you to `/login`. Set `BITROUTER_TARGET` to force one.

## Install

```bash
pi install npm:@bitrouter/pi
```

Project-local (shared with your team via the repo's pi settings) instead of
global:

```bash
pi install -l npm:@bitrouter/pi
```

From a checkout of this repo:

```bash
pi install .
```

To iterate on the extension without installing it, point pi straight at the
file:

```bash
pi -e ./extensions/bitrouter.ts
```

## What the package contains

Per the [pi package manifest](https://pi.dev/docs/latest/packages) in
`package.json`:

| Path | Kind | Purpose |
|---|---|---|
| [`extensions/bitrouter.ts`](extensions/bitrouter.ts) | extension | Registers the `bitrouter` provider; discovers models; drives cloud `/login`. |
| [`skills/bitrouter/`](skills/bitrouter) | skill | Teaches the agent how to configure and troubleshoot BitRouter. |

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `BITROUTER_TARGET` | _(auto)_ | `local` → daemon at `http://127.0.0.1:4356/v1`; `cloud` → `https://api.bitrouter.ai/v1`. Unset means: use local if it answers `/models`, else cloud. |
| `BITROUTER_BASE_URL` | _(derived from target)_ | Override the base URL for either mode. Takes precedence over the target default. |
| `BITROUTER_API_KEY` | _(unset)_ | Local: a `brvk_` key minted by `bitrouter key sign`. Cloud: an access token to use instead of `/login`. |
| `BITROUTER_OAUTH_AS` | `https://api.bitrouter.ai` | Cloud only. Authorization-server origin for device login. |
| `BITROUTER_OAUTH_CLIENT_ID` | `bitrouter-cli` | Cloud only. Public OAuth client id. |
| `BITROUTER_OAUTH_SCOPE` | _(CLI default set)_ | Cloud only. Space-separated scope string. |

### Local target

The local daemon defaults to `skip_auth: true`, so loopback requests are
admitted without a key. To enable key-based auth, mint a virtual key:

```bash
bitrouter key sign --user <id>
```

```bash
export BITROUTER_API_KEY=brvk_...
```

### Cloud target

Run `/login` inside pi and pick **BitRouter**. That runs the RFC 8628
device-authorization flow: pi shows a user code and a verification URL, you
approve in the browser, and pi persists the credentials and refreshes them for
you. New accounts get free credits.

The extension will also reuse a token the BitRouter daemon already wrote, if
you have run `bitrouter auth login` on this machine:

| OS | Credential file location |
|---|---|
| Linux | `$XDG_DATA_HOME/bitrouter/account-credentials.json` (fallback: `$HOME/.local/share/bitrouter/`) |
| macOS | `$HOME/.local/share/bitrouter/account-credentials.json` |
| Windows | `%LOCALAPPDATA%\bitrouter\data\account-credentials.json` |

## The auto route

`bitrouter/auto` hands model choice back to BitRouter: the request carries
`auto` as its model and the gateway's routing policy picks the model per
request. It leads every catalog the extension registers, and it is what
`session_start` selects when you have not chosen a model yourself.

The rest of the catalog is still there. `bitrouter/auto` is the default, not
the only option — `/model` lists everything BitRouter serves, so pin
`anthropic/claude-opus-5` (or anything else) whenever you want one specific
model, and switch back whenever you do not.

Until BitRouter's own catalog lists `auto`, the extension synthesizes the entry
with deliberately conservative capacities (128K context, 16K output). They are
the floor rather than the ceiling on purpose — `auto` may land on any model in
the ladder, and under-claiming compacts a session early where over-claiming
fails a request outright, mid-turn. The moment `/v1/models` serves an `auto`
entry of its own, that entry wins and carries the real numbers with no release
here.

## Model discovery

At startup the extension calls `GET ${baseUrl}/models` and maps each model into
pi's Model shape (id, name, reasoning, input modalities, contextWindow,
maxTokens, cost).

The two data planes answer differently, and the extension reads each on its own
terms:

| | Local daemon | BitRouter Cloud |
|---|---|---|
| Body | `{ id, object, providers: [...] }` | the full catalog |
| Context window | not sent — defaults to 128K | `max_input_tokens` |
| Cost | not sent — reads as 0 | `pricing`, per million tokens |
| Reasoning / tools | not sent | `capabilities` tokens |

Neither plane sends `context_window`, a flat `cost` object, or `reasoning` and
`tool_call` booleans; earlier releases read those names and so showed every
cloud model at the default context window and priced at zero.

If the endpoint is unreachable the provider is not registered — a provider whose
every request fails is worse than no provider. A gateway that answers with an
empty catalog is a different case: it is up, so `bitrouter/auto` stays
selectable.

## MCP

MCP is not bundled in this package. BitRouter itself acts as an MCP gateway:
declare upstream MCP servers in `bitrouter.yaml` and run `bitrouter mcp serve`
to expose them, then point pi's MCP client at that endpoint.

## Troubleshooting

**Empty model list / provider not registered**

```
[bitrouter] no models discovered; provider not registered
[bitrouter] model discovery failed at http://127.0.0.1:4356/v1/models: ...
```

- Local: confirm the daemon is running with `bitrouter status`; start it with
  `bitrouter start`.
- Both modes: check that `BITROUTER_BASE_URL`, if set, points at a reachable
  BitRouter instance.

**Only `bitrouter/auto` is listed**

The gateway answered with an empty catalog. The auto route still works —
routing is the gateway's job — but `/model` will have nothing else to offer
until the catalog fills in.

**Cloud model discovery fails**

```
[bitrouter] cloud model discovery failed: HTTP 401
```

The token expired or was never obtained. Run `/login` in pi and pick
**BitRouter**.

**`HTTP 401` on a local target**

Set `BITROUTER_API_KEY=brvk_...`, or enable `skip_auth` in `bitrouter.yaml`.

## Development

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

The extension's logic lives in [`src/`](src) — pure, dependency-injected
modules (target resolution, credential loading, model mapping, default-model
selection, OAuth device flow) — with [`extensions/bitrouter.ts`](extensions/bitrouter.ts)
as the thin pi-facing composition layer. BitRouter's cloud endpoints are in
[`src/constants.ts`](src/constants.ts).

## License

Apache-2.0
