# AGENTS.md

## Hard Rules

- Do not open a Pull Request without explicit human approval. The human must
  understand the goal and risk, read the AI-generated code and PR text, and
  believe code, docs, and tests are internally consistent.
- Do not create commits unless the human explicitly asks for a commit.
- Before claiming work is complete, run the relevant verification command and
  read the result.
- Keep this file aligned with real architecture. Rewrite it when needed; do not
  accrete contradictory notes.

## Project

`floway` is a Cloudflare Workers API proxy. It exposes Anthropic
Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, OpenAI
Images (`/v1/images/generations` and `/v1/images/edits`), and Google
Gemini-compatible APIs over unified upstream records. Supported provider kinds
are `copilot`, `custom`, and `azure`.

`custom` means a third-party LLM upstream reached over a static credential —
either an OpenAI-shaped bearer-token API (OpenAI, OpenRouter, floway,
etc.) or an Anthropic-shaped `x-api-key` API (api.anthropic.com). It is not an
OpenAI official-account concept. Azure OpenAI / Foundry OpenAI v1 deployments
and Azure Foundry Anthropic deployments use the `azure` provider. GitHub
Copilot accounts are persisted as `copilot` upstreams.

Stack: Hono + Web APIs, repository-backed persistence, D1 on Cloudflare Workers,
in-memory repositories for tests, TypeScript, pnpm, and Vitest.

The production runtime contract is Workers-compatible: a fetch entrypoint,
Workers bindings, Web APIs, and a D1-compatible SQL binding. Keep the narrow
`apps/api/src/runtime/` compatibility layer for future runtimes that can provide
the same semantics. Do not add a separate Node.js HTTP server or Node+SQLite
production binding unless that becomes an explicit product goal.

## Workspace Layout

The repo is a pnpm workspace with five packages, three libraries under
`packages/` and two deployables under `apps/`:

```text
floway/
├── wrangler.example.jsonc      # committed template; copy to wrangler.jsonc
│                               # (gitignored) and fill in account_id and
│                               # d1 database_id locally. main ->
│                               # apps/api/entry-cloudflare.ts, assets ->
│                               # apps/web/dist (SPA fallback enabled),
│                               # migrations_dir -> apps/api/migrations
├── eslint.config.ts            # internal regex ^@floway-dev/ + a
│                               # no-restricted-imports ban on @floway-dev/*/src/**
│                               # .vue files parsed by vue-eslint-parser
├── vitest.config.ts            # root project list (Vitest 4 test.projects)
├── packages/
│   ├── protocols/              # @floway-dev/protocols — pure type defs
│   │   └── src/{common,chat-completions,responses,messages,gemini,embeddings,images}/index.ts
│   ├── translate/              # @floway-dev/translate — translation pairs
│   │   └── src/{<pair-dirs>,shared,types.ts,index.ts}
│   └── ui/                     # @floway-dev/ui — internal Vue component
│       └── src/{*.vue,utils/cn.ts,index.ts}      # library wrapping Reka UI
│                                                  # primitives, styled with
│                                                  # UnoCSS classes consumed
│                                                  # by apps/web
└── apps/
    ├── api/                    # @floway-dev/api — Worker entry + planes
    │   ├── entry-cloudflare.ts
    │   ├── migrations/
    │   └── src/{control-plane,data-plane,middleware,repo,runtime,shared,app.ts}
    └── web/                    # @floway-dev/web — Vue + Vite SPA served by
        ├── vite.config.ts      # Workers Static Assets at /apps/web/dist
        ├── uno.config.ts
        ├── index.html
        └── src/{main.ts,App.vue,router.ts,
                 pages,components,composables,stores,api,styles}
```

Dependency direction is strict:

- `protocols` depends on nothing.
- `translate` depends only on `protocols`.
- `api` depends on `protocols` and `translate`.
- `ui` depends only on `vue` + `reka-ui` (no workspace deps).
- `web` depends on `ui` and type-imports `@floway-dev/api/app-type` for the
  Hono RPC client typing.

Each `package.json` `exports` map is the only public surface. Deep imports
(`@floway-dev/<pkg>/src/...`) are banned by ESLint `no-restricted-imports`;
cross-package code must consume the package's declared subpath exports.

`@floway-dev/api` exposes two entries:

- `.` — the Worker entry, used only by `wrangler.jsonc`'s `main` field.
- `./app-type` — a type-only export pointing at `src/app.ts`, consumed by
  `apps/web/src/api/client.ts` as `hc<AppType>(...)`'s generic. The import
  is type-only so bundlers tree-shake the runtime code; nothing from the
  Worker side ships in the browser bundle.

### Test layout

Tests are co-located as `*_test.ts` alongside the code they cover. Each
package has its own `vitest.config.ts`; the root `vitest.config.ts` lists them
through Vitest 4's `test.projects`. `apps/web` has no tests yet — the SPA is
new and adding tests is a follow-up if and when behavior solidifies.

## Boundaries

