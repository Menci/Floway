# Floway

Floway is an LLM API gateway that fronts multiple model upstreams behind one
set of standard APIs. Point a coding agent at Floway and it can use a GitHub
Copilot account, a ChatGPT subscription through the Codex CLI OAuth client, a
Claude.ai Pro / Max subscription through the Claude Code CLI OAuth client, a
custom OpenAI- or Anthropic-compatible provider, an Azure deployment, or an
Ollama server through whichever API shape the agent already speaks.

Cloudflare Workers is the production deployment target. A Node.js deployment
target ships in the same repository for self-hosting on a long-lived process.

## Client APIs

| Source API | Path |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| Anthropic Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| OpenAI Responses | `POST /v1/responses`, `POST /v1/responses/compact`, `GET /v1/responses` WebSocket |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Embeddings | `POST /v1/embeddings` |
| OpenAI Images | `POST /v1/images/generations` |
| OpenAI Image Edits | `POST /v1/images/edits` |
| OpenAI Models | `GET /v1/models` |
| Google Gemini | `POST /v1beta/models/...` generate and count-token actions |

`POST /v1/images/edits` accepts multipart image uploads and JSON `images`
references. The dashboard's Codex provider base, `/azure-api.codex`, exposes
the same generation and edit handlers at their provider-relative paths.

For each public model, Floway enumerates every compatible `(upstream, model,
alias-rules)` candidate, applies client-carried affinity, and tries candidates
in order until an upstream opens a stream or returns a successful plain
response. Pairwise translation is used when the selected upstream speaks a
different chat protocol. `/v1/completions` is only sent to upstreams that
advertise the text-completions endpoint; it has no cross-protocol translation.

## Quick Start

Prerequisites: Node.js 22.5+ (for `node:sqlite` on the Node target), pnpm 10.x,
and at least one upstream credential: Copilot, ChatGPT Plus / Pro / Team,
Claude.ai Pro / Max, an OpenAI-compatible bearer token, an Azure endpoint and
API key, or an Ollama server.

### Cloudflare Workers

```bash
pnpm install

# Local Worker config (gitignored). Replace every <YOUR_*> placeholder.
cp wrangler.example.jsonc wrangler.jsonc
pnpm wrangler login
pnpm wrangler d1 create <DB_NAME>

# Apply schema. Production also needs an admin secret.
pnpm run db:migrate
pnpm wrangler secret put ADMIN_KEY

# In development, open the Vite SPA at http://localhost:5174.
pnpm run dev
pnpm run deploy
```

`ADMIN_KEY` is required on production deployments. A Worker request that came
through Cloudflare's edge, detected by `CF-Ray`, never permits passwordless
login. A local `wrangler dev` instance without `.dev.vars` accepts a blank
username and any password as the seed admin.

### Node.js

```bash
pnpm install

ADMIN_KEY=<admin-secret> \
FLOWAY_DB_PATH=./data/floway.db \
FLOWAY_FILES_DIR=./data/files \
PORT=8788 \
pnpm run dev:node
```

SQLite, the file store, and schema are created on first boot. `ADMIN_KEY` may
be omitted in development; `NODE_ENV=production` makes it mandatory and the
entry point refuses to boot without it.

Set `RUNTIME_LOCATION=<tag>` to label performance telemetry and select the
proxy fallback list's location-specific entries. The value is uppercased and
defaults to `LOCAL`.

The Node target serves no SPA. Host the dashboard separately, or use a
Cloudflare deployment for the dashboard while directing data-plane traffic to
the Node server.

### Docker Compose

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY=<admin-secret> docker compose -f docker/docker-compose.yml up --build -d
```

Compose starts `server` on `http://localhost:8788` with SQLite and files in the
`floway-data` volume, plus `web` on `http://localhost:18088`. The nginx web
container proxies all Floway API paths, including Responses WebSocket and
`/azure-api.codex/*`. Override the host ports with `FLOWAY_WEB_PORT` and
`FLOWAY_SERVER_PORT`.

### First boot

Open the deployed URL, log in with `ADMIN_KEY` (or the development shortcut),
then:

1. Open **Settings -> Upstreams -> Add Upstream**. Configure Custom, Azure,
   Copilot, Codex, Claude Code, or Ollama. List order is normal routing order.
2. Open **API Keys -> New Key** and give the generated credential to the
   client.
3. Copy the Claude Code or Codex CLI snippet from the API Keys panel.

Settings import/export currently uses format version 10. Import only accepts
the exact current format version; re-export before migrating a deployment.

## Routing and state

Aliases and shared names may resolve to several upstream/model bindings. Floway
uses client-carried opaque fields to preserve affinity across turns; those
payloads are expected to return through the same deployment and API key. See
[AFFINITY.md](./AFFINITY.md) for the wire contract and
[RESOLUTION.md](./RESOLUTION.md) for candidate ordering.

Native Responses state is independent from affinity. Complete items and
snapshots are API-key scoped and retained for 30 days when storage is enabled;
`store: false` is write-free over HTTP and session-local over WebSocket.

## Server tools

`/v1/messages` accepts Anthropic web search. A provider that can serve the
native server tool receives it directly; otherwise Floway shims it through the
provider configured under **Settings -> Web Search** (`tavily` or
`microsoft-grounding`, default `disabled`).

`/v1/responses` has a shared hosted-tool shim. `web_search` is rewritten into a
model-visible function call, executed through the same search provider, and
restored as Responses `web_search_call` items. Image generation follows the
same orchestration model and supports generation and edit sources.

## Model aliases

An alias is an operator-defined virtual model ID with a list of real targets.
`first-available` walks target declaration order; `random` shuffles available
targets. Every target candidate carries its own post-translation rule overlay,
and failures continue through the remaining upstreams and alias targets.

Aliases appear on `/v1/models`, `/v1beta/models`, and the Codex catalog. A
visible alias shadows a real model with the same public ID so listings keep one
row per ID. The response reports the canonical model that actually served the
request.

Chat alias rules cover reasoning effort, Messages thinking configuration,
verbosity, and service tier. Rules apply on the chosen target protocol after
translation; a rule with no native target slot is omitted. Embedding and image
aliases must use empty rules. See [RESOLUTION.md](./RESOLUTION.md) and
[TRANSLATION.md](./TRANSLATION.md).

## Development

```bash
pnpm run lint
pnpm run test
pnpm run typecheck
pnpm run dev
pnpm run dev:node
```

The repository is a pnpm workspace. `wrangler.example.jsonc` keeps API paths
Worker-first, lets SPA routes fall through to `index.html`, and configures the
hourly maintenance trigger. The Node entry runs the same maintenance on a
wall-clock interval. Cross-package imports use declared exports; ESLint blocks
deep imports.

See [AGENTS.md](./AGENTS.md) for package boundaries, verification, deployment,
and agent conventions.

## License

MIT
