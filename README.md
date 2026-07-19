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

`POST /v1/images/edits` accepts multipart image uploads and JSON `images`
references.

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

# Apply schema. Prod also needs an admin secret; wrangler dev doesn't.
pnpm run db:migrate
pnpm wrangler secret put ADMIN_KEY   # production only

# Run locally or deploy. In dev, open the Vite SPA at http://localhost:5174.
pnpm run dev
pnpm run deploy
```

`ADMIN_KEY` is required on production deploys — a live Worker that
receives requests from Cloudflare's edge (detected via the `CF-Ray`
header) refuses passwordless logins. A local `wrangler dev` instance
without `.dev.vars` has no `ADMIN_KEY`, and the login page then accepts a
blank username with any (or empty) password as the seed admin.

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

`ADMIN_KEY` may be omitted on a dev machine — the login page then accepts
a blank username with any (or empty) password as the seed admin. Setting
`NODE_ENV=production` makes `ADMIN_KEY` mandatory: the entry point
refuses to boot without it, and the running server also rejects
passwordless logins.

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
WebSocket-capable `/v1/responses`. Pass `FLOWAY_WEB_PORT` or
`FLOWAY_SERVER_PORT` alongside `ADMIN_KEY` if those host ports are already in
use.

### After the first boot

Open the deployed URL (or `http://localhost:8788` for Node), log in with
`ADMIN_KEY` (or leave the password blank on a dev instance with no
`ADMIN_KEY` set), and:

1. **Settings -> Upstreams -> Add Upstream**. Upstreams are *Custom*
   (OpenAI/Anthropic-shaped, static credential), *Azure* (one endpoint, API key,
   deployment list), *Copilot* (GitHub device OAuth), *Codex* (ChatGPT
   subscription via the Codex CLI's OAuth client; paste `~/.codex/auth.json`
   or run the OAuth flow from the dashboard), *Claude Code* (Claude.ai
   subscription via the Claude Code CLI's OAuth client; PKCE flow, Setup
   Token flow, or paste `~/.claude/.credentials.json`), or *Ollama* (base
   URL + optional API key — ollama.com or a self-hosted daemon). List
   order is routing order; earlier providers win for a shared public model id.
2. **API Keys -> New Key**. Generate a long-lived key and use it directly as
   the `x-api-key` / bearer token in any client.
3. **API Keys -> Agent Setup** offers two output modes. **Agent Setup** and
   **Config snippets** form one selector in the left column; Claude Code and
   Codex form a second selector below it. The right column keeps one shared
   configuration form mounted while only the output below it switches between
   the one-command installer and manual snippets. Select a row in the API Keys
   table, then configure or copy the chosen agent. The browser remembers the
   last selected key while it still exists, and a newly created key becomes the
   selection automatically. With no selected key, form edits remain local and
   the output asks for a key instead of creating a setup URL.

   Claude Code exposes Default, Opus, Sonnet, and Haiku model overrides plus
   reasoning effort and gateway discovery. Codex exposes its model and reasoning
   effort. Both configurations live in one lease record and renew through one
   keepalive. The agent-specific script paths share the same token —
   `<token>/claude.sh` and `<token>/codex.sh` (plus their PowerShell variants) —
   and each script installs and configures only its named agent. The command
   picker defaults to Windows on Windows clients and to macOS/Linux elsewhere.

   Bash and PowerShell sources each have a `common/` directory containing
   ordered output, helper, and main fragments, plus one file per agent.
   TypeScript composes those common fragments with only the selected agent.
   The final `main`/`Main` invocation lives at the end of that agent file, so a
   truncated download cannot begin installation or configuration.

   The command's setup URL stays stable while the panel is open. The visible
   panel renews its five-minute lease once a minute, the URL expires about five
   minutes after you leave, and reopening the panel restores the latest
   preferences. Only after the replacement lease is stored does that insert
   prune the account's expired siblings. A missing CLI uses the first available
   install mechanism: Homebrew, npm, then the official script on macOS; npm,
   then the official script on Linux and Windows. A selected package manager
   failure is surfaced directly instead of silently falling through. The setup
   never uses `sudo` and never upgrades an existing installation.

   Native child-process output stays attached to the terminal so progress,
   colors, and carriage-return updates render in real time. Each script names
   its agent in four Homebrew-style notices: `Agent Setup`, `Installing`,
   `Configuring`, and `Completed Agent Setup`, with the agent name after a colon.
   Metadata and normal status text stay plain, while warning and error labels
   are colored. Bash exits with the selected agent's result; PowerShell stores
   it in `$LASTEXITCODE` without terminating the caller's `irm | iex` runspace.
   Neither script prints a redundant summary.

   Each managed file is backed up before Floway's settings are merged. Successful
   re-runs retain only the latest `settings.json` / `config.toml` backup; the
   provider-token rollback copy is deleted once the transaction commits, while
   a failed restore preserves it for manual recovery. The Codex provider token
   is stored separately under the active `CODEX_HOME`, so an official account
   login in `auth.json` remains available. Installation checks the local CLI version before
   configuration begins; setup performs no gateway request. Claude Code reports
   its settings path after the write succeeds; Codex reports the config and
   provider-token paths after both writes succeed. Both automatic and manual
   Codex configuration enable standalone web search and suppress its paired
   under-development warning.

   **Config snippets** keeps the manual setup path available for the same
   table-selected key, agent, and configuration form. Its `settings.json` or
   TOML output updates from those exact model, effort, and discovery choices;
   it does not mount a second set of controls. Claude Code is presented as a
   JSON edit rather than shell exports, while Codex also shows provider-token
   commands.