- `apps/api/entry-cloudflare.ts`: Workers entrypoint and environment wiring.
- `apps/api/src/app.ts`: Hono app wiring, middleware, and plane mounting.
- `apps/api/src/control-plane/`: dashboard, auth, admin APIs, import/export,
  usage and performance views.
- `apps/api/src/control-plane/upstreams/`: unified upstream CRUD, custom/Azure
  probing, Copilot device-flow auth, and Copilot per-upstream quota.
- `apps/api/src/data-plane/`: client-facing compatibility APIs, model/provider
  routing, embeddings, images, and data-plane tools. Cross-protocol request/event
  translation lives in `@floway-dev/translate` and is dispatched from the
  data-plane source serves.
- `apps/api/src/data-plane/images/`: source serves for
  `POST /v1/images/generations` and `POST /v1/images/edits`. Multipart edits
  are loaded into the Workers heap via `request.formData()`; dispatch picks
  the first provider binding whose `upstreamEndpoints` declares the requested
  capability, which in practice means `UpstreamModel.kind === 'image'`.
- `apps/api/src/data-plane/providers/`: provider interface, provider registry,
  model merge, provider-owned alias resolution, flag catalog and
  effective-flag resolver, and concrete provider implementations.
- `apps/api/src/data-plane/providers/copilot/`: Copilot provider projection,
  raw model variant selection, endpoint capability projection, and
  Copilot-specific provider registrations.
- `apps/api/src/data-plane/providers/custom/`: generic OpenAI-shaped or
  Anthropic-shaped provider behavior for configured static-credential
  upstreams. Owns the permissive `/models` parser that accepts OpenAI,
  Anthropic, and floway-own response shapes.
- `apps/api/src/data-plane/providers/azure/`: Azure OpenAI / Foundry OpenAI v1
  and Azure Foundry Anthropic provider behavior, deployment catalog projection,
  and API-key request construction.
- `apps/api/src/repo/`: persistence interfaces and implementations.
- `apps/api/src/runtime/`: runtime integration helpers for environment access
  and background scheduling.
- `apps/api/src/shared/`: project-wide helpers that are not owned by one plane.
- `apps/api/src/shared/upstream/`: low-level HTTP adapters. These know how to
  call an upstream and own the persisted shape of provider-specific config
  (including any per-deployment flag-override metadata), but they do not own
  LLM planning, target selection, or interceptor wiring.
- `apps/api/src/data-plane/llm/shared/protocol/responses.ts`: re-export barrel for
  gateway-side Responses extensions (e.g. `SequencedResponsesStreamEvent`),
  whose definitions live in `@floway-dev/translate/via-responses`. The
  rest of the protocol type surface lives in `@floway-dev/protocols`
  (`common`, `chat-completions`, `responses`, `messages`, `gemini`,
  `embeddings`).
- `apps/api/src/data-plane/llm/shared/stream/`: concrete SSE parser used by
  the data plane. Generic SSE shapes (`ServerSentEvent` and friends) live in
  `@floway-dev/protocols/common`.

`ModelPricing` and `ModelEndpoint` types live in
`@floway-dev/protocols/common`; `apps/api/src/data-plane/providers/types.ts`
re-exports both for back-compat. `ExecuteResult` and the result envelopes in
`apps/api/src/data-plane/llm/shared/errors/result.ts` stay in apps/api because
they couple to telemetry types.

Keep behavior in the subtree that owns the boundary where it is true. Avoid flat
shared utility modules unless the rule is genuinely cross-boundary.

## Unified Upstreams

The `upstreams` table is the only runtime upstream store. Migration 0010
replaces the old `github_accounts` and `upstream_configs` tables, rewrites
legacy telemetry identities into upstream row ids, drops the old tables, and
clears stale model cache entries. Do not add runtime compatibility for the old
tables or prefixed identities.

`UpstreamRecord` is the persistence contract:

```text
id: string
provider: "copilot" | "custom" | "azure"
name: string
enabled: boolean
sortOrder: number
createdAt: string
updatedAt: string
config: unknown
flagOverrides: Record<string, boolean>
```

The row id is the runtime upstream identity. Do not prefix it with provider type
in usage, performance telemetry, model cache keys, or provider bindings.
Provider selection and display should use the separate `provider` field.

Provider-owned `config` JSON is intentionally opaque to the repo layer. The
control plane validates configs before save, and provider factories assert them
again before use. Malformed enabled upstream config is a real configuration
error and should surface rather than being silently skipped.

Provider config rules:

