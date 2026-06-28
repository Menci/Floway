# Floway

Floway is an LLM API gateway that fronts multiple model upstreams behind one
set of standard APIs. Point a coding agent at Floway and it can use a
GitHub Copilot account, a ChatGPT subscription via Codex CLI, a Claude.ai
Pro / Max subscription via Claude Code CLI, a custom OpenAI- or
Anthropic-compatible provider, an Azure deployment, or an Ollama server
(ollama.com or self-hosted) through whichever API shape the agent already
speaks.
Cloudflare Workers is the production deployment target; a Node.js deployment
target ships in the same repo for self-hosting on a long-lived process.

## Client APIs

| Source API                              | Path                          |
| --------------------------------------- | ----------------------------- |
| OpenAI Completions                      | `POST /v1/completions`        |
| Anthropic Messages                      | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| OpenAI Responses                        | `POST /v1/responses`, `POST /v1/responses/compact`, `GET /v1/responses` WebSocket |
| OpenAI Chat Completions                 | `POST /v1/chat/completions`   |
| OpenAI Embeddings                       | `POST /v1/embeddings`         |
| OpenAI Images                           | `POST /v1/images/generations` |
| OpenAI Image Edits                      | `POST /v1/images/edits`       |
| OpenAI Models                           | `GET  /v1/models`             |
| Google Gemini (generate / count tokens) | `POST /v1beta/models/...`     |

For each public model, Floway picks the first (provider, model) pair that can
serve the request, translating between source and target protocols when the
upstream speaks a different shape. `/v1/completions` is forwarded to upstreams that
expose the OpenAI text-completions endpoint (Custom OpenAI-compatible, Azure
OpenAI, Ollama) without cross-protocol translation.

## Quick Start

Prereqs: Node.js 22.5+ (for `node:sqlite` if you want the Node target),
pnpm 10.x, and at least one upstream credential — Copilot subscription,
ChatGPT Plus / Pro / Team subscription (via Codex CLI auth), Claude.ai
Pro / Max subscription (via Claude Code CLI auth), an OpenAI-compatible
bearer token, or Azure endpoint plus API key.

### Cloudflare Workers (production)

A Cloudflare account is required.

```bash
pnpm install

# Local Worker config (gitignored). Replace every <YOUR_*> placeholder.
cp wrangler.example.jsonc wrangler.jsonc
pnpm wrangler login
pnpm wrangler d1 create <DB_NAME>

# Apply schema and set the admin secret.
pnpm run db:migrate
pnpm wrangler secret put ADMIN_KEY

# Run locally or deploy. In dev, open the Vite SPA at http://localhost:5174.
pnpm run dev
pnpm run deploy
```

### Node.js (self-hosted)

```bash
pnpm install

# All config is environment variables; sqlite + filesystem dirs are created
# on first boot, migrations apply automatically.
ADMIN_KEY=<admin-secret> \
FLOWAY_DB_PATH=./data/floway.db \
FLOWAY_FILES_DIR=./data/files \
PORT=8788 \
pnpm run dev:node
```

Optionally set `RUNTIME_LOCATION=<tag>` to label this instance in the
performance telemetry's `runtimeLocation` dimension and as the dial-time
key for the proxy fallback list's per-instance colo whitelist. The value
is uppercased on read so `local`, `Local`, and `LOCAL` all match the
dashboard's uppercased whitelist input; defaults to `LOCAL` when unset.

The Node target serves no SPA — point the dashboard at the same admin host
through your own static-file server, or use the Cloudflare deploy for the
dashboard while running data-plane traffic on Node.

### Docker Compose (self-hosted web + server)

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY=<admin-secret> docker compose -f docker/docker-compose.yml up --build -d
```

Compose starts two services: `server` runs the Node.js target on
`http://localhost:8788` with SQLite/files persisted in the `floway-data`
volume, and `web` serves the built dashboard on `http://localhost:18088`.
The nginx web container proxies Floway API paths to `server`, including
WebSocket-capable `/v1/responses` and the Codex-compatible
`/azure-api.codex/*` routes. Pass `FLOWAY_WEB_PORT` or
`FLOWAY_SERVER_PORT` alongside `ADMIN_KEY` if those host ports are already in
use.

### After the first boot

Open the deployed URL (or `http://localhost:8788` for Node), log in with
`ADMIN_KEY`, and:

1. **Settings -> Upstreams -> Add Upstream**. Upstreams are *Custom*
   (OpenAI/Anthropic-shaped, static credential), *Azure* (one endpoint, API key,
   deployment list), *Copilot* (GitHub device OAuth), *Codex* (ChatGPT
   subscription via the Codex CLI's OAuth client; paste `~/.codex/auth.json`
   or run the OAuth flow from the dashboard), *Claude Code* (Claude.ai
   subscription via the Claude Code CLI's OAuth client; PKCE flow, Setup
   Token flow, or paste `~/.claude/.credentials.json`), or *Ollama* (base
   URL + optional API key — ollama.com or a self-hosted daemon). List
   order is routing order; earlier providers win for a shared public model id.
2. **API Keys -> New Key**. Give the generated key to your client.
3. Copy the Claude Code or Codex CLI snippet from the API Keys panel into the
   agent config.

Import/export of upstreams, keys, and search config is in Settings. The
payload format is tied to the running deployment, so import only accepts a
file produced by a deployment at the same version — re-export from the
current deployment before importing.

## Server Tools

`/v1/messages` accepts Anthropic-style web search. When the resolved upstream
can run the native server tool, Floway passes it through; otherwise it shims the
search via **Settings -> Web Search** (`tavily` or `microsoft-grounding`,
default `disabled`).

`/v1/responses` has a shared server-tool shim layer for hosted Responses
tools. `web_search` is rewritten into a model-visible function call,
executed through the same web-search provider (**Settings -> Web
Search**), and emitted back as Responses `web_search_call` items, with
the shim driving the internal multi-turn loop and replaying prior
`web_search_call` items across turns.

## Stateful Responses

`/v1/responses` stores replayable Responses input and output items for API-key
scoped HTTP requests. Clients can send `previous_response_id` to continue from
a stored snapshot, or resend full input history; repeated full-history input is
deduplicated by content hash instead of stored again. HTTP `store: false` does
not create durable snapshots or input payload rows, but it keeps output item
metadata for routing; if a later `store: true` request echoes that item with a
full payload, the metadata row is filled in place.

The same endpoint accepts `GET` WebSocket upgrades for streaming Responses
events. WebSocket `store: false` keeps replay state only inside the open
session, so same-socket `previous_response_id` works without writing those
items or snapshots to durable storage.

## Development

```bash
pnpm run lint          # eslint --cache across the workspace
pnpm run test          # vitest run over the root test.projects
pnpm run typecheck     # pnpm -r run typecheck
pnpm run dev           # parallel wrangler dev (8788) + Vite SPA dev server (5174)
pnpm run dev:node      # Node.js entry (tsx apps/platform-node/entry.ts)
```

The repo is a pnpm workspace; see [AGENTS.md](./AGENTS.md) for the full
package map and the strict dependency direction it enforces.

`wrangler.example.jsonc` keeps API/data-plane routes Worker-first and lets
other direct browser routes fall through to the SPA's `index.html`. It also
includes an hourly cron trigger used by the Worker to age out retained Responses
snapshots, payloads, and metadata. The Node entry runs the same maintenance
sweep on a wall-clock interval. Cross-package imports go through each package's
`exports` map; deep imports are blocked by ESLint.

See [AGENTS.md](./AGENTS.md) for architecture, provider routing, deployment,
and development conventions.

## License

MIT