Import/export of upstreams, keys, and search config is in Settings. The
current payload format is version 11 and is tied to the running deployment, so
import only accepts that exact version. Re-export before moving a deployment.

## Server Tools

`/v1/messages` accepts Anthropic-style web search. When the resolved upstream
can run the native server tool, Floway passes it through; otherwise it shims the
search via **Settings -> Web Search** (`tavily`, `microsoft-grounding`, or `jina`,
default `disabled`).

`/v1/responses` has a shared server-tool shim layer for hosted Responses
tools. `web_search` is rewritten into a model-visible function call,
executed through the same web-search provider (**Settings -> Web
Search**), and emitted back as Responses `web_search_call` items, with
the shim driving the internal multi-turn loop and replaying prior
`web_search_call` items across turns.

Floway also serves the Codex CLI's search contract at `/alpha/search` and
`/v1/alpha/search`.
By default these routes and the Responses web-search shim use the same general
provider configured above. **Settings -> Web Search** can instead enable
**Passthrough OpenAI search** and select a Codex or Custom upstream plus model;
then both surfaces use that provider's alpha-search endpoint, while Messages
search continues using the general provider. Passthrough failures are returned
without falling back to another search backend.

## Client-carried Affinity

Chat-shaped APIs carry encrypted per-key routing affinity inside their native
opaque reasoning/signature fields. Requests using this feature must continue
through the same Floway deployment and API key. See [AFFINITY.md](./AFFINITY.md)
for protocol placement and compatibility details.

## Stateful Responses

`/v1/responses` stores replayable Responses input and output items for API-key
scoped HTTP requests. Clients can send `previous_response_id` to continue from
a stored snapshot, or resend full input history; repeated full-history input is
deduplicated by content hash instead of stored again. Complete items and
snapshots expire 30 days after their latest snapshot reference. HTTP
`store: false` writes no state; affinity is carried independently by the client.

The same endpoint accepts `GET` WebSocket upgrades for streaming Responses
events. WebSocket `store: false` keeps replay state only inside the open
session, so same-socket `previous_response_id` works without writing those
items or snapshots to durable storage.

## Model Aliases

An alias is an operator-defined virtual model id that maps to a list of
real targets. When a client sends a request with the alias name as
`model`, Floway picks one target from the list (per the alias's
`selection` mode — `first-available` walks the list in order, `random`
picks uniformly across the available subset), applies the target's
per-request rule overrides onto the outbound wire body, and routes the
request as if the client had asked for the picked id directly.

Aliases surface on every listing endpoint (`/v1/models`,
`/v1beta/models`, the Codex catalog); a visible alias whose name
collides with a real id replaces the real entry on the wire so the row
count stays one-per-id. The upstream response's `model` field reports
the target the request actually landed on, so a client that wants to
tell alias-vs-direct routing apart can compare the response's model id
against the id it sent.

Chat aliases (kind `chat`) can carry per-target rules — reasoning
effort, verbosity, service tier, and Anthropic thinking configuration.
Rules apply post-translate on the chosen target IR; a rule with no
native slot on that target is dropped by design. Passthrough aliases
(kinds `embedding` / `image`) must have empty rules.

Schema and the seeded `codex-auto-review` alias live in
`packages/gateway/migrations/0046_model_aliases.sql`; behavior and
rule-mapping details are covered in [RESOLUTION.md](./RESOLUTION.md) and
[TRANSLATION.md](./TRANSLATION.md).

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