- `custom`: `baseUrl`, `bearerToken`, `authStyle` (`bearer` or `anthropic`),
  `supportedEndpoints`, and optional `pathOverrides`. `authStyle: 'bearer'`
  sends `Authorization: Bearer <token>` (OpenAI / OpenRouter /
  floway-style upstreams); `authStyle: 'anthropic'` sends
  `x-api-key: <token>` plus `anthropic-version: 2023-06-01`
  (api.anthropic.com-style upstreams). `supportedEndpoints` declares which
  chat generation protocols this upstream speaks (`/chat/completions`,
  `/responses`, `/v1/messages`); the embeddings and images endpoints are
  intentionally not configurable there — embeddings routing is decided
  per-model from `kind === 'embedding'` and images routing from
  `kind === 'image'`. An upstream that only serves embedding models
  (e.g. Voyage) or only serves image models saves with an empty
  `supportedEndpoints` array. The `/models` parser accepts OpenAI,
  Anthropic, and floway-own container / per-model shapes; entries are
  best-effort and unrecognized fields are ignored. Per-model `kind`
  resolves through a two-tier detector: Tier 1 reads `kind` from the
  upstream `/models` response when present (only floway emits it today);
  Tier 2 falls back to an id-token heuristic (see
  `apps/api/src/data-plane/providers/custom/infer-kind.ts`) — embedding
  families match common embedding tokens (`embed`, `embedding`, `bge`,
  `e5`, `gte`, `nomic`, `voyage`, ...), and the `gpt-image-*` prefix
  matches image. Other image families (`dall-e`, `imagen`, `flux`, `sdxl`,
  `stable-diffusion`) are intentionally NOT recognized; operators who run
  those models against a custom upstream need the planned per-model kind
  override. Everything else defaults to `chat`. The /models response is
  otherwise read only for display metadata
  (`display_name`/`created`/`created_at`/`owned_by`/`limits`) and an
  optional `cost` block. The provider calls upstream models by their raw
  model id. When `kind === 'image'` the provider attaches both
  `images_generations` and `images_edits` to `upstreamEndpoints`
  unconditionally; per-endpoint custom image opt-out is not modeled.
- `azure`: one `endpoint`, `apiKey`, and deployment rows. `endpoint` must be an
  HTTPS Azure URL on `*.openai.azure.com` or `*.services.ai.azure.com`; it may
  be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending
  in `/openai/v1`, or an Anthropic URL ending in `/anthropic` or
  `/anthropic/v1`; the Foundry Claude target URI ending in
  `/anthropic/v1/messages` is also accepted and normalized to the Anthropic
  base. Runtime derives protocol bases from that one field.
  OpenAI-shaped calls use `api-key` auth and append `/chat/completions`,
  `/responses`, `/embeddings`, `/images/generations`, `/images/edits`, and
  `/models` to the derived OpenAI v1 base. The image endpoints currently pin
  `?api-version=preview` because the `gpt-image-*` family is still on Azure's
  preview lifecycle; that override drops when Azure promotes the image
  endpoints to the GA default. Foundry project endpoints derive OpenAI calls
  under `/api/projects/<project>/openai/v1`. Native Messages calls use the
  resource-level `/anthropic` base and call `/v1/messages` plus
  `/v1/messages/count_tokens` with `x-api-key` auth and
  `anthropic-version: 2023-06-01`. The Azure OpenAI / Foundry OpenAI v1 surface
  is cross-provider for Foundry models such as DeepSeek, Grok, Kimi,
  Microsoft/OpenAI, and similar deployments, but it is not the Anthropic/Claude
  Messages endpoint shape. Gateway Messages requests can still route through
  Azure Chat Completions or Responses via the normal planner. Each deployment's
  `modelKey` is the deployment name; the public model id is `publicModelId` when
  non-empty and otherwise defaults to the deployment name. The dashboard edits
  Azure deployments as one row per deployment with a compact API-type preset
  (`Responses`, `Responses + Chat`, `Chat`, `Messages`, `Embeddings`,
  `Images`); code persists the provider-owned `supportedEndpoints` capability
  set. The `Images` preset covers both `/v1/images/generations` and
  `/v1/images/edits`. Azure deployment rows may also carry provider-owned
  catalog metadata such as `display_name`, limits, and `model_picker_enabled`;
  keep that metadata out of the main dashboard form unless a concrete UI
  workflow needs it. Each deployment row may also carry `flagOverrides:
  { enabled: boolean; values: Record<string, boolean> }`; when `enabled` is
  true the deployment's `values` replace the upstream layer in the
  effective-flag computation for that deployment's models. The configured
  endpoint plus API key is not enough to fetch rich Azure deployment metadata;
  Azure management-plane metadata requires ARM/AAD credentials and subscription
  resource context. Do not add a Chat+Messages Azure preset unless Azure
  documents a native deployment surface that supports both shapes; Chat source
  calls to Messages-only Claude deployments should use the existing planner
  translation.
- `copilot`: `githubToken`, `accountType`, and `user`. Copilot auth and quota
  are upstream-owned control-plane flows, not separate account resources.

`flagOverrides` is a `Record<string, boolean>` of per-upstream flag opt-ins.
Each provider kind has a default flag set declared on each catalog entry's
`defaultFor` field; `defaultsForProvider(kind)` returns the seed set. The
effective per-binding flag set is `defaults ∪ upstream.flagOverrides ∪
deployment.flagOverrides.values` resolved layer-by-layer, where a layer's
`false` removes the flag (including flags seeded by defaults) and a later
layer's `true` re-adds it. Azure deployments may additionally carry
`flagOverrides: { enabled: boolean; values: Record<string, boolean> }` to
override the upstream layer per-deployment; when `enabled` is false the
deployment layer is skipped. The flag catalog lives in
`src/data-plane/providers/flags.ts`. Copilot's structural source/target
interceptors (Claude name normalization, alias resolution, endpoint
projection, anthropic-beta filtering, Copilot request fixes) are NOT flags
— they live on the provider record and run unconditionally.

