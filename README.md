# Floway

Floway is a self-hosted LLM API gateway for coding agents and API clients. It
puts subscription-backed and token-backed model providers behind one gateway,
then routes each model through the API shape the client already speaks.

## Highlights

- Use GitHub Copilot, ChatGPT subscriptions, Claude.ai subscriptions, Azure AI,
  configurable multi-protocol HTTP providers, and Ollama from one deployment.
- Serve OpenAI, Anthropic, Gemini-compatible, audio transcription, and rerank
  APIs with cross-protocol translation where needed.
- Discover vendor model catalogs live while retaining manual model configuration
  for providers that require or permit it.
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

1. Add at least one provider under **Providers → Upstreams**.
2. Create a key under **Services → API Keys**.
3. Give that key to a client as a bearer token or `x-api-key`, or use **Agent
   Setup** to configure Claude Code or Codex.

The data-plane and control-plane APIs are also exposed directly at
<http://localhost:8788>. SQLite, file-backed dump bodies, and oversized
Stateful Responses item payloads persist in the `floway-data` volume.

The dashboard uses Floway's control plane to manage users, keys, upstreams,
routing, and telemetry. Coding agents and API clients call the data plane,
which performs model resolution, upstream dispatch, and any required protocol
translation. Both planes are served by the same gateway process.

## OAuth2 Dashboard Login

Floway can offer one or more custom OAuth2 providers alongside password and
`ADMIN_KEY` login. A provider-authenticated identity that is not bound yet can
choose a Floway username and register itself; the new non-admin user receives a
default API key. Later logins resolve the stable provider user ID back to that
same Floway account.

Register this callback URL in the OAuth2 application, replacing the origin and
provider ID with your values:

```text
https://floway.example.com/auth/oauth2/company/callback
```

Sign in as an administrator and open **Management → OAuth2 Login**. Set the
externally visible Floway origin (scheme, host, and optional port, without a
path), then add a provider. Floway displays the exact callback URL to register
with the OAuth2 application. Use HTTPS outside local development.

Each provider requires an ID, display name, client ID, client secret, and the
authorization, token, and UserInfo endpoint URLs. The remaining controls are:

- `clientAuthentication`: `client_secret_post` (the default) or
  `client_secret_basic`.
- `scopes`: scopes sent with the authorization request.
- `userIdClaim`: userinfo claim containing the immutable account ID; defaults
  to the first of `sub`, `id`, or `user_id`.
- `usernameClaim`: userinfo claim used as the registration display/login hint;
  defaults through common username, name, and email claims.
- `authorizationParams`: extra string parameters for the authorization
  endpoint. Protocol-owned parameters such as `state`, `redirect_uri`, and the
  PKCE challenge cannot be overridden.

Claim names may be dotted paths such as `data.user.id`. Provider client secrets
are stored in the Floway database and backup export, but are never returned by
the management API or hydrated back into the dashboard form. Authorization
state and browser binding are single-use and short-lived, PKCE uses S256, and
callback handoffs travel in the URL fragment so reverse proxies and static
asset servers do not receive them.

The optional UserInfo access policy is evaluated against the provider's raw
UserInfo JSON on every login and new account binding. Leave the policy editor
blank to permit every authenticated user. A policy combines conditions with
`and` or `or`, and `field` is a dotted JSON path such as `profile.roles`:

```json
{
  "logic": "or",
  "conditions": [
    { "field": "groups", "op": "contains", "value": "company:owners" },
    { "field": "groups", "op": "contains", "value": "company:buildbot" }
  ]
}
```

The provider must request whatever scope causes the upstream to include those
claims, such as `groups`; Floway does not call vendor-specific membership APIs.

The supported operators are:

- `eq` and `ne`: strict JSON equality without type conversion.
- `gt`, `gte`, `lt`, and `lte`: ordering between two numbers or two strings.
- `in` and `not_in`: strict membership of the claim value in the configured
  `value` array.
- `contains` and `not_contains`: strict member matching for an array claim, or
  substring matching when both the claim and configured value are strings.
- `exists` and `not_exists`: whether the dotted field path is present. These
  conditions omit `value`; a present `null` value still counts as existing.

Missing fields and values of incompatible types do not satisfy binary
operators, including negative operators. An empty `and` policy permits every
user, while an empty `or` policy rejects every user.

Each provider can define the message displayed when its policy rejects an
account. The template supports `{{provider}}`, `{{field}}`, `{{op}}`,
`{{required}}`, and `{{current}}`. Dotted paths under `current`, such as
`{{current.roles}}`, read individual claims from the complete UserInfo object.
Unknown variables remain unchanged. Leave the message blank to use Floway's
default error.

