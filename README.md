# Floway

Floway is a self-hosted LLM API gateway for coding agents and API clients. It
puts subscription-backed and token-backed model providers behind one gateway,
then routes each model through the API shape the client already speaks.

## Highlights

- Use GitHub Copilot, ChatGPT subscriptions, Claude.ai subscriptions, Azure
  OpenAI, custom OpenAI- or Anthropic-compatible providers, and Ollama from one
  deployment.
- Serve OpenAI, Anthropic, and Gemini-compatible APIs with cross-protocol
  translation where needed.
- Manage upstreams, routing order, model aliases, API keys, and web search from
  a dashboard.
- Generate one-command Claude Code and Codex configurations from an API key.
- Run on Cloudflare Workers or Node.js, with Docker Compose provided for a
  self-hosted server and dashboard.

## Quick Start

Docker Compose is the shortest path to a complete local deployment:

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:18088>, leave the username blank, and use `ADMIN_KEY` as
the password. Then:

1. Add at least one provider under **Settings → Upstreams**.
2. Create a key under **API Keys**.
3. Give that key to a client as a bearer token or `x-api-key`, or use **Agent
   Setup** to configure Claude Code or Codex.

The gateway API is also exposed directly at <http://localhost:8788>. SQLite and
uploaded files persist in the `floway-data` volume.

## Compatibility

### Client APIs

| API | Routes |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses`, `POST /v1/responses/compact`, WebSocket `GET /v1/responses` |
| OpenAI Embeddings | `POST /v1/embeddings` |
| OpenAI Images | `POST /v1/images/generations`, `POST /v1/images/edits` |
| OpenAI Models | `GET /v1/models` |
| Anthropic Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| Google Gemini | `POST /v1beta/models/...` |

### Upstreams

| Provider | Authentication |
| --- | --- |
| GitHub Copilot | GitHub device OAuth |
| Codex | ChatGPT subscription through the Codex CLI OAuth client |
| Claude Code | Claude.ai Pro or Max subscription through the Claude Code CLI OAuth client |
| Custom | OpenAI- or Anthropic-compatible endpoint and credential |
| Azure | Azure OpenAI endpoint, API key, and deployments |
| Ollama | ollama.com or a self-hosted Ollama-compatible server |

## Other Deployment Options

### Cloudflare Workers

Requires Node.js 22.5+, pnpm 10.x, and a Cloudflare account.

```bash
pnpm install
pnpm wrangler login
cp wrangler.example.jsonc wrangler.jsonc

# Follow the comments in wrangler.jsonc to create the required resources and
# replace every <YOUR_*> placeholder.
pnpm run db:migrate
pnpm run dev
```

The local dashboard runs at <http://localhost:5174>. For production, configure
the admin secret, apply the remote migrations, and deploy:

```bash
pnpm wrangler secret put ADMIN_KEY
pnpm run db:migrate:remote
pnpm run deploy
```

### Node.js

The Node.js target applies SQLite migrations automatically and defaults to
`./data/floway.db`, `./data/files`, and port `8788`:

```bash
pnpm install
ADMIN_KEY='replace-with-a-secret' pnpm run dev:node
```

It serves the gateway and control-plane APIs but not the dashboard. Use Docker
Compose for the complete self-hosted UI, or serve the web app separately.
Production Node.js deployments must set both `NODE_ENV=production` and a
non-empty `ADMIN_KEY`.

Podman users can instead follow the
[systemd deployment guide](./docker/systemd/README.md).

## Development

```bash
pnpm install
pnpm run dev
pnpm run test
pnpm run lint
pnpm run typecheck
```

More detail lives in [AGENTS.md](./AGENTS.md) — architecture, workspace
layout, verification, and contributor rules.

## License

MIT