Control-plane `/api/models` is UI-owned. It may expose `provider` and
`upstream_ids` so the dashboard can group model pickers and count models per
upstream row. Public data-plane model APIs must continue to hide provider
bindings and upstream ids.

## Providers

The data plane treats every enabled upstream row as a `ModelProviderInstance`.
The LLM pipeline must not branch on provider kind. Provider methods receive the
exact `UpstreamModel` object previously returned by that provider.

Provider API shape:

```text
getProvidedModels() -> UpstreamModel[]
getPricingForModelKey(modelKey) -> ModelPricing | null
callChatCompletions(upstreamModel, bodyWithoutModel, signal?, headers?)
callResponses(upstreamModel, bodyWithoutModel, signal?, headers?)
callMessages(upstreamModel, bodyWithoutModel, signal?, headers?, anthropicBeta?)
callMessagesCountTokens(upstreamModel, bodyWithoutModel, signal?, headers?, anthropicBeta?)
callEmbeddings(upstreamModel, bodyWithoutModel, signal?, headers?)
callImagesGenerations(upstreamModel, bodyWithoutModel, signal?, headers?)
callImagesEdits(upstreamModel, formDataWithoutModel, signal?, headers?)
```

`headers` is the per-invocation HTTP header bag that target interceptors
populate. The source serve seeds it empty on the `Invocation`; target
interceptors mutate `invocation.headers` to set workaround headers (e.g.
Copilot's `copilot-vision-request`, `X-Initiator`, filtered
`anthropic-beta`); the target emit then passes that bag through to the
provider's call method unchanged. Provider implementations forward the bag
straight to their upstream fetch and never branch on protocol-specific
header semantics. Image endpoints have no target interceptor stack today
(image sources dispatch straight to the provider call method), so the
`headers` slot stays empty for them in practice — the parameter exists
only for signature parity with the other call methods.

The Messages and count_tokens calls additionally receive the source-derived
`anthropicBeta` slice as a typed read-only input separate from the wire
headers. Copilot uses it for raw variant selection (e.g. picking
`claude-*-1m-internal` when the caller sent `context-1m-2025-08-07`)
BEFORE the `withAnthropicBetaHeaderFiltered` target interceptor narrows
the wire `anthropic-beta` header down to Copilot's accepted allow-list.
Variant selection must see the caller's full intent even when the beta
value itself is dropped before hitting the wire.

`/v1/messages/count_tokens` is a one-shot, non-streaming HTTP exchange. It
runs the provider's `targetInterceptors.messagesCountTokens` chain instead
of the `messages` chain because the interceptor signature differs (terminal
result is the raw upstream `Response`, not an `ExecuteResult` of protocol
frames). The count_tokens chain contains only the header/payload mutators
that pre-Path A applied to count_tokens via the shared provider `call`
helper (vision, initiator, anthropic-beta). Chat-only Messages target
interceptors (thinking-display promotion, cache_control.scope stripping,
eager_input_streaming stripping) stay on the `messages` chain and never
run on count_tokens.

`UpstreamModel.kind` discriminates the endpoint family (`'chat'` for any
generation protocol, `'embedding'` for `/embeddings`, `'image'` for
`/images/generations` and `/images/edits`), and
`UpstreamModel.upstreamEndpoints` is the precise per-protocol availability
list used by the chat planner. Both are derived at the producer boundary and
must stay consistent: `kind === 'embedding'` ⇔ `upstreamEndpoints ===
['embeddings']`; `kind === 'image'` ⇔ `upstreamEndpoints ⊂
{images_generations, images_edits}`; `kind === 'chat'` ⇒
`upstreamEndpoints ⊂` generation endpoints. Embeddings routing in
`apps/api/src/data-plane/embeddings/serve.ts` gates on `kind === 'embedding'`;
images routing in `apps/api/src/data-plane/images/serve.ts` gates on
`upstreamEndpoints.includes('images_generations')` /
`upstreamEndpoints.includes('images_edits')`; chat planning gates on the
`upstreamEndpoints` list directly. The `kind` vocabulary
(`'chat' | 'embedding' | 'image'`) is borrowed from Together AI's open
`/v1/models` `type` enum; the full known set and the "add only when we
actually route the family" rule live in the `ModelKind` JSDoc at
`packages/protocols/src/common/models.ts`.

The registry separates public catalog data from execution bindings:

- `CatalogModel` is the public model-listing DTO. It must not expose provider
  bindings, raw upstream variants, or UI-only provider metadata.
- `ResolvedModel` extends the catalog shape with ordered `ProviderModelRecord`
  bindings for execution.