The self-registration upstream control optionally sets a user-level upstream
allowlist for accounts created through that provider. Turning the override off
allows all upstreams; turning it on permits only the selected upstreams. The
selection is captured when the OAuth2 callback succeeds, so a registration
already in progress keeps the permissions it was offered. It affects only new
users and does not rewrite existing accounts. Their default API key inherits
the user-level restriction rather than maintaining a second allowlist.

Signed-in users manage their own OAuth2 bindings under **Settings → OAuth2
Accounts**. An account with no password must keep at least one OAuth2 binding;
it can bind another enabled provider first and then remove the old binding.
Administrators can inspect and unlink the same identities while editing a user.

## Compatibility

### Client APIs

| API | Routes |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses`, `POST /v1/responses/compact`, WebSocket `GET /v1/responses` |
| OpenAI Embeddings | `POST /v1/embeddings` |
| OpenAI Images | `POST /v1/images/generations`, `POST /v1/images/edits` |
| OpenAI Audio Transcriptions | `POST /v1/audio/transcriptions` |
| OpenAI Models | `GET /v1/models`, `GET /models` |
| Anthropic Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| Google Gemini | `GET /v1beta/models`, `GET /v1beta/models/{model}`, `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1beta/models/{model}:countTokens` |
| Cohere Rerank v1 | `POST /v1/rerank` |
| Cohere Rerank v2 | `POST /v2/rerank` |
| Jina Rerank | `POST /jina/v1/rerank` |
| Voyage Rerank | `POST /voyage/v1/rerank` |

`/v1/models` and `/models` return Floway's public model superset to ordinary
callers and select the Codex or Claude Code discovery shape for those clients'
User-Agent.

Rerank models are manual Custom models. Each model selects its outbound Cohere,
Jina, Voyage, DashScope-compatible, or DashScope-native protocol and may
override that protocol's canonical path; there is no upstream-wide rerank path.

Audio transcription is a buffered multipart passthrough for Custom, Azure, and
Ollama-compatible upstreams. JSON, text, subtitle, and transcription SSE
responses retain their upstream wire shape.

### Upstreams

| Provider | Connection | Model catalog |
| --- | --- | --- |
| GitHub Copilot | GitHub device OAuth on `github.com` or a `*.ghe.com` tenant | Fetched live from Copilot |
| Codex | ChatGPT subscription through the Codex CLI OAuth client | Live inference catalog plus the account's built-in GPT Image capability |
| Claude Code | Claude.ai Pro, Max, Team, or Enterprise subscription through the Claude Code CLI OAuth client | Fetched live from Anthropic |
| Custom | Configurable multi-protocol HTTP endpoint, credential, and per-header ingress passthrough/overwrite rules | Live `/models` (OpenAI, Anthropic, or superset shapes), manual models, or both |
| Azure | Azure AI resource or Foundry project endpoint and API key | Configured models |
| Ollama | ollama.com or a self-hosted Ollama-compatible server | Fetched live from Ollama, with optional manual overrides |

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

The local dashboard runs at <http://localhost:5174>. For an agent-assisted
production deployment, invoke `$deploy-to-cloudflare`. It uses the established
update and rollback flow by default. A deployment named as new first runs an
isolated binding-probe bootstrap and requires its `Hello World` response before
publishing Floway.

For a manual production update, configure the admin secret, apply the remote
migrations, and deploy:

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

It serves the data-plane and control-plane APIs but not the dashboard. Use
Docker Compose for the complete self-hosted UI, or serve the web app separately.
Production Node.js deployments must set both `NODE_ENV=production` and a
non-empty `ADMIN_KEY`.

Podman users can instead follow the
[systemd deployment guide](./docker/systemd/README.md).

## Development

```bash
pnpm install
pnpm run dev
pnpm run verify
```

`verify` chains every check `.github/workflows/verify.yaml` runs, so a green run
locally is a green run on a pull request. Each link is also a script of its own,
in the order the chain runs them: `typegen`, `lint`, `typecheck`, `test`,
`test:installers`, `check:agents-md`, `check:generated-assets`,
`check:verify-parity`, and `build:web`, which carries the assertions about the
emitted bundle. `typegen` comes first because the generated route types are not
checked in and the lint configuration is type-aware, so a fresh clone has to
produce them before anything else can read the dashboard's sources.

[AGENTS.md](./AGENTS.md) defines the repository-wide agent requirements and
indexes its CI workflows, skills, workspace packages, and their responsibilities.

## License

MIT
