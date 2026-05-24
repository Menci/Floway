# Floway

A Cloudflare Workers API proxy that fronts multiple LLM upstreams behind one
set of standard APIs. Point your coding agent at Floway and it can reach any
configured upstream — a GitHub Copilot account, a custom OpenAI- or
Anthropic-compatible provider, or an Azure deployment — through whichever API
shape the agent already speaks.

## What clients can talk to it

| Source API                              | Path                          |
| --------------------------------------- | ----------------------------- |
| Anthropic Messages                      | `POST /v1/messages`           |
| OpenAI Responses                        | `POST /v1/responses`          |
| OpenAI Chat Completions                 | `POST /v1/chat/completions`   |
| OpenAI Embeddings                       | `POST /v1/embeddings`         |
| OpenAI Models                           | `GET  /v1/models`             |
| Google Gemini (generate / count tokens) | `POST /v1beta/models/...`     |

For each public model, Floway picks the first provider binding that can serve
the request, translating between source and target protocols when the upstream
speaks a different shape.

## Quick Start

Prereqs: a Cloudflare account, Node.js 20.3+, pnpm 10.x, and at least one
upstream credential (Copilot subscription, OpenAI-compatible bearer token, or
Azure endpoint + API key).

```bash
pnpm install

# Local Worker config (gitignored). Fill in account_id, database_id, name.
cp wrangler.example.jsonc wrangler.jsonc
pnpm wrangler login                      # or set CLOUDFLARE_ACCOUNT_ID
pnpm wrangler d1 create <DB_NAME>        # paste database_id into wrangler.jsonc

# Apply schema and set the admin secret.
pnpm run db:migrate
pnpm wrangler secret put ADMIN_KEY

# Run locally or deploy.
pnpm run dev
pnpm run deploy
```

Then open the deployed URL, log in with your `ADMIN_KEY`, and:

1. **Settings → Upstreams → Add Upstream**. Each upstream is one of *Custom*
   (OpenAI/Anthropic-shaped, static credential), *Azure* (one endpoint + key +
   deployment list), or *Copilot* (GitHub device OAuth). The list order is the
   routing order — providers earlier in the list win for a shared public model.
2. **API Keys → New Key**. Hand the generated key to your client.
3. Copy the Claude Code or Codex CLI snippet from the API Keys panel and paste
   it into your agent's config.

Import/export of the upstream + key + search config is in Settings; it uses the
latest `version: 2` payload shape.

## Optional: Anthropic-shaped web search

`/v1/messages` accepts Anthropic-style web search. When the resolved upstream
can run the native server tool, it passes through; otherwise Floway shims the
search via the provider configured under **Settings → Web Search** (`tavily` or
`microsoft-grounding`; default `disabled`).

## Development

```bash
pnpm run lint          # eslint --cache across the workspace
pnpm run test          # vitest run over the root test.projects
pnpm run typecheck     # pnpm -r run typecheck
pnpm run dev           # builds apps/web, then wrangler dev on apps/api
```

The repo is a pnpm workspace: `packages/protocols` and `packages/translate` are
pure libraries; `apps/api` is the Worker; `apps/web` prerenders the dashboard
that Workers Static Assets serves. Cross-package imports go through each
package's `exports` map; deep imports are blocked by ESLint.

See [AGENTS.md](./AGENTS.md) for the architecture, provider model, routing
rules, deploy workflow, and conventions that coding agents (and humans) follow
when changing this codebase.

## License

MIT