- `ProviderModelRecord` keeps the provider instance, upstream row id, exact
  `UpstreamModel`, the binding's effective `enabledFlags` set, and
  provider-registered source/target interceptors.

Request execution tries provider bindings in order only until the first binding
that can serve the requested source shape. That provider's result is final for
the request. The only fallback is provider fallback across bindings for the same
public model id. Copilot account fallback is removed. If no binding can produce
a plan, return a source-shaped unsupported-model error instead of inventing
legacy model-name routing. Source and capability handlers should loop over
provider bindings directly; do not hide provider eligibility behind
callback-based wrappers or "try-next-provider" pseudo-results.

Provider-specific behavior is registered by the provider and then executed at
the owning source or target boundary. Copilot behavior includes raw model
variant selection, Claude public-name normalization, request-alias resolution,
endpoint projection, `anthropic-beta` filtering, and Copilot upstream request
fixes. Generic source/target pipelines execute registered interceptor lists but
do not choose behavior based on provider kind.

`UpstreamModel.enabledFlags` is the effective flag set for that single model,
computed by `resolveEffectiveFlags(defaultsForProvider(providerKind),
[upstream.flagOverrides, deployment.flagOverrides?.enabled ?
deployment.flagOverrides.values : undefined])`. `ProviderModelRecord` and
`Invocation` carry the same set through to interceptors. Source-side and
target-side interceptors are flat base lists attached to every binding;
flag-gated interceptors early-return on `ctx.enabledFlags.has(flagId)` at the
top of their body. There is no assembler-level flag filtering and no
per-provider conditional registration of optional interceptors.

Messages web-search behavior is decided inside the
`withMessagesWebSearchShim` source interceptor (attached unconditionally on
every binding). Its body uses a combined gate: when the planner picked a
non-Messages target (Responses / Chat Completions) the shim ALWAYS runs,
because those targets cannot carry Anthropic server tools; when the target
is native Messages the shim runs only if `messages-web-search-shim` is in
the binding's effective flag set. The flag is a default for `copilot` and
`azure` (declared via the catalog's `defaultFor` field); Custom upstreams
opt in per-upstream, and Azure can additionally override per-deployment.

Backoff is intentionally disabled for now. Control-plane status returns empty
temporary-unavailability data until a provider-level backoff design lands.

### Pricing

`ModelMetadata.cost?: ModelPricing` carries optional per-model pricing in
`{ input, output, cache_read?, cache_write? }` shape. Values are USD per
million tokens. Field names and semantics follow the
[sst/models.dev `Cost` schema](https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts);
future fields (`reasoning`, `input_audio`, `output_audio`, tiered context)
should reuse that schema's names.

Each provider attaches pricing per upstream model and resolves
`getPricingForModelKey(modelKey)` over its own internal model id space:

- `copilot`: hardcoded table at
  `apps/api/src/data-plane/providers/copilot/pricing.ts`, keyed by the public
  model name that survives Claude variant merging. `getPricingForModelKey`
  strips Copilot raw-id variant suffixes (`-high`, `-xhigh`, `-1m`,
  `-1m-internal`, trailing date) before lookup, mirroring migration 0009.
- `azure`: per-deployment `cost` field on `AzureDeploymentConfig`,
  validated as `input` + `output` paired and `cache_read` / `cache_write`
  independently optional. `getPricingForModelKey` resolves by deployment
  name.
- `custom`: pricing flows through from the upstream `/models` response when
  it publishes a `cost` block in the same `{input, output, cache_read?,
  cache_write?}` shape (notably floway's own /models output).
  `getPricingForModelKey` resolves by raw model id against the cached list.
  Upstreams that omit `cost` are never priced — pricing returns null and
  no `cost` is attached to `UpstreamModel`. A TODO in
  `apps/api/src/shared/upstream/custom.ts` tracks future admin-supplied
  per-model pricing overrides analogous to `AzureDeploymentConfig.cost`.

Public `/models` shapes (`/v1/models`, `/models`, `/v1beta/models`) and
control-plane `/api/models` expose `cost` directly when present. Cost
aggregation in `apps/api/src/control-plane/token-usage/aggregate.ts` resolves
pricing by `(upstream, modelKey)` through the provider registry; NULL
upstream or unresolved modelKey contributes 0 to cost, matching the
pre-refactor "no rule matched" behaviour.

## Data Plane

`apps/api/src/data-plane/llm/` owns LLM source routing for Messages, Responses,
Chat Completions, Gemini generation, and source-owned token counting endpoints.
Models, embeddings, images, and data-plane tools live outside that LLM routing
graph in their capability directories.

Model listing belongs in `apps/api/src/data-plane/models/`: `/v1/models` is
OpenAI-shaped, `/models` is Anthropic-shaped, and `/v1beta/models` is
Gemini-shaped. Public data-plane model APIs consume `CatalogModel`; execution
paths use `ResolvedModel` and `ProviderModelRecord`.

The LLM execution flow is:

```text
serve -> source request cleanup -> resolve model -> provider binding loop
  -> plan from that provider's UpstreamModel
  -> provider-registered source interceptors -> build target request
  -> target interceptors -> emit through provider method
  -> translate target events to source events -> source respond
```

Use those terms. Planning is the only layer that chooses a target. Successful
execution after `emit` is event-first and should flow through protocol events
whenever practical.

Interceptors are protocol-exchange scoped, not source/target-contract scoped.
`MessagesInterceptor`, `ResponsesInterceptor`, `ChatCompletionsInterceptor`,
and `GeminiInterceptor` each have one concrete `(invocation, request, run)`
shape, whether they appear on the client/source side or the upstream/target
side. Provider source and target registrations are separate execution slots,
but they share the same protocol type for the same protocol.

Per-HTTP-request invariants live on `RequestContext`: `apiKeyId`,
`runtimeLocation`, `scheduleBackground`, `recordUsage`,
`recordRequestPerformance`, `downstreamAbortSignal`, `clientStream`,
`requestStartedAt`. Per-provider-binding-attempt request-side state lives on
`Invocation<TPayload>`: `sourceApi`, `targetApi`, the resolved model id,
provider/upstream/upstreamModel/enabledFlags, `targetInterceptors`, the
mutable source-shape `payload`, and a mutable `headers: Record<string,
string>` bag the source serve seeds empty and target interceptors populate
for the upstream HTTP call. `MessagesInvocation` additionally carries
`anthropicBeta` as a typed read-only input; the Copilot Messages target
interceptor `withAnthropicBetaHeaderFiltered` reads that field and writes
the filtered `anthropic-beta` value into `headers`. Mutable per-request
state (last performance row, downstream abort controller) is intentionally
not on either context; it lives as serve-local `let` variables and is
passed explicitly to the source responder. Raw upstream frames stay inside
target emitters and raw-to-protocol converters; protocol interceptors see
protocol request payloads and `ExecuteResult<ProtocolFrame<Event>>`
envelopes only.

Source response flow is source-owned. Each concrete source responder owns its
own upstream/internal error shaping, non-stream collection, stream terminal
observation, downstream SSE serialization, usage extraction, usage recording,
and request performance recording in forward order. Shared source helpers in
`apps/api/src/data-plane/llm/sources/respond.ts` may hold only low-level stream
state, final metadata, usage recording, and request performance helpers; they
must not accept source-specific callback tables or call back into source
behavior. Protocol `events/to-sse.ts` serializers must stay pure: they convert
source protocol frames to SSE frames and must not record usage, mutate external
state, or accept callback listeners for accounting.

LLM performance telemetry is written only after a provider binding has been
selected and a target emitter has produced a `PerformanceTelemetryContext`.
That context carries the resolved public model id (`model`), the upstream row
id (`upstream`), and the provider-owned opaque execution id (`modelKey`); it
must not be built from an unresolved client-supplied `payload.model`.
Missing-model and unsupported-endpoint source errors have no performance
context, so `recordRequestPerformanceForApiKey` no-ops for them. The
performance repo keeps successful latency samples and failures separately:
`requests` counts latency samples, `errors` counts failed attempts, and latency
buckets exist only for successful samples. Control-plane performance display
rows expose operator attempt counts as `requests + errors`, while `avgMs` and
percentile fields are computed only from successful latency samples.

Target emission is target-owned. Each concrete target emit file owns its forward
order: force target-required streaming, run target interceptors, call the
provider method, build model accounting, normalize the upstream response into
raw frames, translate raw frames into target protocol events, and preserve
target-shaped failures. Shared target helpers in
`apps/api/src/data-plane/llm/targets/emit.ts` may hold only low-level provider
body, accounting, upstream response, telemetry, and internal-error helpers;
they must not accept target-specific callback tables or call back into target
behavior.

Request translation is direct and pairwise, and it lives in the
`@floway-dev/translate` package rather than under apps/api. Do not
introduce a canonical internal request IR. Each cross-protocol pair lives
under `packages/translate/src/<source>-via-<target>/` and exposes a single
`translateXxxViaYyy: TranslateTrip<...>` from `translate.ts`. A trip function
builds the target-shape payload and returns the events translator as a closure,
so trip-scoped state (synthetic ids, custom-tool name sets, etc.) lives as
locals shared between the two halves of the trip — the source serve never sees
them. Substantive request/event helpers stay in sibling `request.ts` and
`events.ts` files so existing unit tests target them directly; small pairs may
inline. Source serves dispatch via
`viaTranslation(translateXxxViaYyy, targetEmit)` inside their
`Record<LlmTargetApi, SourceEmit<...>>` map — the map key is the only source of
truth for which target was picked. Cross-pair helpers (envelope shapers shared
between Gemini pairs, etc.) live in `packages/translate/src/shared/`.

Workarounds belong at the owning boundary:

- source request cleanup, provider-registered source interceptors, whole-flow
  retry, final response shaping, usage observation, and request performance
  recording stay under `apps/api/src/data-plane/llm/sources/<source>/` or the
  shared source responder.
- target upstream request fixes, upstream retries, target event fixes, provider
  call normalization, and target telemetry stay under
  `apps/api/src/data-plane/llm/targets/<target>/` or shared target helpers.
- provider-specific interceptor registrations live on provider records;
  concrete interceptor implementations live at the source or target boundary
  they patch.
- shared translation primitives belong in `packages/translate/src/shared/` only
  when multiple pair directions need the same protocol rule. Protocol-level
  shapes (event types, SSE envelopes) belong in
  `@floway-dev/protocols`, not in the translate package.

## Routing

Target preferences:

- Messages: native Messages, then Responses, then Chat Completions.
- Responses: native Responses, then Messages, then Chat Completions.
- Chat Completions: native Chat Completions, then Messages, then Responses.
- Gemini generation has no native upstream target in the provider API; it uses
  Chat Completions, then Messages, then Responses.
- Images (`/v1/images/generations`, `/v1/images/edits`) have no cross-provider
  translation and no planner. Each request is dispatched to the first provider
  binding whose `upstreamEndpoints` declares the requested capability. Custom
  upstreams declare both endpoints for any `kind === 'image'` model; Azure
  deployments opt in via the dashboard "Images" API-type preset.

Claude compatibility aliases and Copilot raw variant selection live in the
provider layer. Until there is a general model-alias feature, Responses rewrites
`codex-auto-review` to `gpt-5.4` with reasoning effort `low` at the Responses
source entry, before model resolution and usage/performance metadata.
Historical accounting rows are converted to the public model id only in
migrations.

## Control Plane Contracts

Public data-plane compatibility APIs are stable external contracts.
Control-plane APIs and data-plane tool management APIs are UI-owned and must
stay consistent with frontend code, tests, and auth policy.

Authentication has two roles: `admin` via `ADMIN_KEY`, and API key user via a
stored API key. Mutating key APIs and upstream management are admin-only;
`GET /api/token-usage` is intentionally visible to any authenticated user.

Upstream control-plane routes:

- `GET/POST /api/upstreams` and `PATCH/DELETE /api/upstreams/:id` manage all
  provider kinds. Mutating routes accept `flag_overrides` (a
  `Record<string, boolean>`); legacy `enabled_fixes` payloads are rejected.
- `GET /api/upstream-flags` returns the flag catalog so the dashboard can
  render the tri-state (Inherit / On / Off) Feature Flags section per
  upstream and the optional Azure per-deployment override panel.
- `POST /api/upstreams/:id/test` probes saved upstream connectivity. Custom and
  Copilot tests use model listing; Azure tests probe declared deployment
  endpoints.
- `POST /api/upstreams/copilot/auth/start` and
  `POST /api/upstreams/copilot/auth/poll` own Copilot device-flow connection.
- `GET /api/upstreams/:id/copilot/quota` reads quota for one Copilot upstream.
  Quota is shown only inside the Copilot upstream edit UI.

Do not reintroduce separate GitHub-account management routes or a top-level
Copilot quota route. Control-plane model DTOs expose `provider` as
`copilot | custom | azure`; do not emit legacy provider-kind fields.

Import/export is latest-only. Export payloads use `version: 2` and
`data.upstreams`. Import must reject missing or mismatched versions before any
mutation. It must not accept old split account/config payloads in runtime code,
and it hard-rejects upstream entries containing legacy `enabled_fixes`; the
current shape is `flag_overrides: Record<string, boolean>`.

## Errors and Style

- Preserve upstream status, headers, and body as directly as possible.
- Internal failures must expose useful debug information, including stack
  traces.
- Use explicit result unions for expected control flow.
- Keep fallback semantics strict; do not add synthetic defaults for convenience.
- Avoid `catch` for normal control flow. Use it at real boundaries: fetch,
  parsing, probing, top-level request guards, and explicit workaround retries.
- Prefer functional TypeScript, arrow functions, single quotes, and semicolons.
- ESLint is the source of truth for import order and code style. Use
  `pnpm run lint:fix` for mechanical cleanup, and keep the existing compact
  handwritten wrapping style instead of reintroducing Deno fmt-style hard
  column wrapping.
- Do not extract tiny one-off helpers unless they encode a real domain rule, are
  reused, materially simplify a flow, or need isolated tests.
- Comment only non-obvious decisions, upstream quirks, protocol mismatches, or
  references. Workaround comments should explain why the behavior exists and why
  it lives at that boundary. Use permalink URLs for external code.

## Verification

Primary commands, all run from the repo root:

```bash
pnpm run test                # vitest run over the root test.projects (all packages)
pnpm run lint                # eslint --cache across the whole workspace
pnpm run typecheck           # pnpm -r run typecheck (one tsc --noEmit per package)
pnpm run dev                 # parallel wrangler dev (8787) + vite dev (5173)
pnpm run deploy              # builds apps/web, then wrangler deploy on apps/api
pnpm run db:migrate          # apply migrations to the local D1
pnpm run db:migrate:remote   # apply migrations to the remote (production) D1
```

`dev` uses `concurrently` to run `wrangler dev` (Worker on
http://127.0.0.1:8787) and `vite` (SPA on http://localhost:5173) in the
same shell. The SPA is the one you open: Vite proxies `/api`, `/auth`,
`/v1`, `/v1beta`, `/embeddings`, and `/models` to the Worker, so the
relative-URL fetch calls in `apps/web` work identically in dev and prod.
`deploy` chains the `apps/web` build (`pnpm run build:web` → `vite build`)
before `wrangler deploy` because the Worker's Static Assets binding serves
`apps/web/dist`. To work on a single package in isolation, use pnpm filters,
e.g. `pnpm --filter @floway-dev/translate run typecheck`.

Wrangler commands should go through the local dependency with `pnpm wrangler`
or package scripts. When deploying, use `pnpm run deploy` or `pnpm wrangler
deploy` directly; do not pass `--dry-run`.

For manual data-plane validation, prefer `ADMIN_KEY` with the existing
`x-models-playground: 1` header on approved playground routes. Do not reuse or
create normal API keys for manual testing.

For Copilot-specific quirks, compare nearby Copilot gateway implementations
before inventing a new policy. For generic adapter behavior, compare at least
one Copilot gateway and one general LLM gateway. Do not cargo-cult behavior from
a single project.

## Deployment

A production deploy can disconnect the agent that triggers it, especially when
the deploy includes a D1 migration and the live schema briefly does not match
the code that the same agent is still running against. That window is hard to
avoid, so every production deploy must be a deliberate, announced step.

Always tell the user before you deploy. If the user already asked for the
deploy up front, you do not have to re-ask for confirmation, but you still
explicitly announce that the deploy is starting. Beyond that single up-front
announcement, the whole flow proceeds autonomously — no further user
confirmation between steps.

Use the three-step workflow below for every production deploy. Substitute
`<WORKER_NAME>` (the top-level `name`) and `<DB_NAME>` (the D1 binding's
`database_name`) from `wrangler.jsonc` wherever those placeholders appear in
the commands.

**Step 1 — gather current state.** Read `wrangler.jsonc` to learn
`<WORKER_NAME>` and `<DB_NAME>`, then run a single chained shell command that
reports the currently active Worker version and the D1 migration diff:

```bash
pnpm wrangler deployments list \
  && pnpm wrangler d1 migrations list <DB_NAME> --remote
```

`deployments list` shows recent deployments for `<WORKER_NAME>` with their
version ids and marks the currently active one — that gives both the active
deployment timestamp and the version id you would later roll back to.
`d1 migrations list --remote` prints applied migrations and the pending
migrations this deploy would apply, i.e. the diff between the live database
version and the target.

**Step 2 — report findings and stage the rollback.** Tell the user what Step 1
returned: the active version id, the active deployment timestamp, the latest
applied migration, and the migrations this deploy will apply (or that there
are none).

If migrations are pending, take an explicit D1 backup to a temp file outside
the repo so the working tree stays clean:

```bash
pnpm wrangler d1 export <DB_NAME> --remote \
  --output "${TMPDIR:-/tmp}/<DB_NAME>-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Report the resolved backup path to the user, then give them two rollback
commands, in this order:

- Restore the database from that dump, e.g. `pnpm wrangler d1 execute <DB_NAME>
  --remote --file <backup-path>` (drop the migrated tables first if the dump's
  `CREATE`s would collide), or `pnpm wrangler d1 time-travel restore <DB_NAME>
  --bookmark <bookmark>` if a pre-deploy bookmark was captured.
- Roll back the Worker code to the previous active version id from Step 1:
  `pnpm wrangler rollback <PREVIOUS_VERSION_ID>`.

If no migrations are pending, skip the backup and the database-rollback
command. Give the user only the code-rollback command and proceed straight to
Step 3.

**Step 3 — deploy with one chained shell command.** Migrate (when needed) and
publish the new code in the same command so the system spends as little time
as possible in an inconsistent state:

```bash
pnpm run db:migrate:remote && pnpm run deploy
```

Print this exact command to the user before running it, and tell them that if
the deploy stops halfway they can rerun the same command to recover —
`wrangler d1 migrations apply --remote` is idempotent on already-applied
migrations and `wrangler deploy` always publishes the current code regardless
of prior state. When there are no pending migrations, the command reduces to
`pnpm run deploy`.

Worker rollback by version id is supported (`pnpm wrangler rollback
<VERSION_ID>`) across the 100 most recent versions, but Cloudflare blocks
rollback when intervening deployments changed Durable Object migrations or
removed referenced KV/R2/Queue bindings. This Worker only binds D1, so plain
code rollback is currently safe; D1 state is rolled back separately as
described above.

A complete deploy fits in a strict turn budget: **three agent turns when
migrations are pending** (Step 1 = gather, Step 2 = backup + report + two
rollback commands, Step 3 = deploy) and **two agent turns when no migrations
are pending** (Step 2 has no backup work, so it collapses into the gather
turn: Turn 1 = gather + report + single code-rollback command, Turn 2 =
deploy). Do not insert extra turns to ask for confirmation along the way.
