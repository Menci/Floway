# Data Plane Translation

This document describes the current translation behavior between the four
client-facing data-plane APIs:

- Anthropic Messages: `POST /v1/messages`
- OpenAI Responses: `POST /v1/responses`
- OpenAI Chat Completions: `POST /v1/chat/completions`
- Google Gemini: `POST /v1beta/models/{model}:generateContent`,
  `POST /v1beta/models/{model}:streamGenerateContent`,
  `POST /v1beta/models/{model}:countTokens`, and `GET /v1beta/models`

Route planning uses provider-owned model capability data from
`supported_endpoints`. Request translation is direct and pairwise; there is no
canonical internal request IR. Provider-specific quirks live in provider-owned
model projection or provider interceptor collections rather than inside pairwise
translators.

## Routing

`/v1/messages` selects:

1. native `/v1/messages`
2. translated `/responses`
3. translated `/chat/completions`

`/v1/responses` selects:

1. native `/responses`
2. translated `/v1/messages`
3. translated `/chat/completions`

`/v1/chat/completions` selects:

1. native `/chat/completions`
2. translated `/v1/messages`
3. translated `/responses`

If no upstream's catalog advertises a capability-backed Chat target, the gateway
returns a source-shaped unsupported-model error. It does not invent legacy
model-name routing outside provider capability metadata. Copilot Claude models
still route through Messages because the Copilot provider does not expose Chat
support for them.

`/v1beta/models/{model}:generateContent` and
`/v1beta/models/{model}:streamGenerateContent` select:

1. translated `/chat/completions`
2. translated `/v1/messages`
3. translated `/responses`

If no upstream's catalog advertises a capability-backed Gemini generation target,
the gateway returns a Gemini-shaped unsupported-model error.

## Boundary Rules

- Pairwise translators preserve source semantics where the target API has a
  natural counterpart.
- Responses wire input accepts OpenAI's EasyInputMessage shorthand without a
  `type` field. HTTP, WebSocket, and direct Responses-source translator
  boundaries normalize it to an explicit `type: "message"` before storage,
  interception, or translation. Malformed untyped items are rejected as caller
  input errors at the same boundary.
- Responses create and compact request shapes model open-string
  `prompt_cache_options` and `prompt_cache_retention`. Native compact projection
  forwards both controls verbatim; provider-specific rejection remains a
  boundary workaround (Codex strips `prompt_cache_retention`).
- Explicit `prompt_cache_breakpoint` metadata on text, image, and file content
  survives canonicalization and retained-message compaction.
- Translators do not synthesize defaults merely to satisfy a target shape.
  Examples: no translated-only `temperature: 1`, `store: false`,
  `parallel_tool_calls: true`, or `reasoning.summary: "detailed"`.
- Fields with no natural target-side meaning are omitted instead of encoded
  into private bridges.
- Each protocol has one gateway-side interceptor list that runs once when the
  request enters the gateway in that protocol's shape. A Messages interceptor
  sees a Messages request and Messages result/events whether Messages is the
  source the client sent or the target the upstream serves; Responses, Chat
  Completions, and Gemini follow the same rule.
- Role compatibility is target-only within those lists, so translator bullets
  describe the intermediate target shape rather than an unconditional final
  wire role. Chat Completions and Responses apply enabled role rewrites in the
  fixed order system-to-developer, developer-to-system, then interleaved
  system-to-user. Messages can demote every inline system message to user
  because its only first-position system slot is the top-level `system` field.
- Each provider runs its own boundary interceptor chain inside its `call*`
  method, after the gateway-side chain and immediately before the wire. The
  boundary chain owns provider-specific quirks: image compression, header
  shaping (`copilot-vision-request`, `x-initiator`, anthropic-beta filtering),
  field stripping (Copilot Responses `service_tier`, `image_generation`,
  `store: false` forcing), Copilot Messages `cache_control.scope` scrubbing,
  and similar.
- The provider parses raw upstream frames into typed protocol events before
  returning to the gateway, so every interceptor sees decoded events, not
  SSE bytes. The HTTP / WebSocket adapter at the gateway boundary owns the
  final wire shaping after the protocol events have been translated back to
  the source-protocol shape.

## Usage And Billing Facts

Usage translation keeps billing dimensions disjoint. OpenAI-style inclusive
input totals are checked and split into uncached input, cache read, and cache
write counts; inclusive output totals are likewise split into visible output
and reasoning where the target exposes both. Negative, fractional, or
overlapping counts are rejected rather than clamped.

Messages already reports disjoint input dimensions. Its flat cache-creation
total and optional 5-minute / 1-hour detail are normalized into two cache-write
buckets. Streaming `message_start` and `message_delta` usage is accumulated as
one snapshot, including late input counts and atomic replacement of the
`speed` / `service_tier` pair.

Some billing facts have no native field in every protocol. A symbol-keyed
`USAGE_BILLING` sidecar carries cache-write TTL detail and the served tier only
inside Floway's typed event pipeline. Translation and stream reassembly retain
it, while JSON serialization omits it from client responses. Consequently a
fact may survive a Chat, Responses, Messages, or Gemini intermediate shape
without inventing a private wire field.

Response-side blank, `default`, and `standard` tier markers identify base
service. Every other open-string tier is preserved byte-for-byte. Gemini
candidate and thought counts remain disjoint in `usageMetadata`; thought tokens
are billed as reasoning/output exactly once.

## Boundary Workarounds

### Messages — gateway interceptors

- rejects body-level `anthropic_beta` and `betas`; Anthropic beta flags are
  accepted only from the `anthropic-beta` HTTP header and passed to Messages
  providers as a separate parameter
- after planning, rewrites native Anthropic `web_search_*` server tools into a
  gateway-executed client-tool shim when the selected provider/target requires
  it, decodes shim-owned replay history back into upstream `search_result`
  blocks, and rewrites shim-owned search results/citations back to native
  Messages shape. The shim is enabled by default for Copilot Messages targets
  too, because Copilot search is executed by the gateway. `count_tokens`
  performs the same request preparation without the generation-only response
  stream rewrite.
- strips reserved `x-anthropic-billing-header` prompt-attribution lines and
  `cch=<hash>` cache markers that some clients inline into the `system`
  prompt; these are opaque to every upstream and poison prompt-cache prefix
  hashes
- strips stray `[DONE]` sentinels from Anthropic-shaped streams

Messages generation and `count_tokens` apply billing-attribution stripping,
forced-tool reasoning compatibility, inline-system role compatibility, and
web-search request preparation in the same order. Token counts therefore see
the same gateway-level compatibility shape as generation; each provider still
owns any operation-specific wire-boundary transforms.

### Messages — Copilot provider boundary chain

- promotes upstream `thinking.display` during active thinking to avoid Copilot
  Messages idle gaps, then preserves downstream omitted-thinking semantics
- whitelists supported `anthropic-beta` values on the wire
- auto-adds `interleaved-thinking-2025-05-14` when budget thinking requires it
- strips unsupported per-tool `eager_input_streaming`
- strips unsupported `cache_control.scope` before calling Copilot native
  Messages. Custom Messages providers receive the caller's `cache_control`
  object unchanged.
- rewrites Copilot context-window errors into the compact Messages error shape

### Messages — Claude Code provider boundary chain

Claude Code (Claude.ai subscription) bills `/v1/messages` requests against
the operator's plan only when the wire matches a real `claude-cli` session.
The boundary detects already-CC-shaped traffic up front and lets it pass
through verbatim, so the operator's own session fingerprint reaches
Anthropic untouched. Anything else — third-party Messages clients, other
adapters, translated Chat/Responses/Gemini sources — runs through the full
re-mimicry chain so the upstream still accepts and bills it as plan
traffic.

Re-mimicry runs in this order:

- backfills required `max_tokens` and `temperature` defaults so the rest of
  the chain and the downstream fingerprint compute see the fully-formed CC
  wire shape
- synthesizes `metadata.user_id` (legacy `user_<sha>_account_<uuid>_session_<uuid>`
  or new JSON `{device_id, account_uuid, session_id}` shape, picked from the
  inbound request) before system text is hoisted, so two conversations
  sharing a system prompt do not collide on session id
- hoists the caller's `system` text into a synthetic user/assistant pair so
  the next three injectors own `payload.system`
- injects `system[0]`: per-request CC billing/identity block carrying the
  `cc_version` fingerprint and a `cch=<hash>` cache marker (sha256 + slice
  algorithm, salt `59cf53e54c78`, indices `[4, 7, 20]` — verified unchanged
  v2.1.10 → v2.1.181)
- injects `system[1]`: canonical CC identity text
- injects `system[2]`: cached boilerplate default template, marked
  `cache_control: { type: "ephemeral" }`. Demoted to non-cached when the
  caller is already at the cache-breakpoint cap.

Header shaping (UA, `X-Stainless-*`, `anthropic-beta`) and the dated
upstream model id are set in the provider's fetch path, not as interceptor
steps.

### Responses — gateway flow and interceptors

- resolves `previous_response_id` and every `item_reference` through the
  gateway's Responses store before candidate dispatch. Affinity is classified
  from each referenced item's stored type, then the candidate rewrite replaces
  every reference with its durable payload. Same-upstream items recover their
  upstream wire id; portable items receive a temporary id when needed. A
  missing durable payload returns `item_not_found`, and no provider receives an
  `item_reference` carrier.

- executes hosted `web_search` and `image_generation` through the server-tool
  shim for translated targets and native Responses providers that opt in. Each
  hosted family validates every declaration, selects the last complete alias
  and configuration, injects one collision-resolved function, executes the
  configured backend, and restores the selected hosted declaration plus a
  matching hosted `tool_choice` in synthesized echoes. Azure and Copilot return
  the same last-wins result for reversed web-search controls, matching Azure's
  hosted image-generation behavior
  ([probe evidence](https://github.com/Menci/Floway/pull/172#issuecomment-4971739422)).
  Image edit sources are flattened in declaration order from message content,
  function/custom tool output, and replayed image-generation results. Remote
  HTTP(S) sources are downloaded once during request preparation through the
  shared external-image loader, with manual redirect handling, bounded
  streaming, public-address-only Node egress, and Azure-compatible errors for
  download and image-format failures. The original URL remains visible to the
  orchestrator while cached bytes are reused by the edit backend. Inline and
  remote masks are materialized by the same path. A mask `file_id` remains an
  explicit `unsupported_image_source` because it requires the owning
  upstream's authenticated Files namespace. GIF sources are transcoded to WebP
  for `/images/edits`, and a mask alone supplies edit context for `auto`/`edit`.
- removes unsupported `image_generation` Responses tool entries and forced
  tool choices that targeted them before target request construction. Other
  hosted/deferred Responses tools, including `web_search`, `tool_search`, and
  `namespace`, remain visible to native Responses targets. Translated
  Messages/Chat targets currently narrow tool conversion to `function` and
  Freeform `custom` tools; the hosted/deferred translated semantics are
  tracked separately.
- preserves Freeform `custom` tools: native Responses targets receive them
  directly; translated targets wrap them as single-string function tools (see
  "Responses Custom Tool Wrapping").
- retries intermittent upstream `cyber_policy` failures before the failed
  attempt reaches the source-shaped response

### Responses — Copilot provider boundary chain

The same boundary runs for both `/v1/responses` (streaming) and
`/v1/responses/compact` (non-streaming).

- strips unsupported `service_tier`
- removes the `image_generation` tool entry (Copilot does not host it)
- forces `store: false` on the wire — the gateway always owns Responses
  persistence; the original `store` is captured by the entry adapter before
  the chain runs, so durable storage is unaffected
- compresses inline base64 image data URLs to WebP across canonical message,
  function-output, and custom-output content; remote URLs and file IDs remain
  unchanged
- injects `copilot-vision-request` when any of those canonical content arrays
  carries an image, and derives `x-initiator` from the final canonical item
  (missing/falsy roles and `assistant` are agent turns; other role-bearing
  items are user turns)
- on `/v1/responses` only: synchronizes mismatched stream output item IDs

### Responses — Codex provider boundary chain

Codex (ChatGPT subscription) only serves Responses; Messages, Chat
Completions, and Gemini reach Codex through translation. The same boundary
runs for streaming `/v1/responses` and non-streaming `/v1/responses/compact`.
The compact action is narrowed to the compact request shape and dispatched
directly to the subscription backend's `/codex/responses/compact` endpoint.

Codex enables `promote-system-to-developer` by default. While that effective
flag remains enabled, the target Responses interceptor rewrites input messages
from `role: "system"` to `role: "developer"`. It changes only the role; item
order, content-part boundaries, ids, and status remain intact. This also covers
a multi-block Messages `system` field after generic translation has preserved
it as one multi-part input message. Native Responses instructions, Gemini
`systemInstruction`, and a string or single-block Messages `system` stay in the
top-level `instructions` field; input messages are never folded into it. The
provider's default-instructions step below remains independent. The developer
representation matches the official Codex Responses Lite wire:
https://github.com/openai/codex/blob/1f17e7512f0e47625f2cad416f14870688a99814/codex-rs/core/src/client.rs#L829-L849

The Codex boundary then runs these steps:

- injects a neutral default only when `instructions` is absent, `null`, or an
  empty string. Other malformed external values pass through so the upstream
  owns validation. Current ChatGPT-subscription catalog models reject empty or
  missing instructions (implementation record:
  https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579)
- strips fields the upstream rejects with `Unsupported parameter`:
  `max_output_tokens`, `temperature`, `top_p`, `frequency_penalty`,
  `presence_penalty`, `user`, `metadata`, `prompt_cache_retention`,
  `safety_identifier`, `stream_options`
- injects a stable `session-id` header derived from
  `(instructions + first user-message text)` so the upstream prompt cache
  hits across turns of the same conversation (~88% input-token cache hit
  measured against gpt-5.4)

### Chat Completions — gateway interceptors

- forces upstream streaming usage when needed for gateway usage telemetry.
  The Chat source still only exposes final usage-only SSE chunks to clients
  when the caller requested `stream_options.include_usage: true`. Hidden
  upstream usage is preserved separately for gateway telemetry.

### Gemini — gateway interceptors

- removes unsupported `fileData`, `executableCode`, and `codeExecutionResult`
  part fields before target request construction
- removes unsupported Gemini tool capabilities such as `googleSearch`,
  `codeExecution`, URL context, file search, MCP servers, and maps, keeping
  only function declarations
- drops `safetySettings`, which has no upstream target control
- hides `thought: true` summary parts by default; they are only returned
  when `generationConfig.thinkingConfig.includeThoughts === true`. Opaque
  `thoughtSignature` values are preserved when the target is Messages or
  Chat (which carry them through `signature` / `reasoning_opaque`), but are
  not translated into Responses reasoning state.
- shapes errors as Google RPC Status payloads while preserving internal
  debug fields for gateway failures

## Gemini Source

Request mapping shared by the Gemini source translation pairs:

- URL model IDs from `/v1beta/models/{model}:...` become the target request
  model after normal model resolution.
- `contents[].role: "user"` becomes user input; `contents[].role: "model"`
  becomes assistant/model output history.
- text parts map to target text blocks/messages.
- supported `inlineData` images (`image/jpeg`, `image/png`, `image/gif`, and
  `image/webp`) map to target image inputs where the target supports them.
- `systemInstruction.parts[].text` becomes the target system/instructions field,
  joined with blank lines.
- `functionCall` maps to target tool/function calls. Missing Gemini function
  call IDs are replaced with deterministic `gemini_call_<turn>_<part>` IDs so
  later `functionResponse` parts can be paired.
- `functionResponse` maps to target tool/function results. When the response
  lacks an ID, the translator pairs it with the earliest unmatched call of the
  same function name, then falls back to a deterministic ID.
- Gemini `thought: true` text maps to target readable reasoning/thinking.
- Gemini `thoughtSignature` maps to Messages `signature` / `redacted_thinking`
  or Chat `reasoning_opaque` when those targets are selected. Responses targets
  ignore Gemini opaque signatures and keep only readable thought text.
- `thinkingBudget` and `thinkingLevel` map to the target's closest reasoning or
  thinking controls. Budget `0` disables thinking via Messages
  `thinking.disabled`, Responses `reasoning.effort: "none"`, or Chat
  `reasoning_effort: "none"`; positive budgets choose low/medium/high effort
  where the target only supports effort levels. When both controls are present,
  the numeric budget takes precedence on Chat and Responses; Messages preserves
  its native budget and the level in separate fields. Without a budget,
  explicit `thinkingLevel` strings, including empty and future values, pass
  verbatim to the target's open-string effort slot for upstream validation.
- `maxOutputTokens`, `temperature`, `topP`, `topK`, `stopSequences`,
  `presencePenalty`, `frequencyPenalty`, `seed`, `responseMimeType`, and
  `responseSchema` are passed through when the selected target has a natural
  field.
- Gemini function declarations become target function/tool definitions;
  `functionCallingConfig` maps to the closest target tool-choice control.

Response mapping shared by the Gemini source translation pairs:

- Target text output becomes Gemini model content text parts.
- Target reasoning summaries or thinking deltas become Gemini thought-summary
  parts internally, then the Gemini gateway interceptors remove them unless
  the client explicitly requested `includeThoughts: true`.
- Target opaque reasoning signatures from Messages or Chat become Gemini
  `thoughtSignature` attached to the next visible text or function-call action
  part. Responses targets do not emit opaque Gemini signatures; only readable
  reasoning summaries become thought-summary parts.
- Target tool/function calls become Gemini `functionCall` parts.
- Target usage maps to Gemini `usageMetadata`; cache reads and writes remain
  separate, while reasoning/thinking tokens map to `thoughtsTokenCount` and do
  not overlap `candidatesTokenCount`.
- Gemini streaming emits data-only SSE chunks containing full
  `GenerateContentResponse` objects and does not emit a `[DONE]` sentinel.
- Gemini non-streaming responses are assembled from source-shaped Gemini event
  streams.

Gemini models and token counting:

- `GET /v1beta/models` and `GET /v1beta/models/{model}` translate the merged
  provider model list to Gemini model objects with `generateContent`,
  `streamGenerateContent`, and `countTokens` generation methods.
- `POST /v1beta/models/{model}:countTokens` translates the Gemini request shape
  through the Messages count-tokens path.

Known losses:

- `fileData`, executable-code parts, code-execution results, cached content,
  Gemini Files API URIs, native code execution, grounding/citation metadata, URL
  context, file search, maps, computer use, and MCP server tools have no current
  upstream target equivalent and are omitted.
- `googleSearch` is currently dropped by the Gemini gateway interceptors;
  future work should route it through the existing web-search shim.
- `safetySettings` are omitted because the Copilot targets do not expose
  equivalent safety controls.
- `candidateCount > 1` is not supported by the Copilot targets; the gateway
  returns one candidate.
- Gemini response safety ratings, grounding metadata, and citation metadata are
  not synthesized from ordinary target output.

## Messages To Responses

Request mapping:

- a string or single text-block `system` maps directly to Responses
  `instructions`. A multi-block `system` becomes one leading `role: "system"`
  input message with a separate `input_text` part for each source block, so the
  generic translation preserves block boundaries.
- user text and images become Responses `message` input content.
- user `tool_result` blocks become `function_call_output` items, preserving
  source order relative to user text by splitting input items when necessary.
- assistant text becomes `message` items with `output_text` content.
- assistant `tool_use` blocks become `function_call` items.
- assistant `thinking` and `redacted_thinking` blocks become `reasoning` input
  items. The carrier (`thinking.signature` or `redacted_thinking.data`) is
  unpacked from the `${encrypted_content}@${id}` shape this gateway emits: the
  Responses reasoning id and any opaque `encrypted_content` are recovered. A
  native signature carrying no `@` is preserved verbatim as `encrypted_content`
  with a fresh random `rs_` id; it is never overwritten.
- `max_tokens`, `temperature`, `top_p`, `metadata`, and `stream` pass through
  when present.
- `output_config.effort` maps directly to `reasoning.effort`; disabled thinking
  maps to `reasoning.effort: "none"`; enabled thinking without explicit effort
  is omitted.
- Messages tools become Responses function tools. Omitted Messages `strict`
  becomes Responses `strict: false`, preserving non-strict default behavior.
- `tool_choice` maps `auto` -> `auto`, `any` -> `required`, named tool -> named
  function, and `none` -> `none`.

Response mapping:

- Responses `reasoning` output becomes a Messages carrier with the reasoning id
  and any `encrypted_content` packed as `${encrypted_content}@${id}`: readable
  summary text yields a `thinking` block (packed value in `signature`); no
  readable text yields a `redacted_thinking` block (packed value in `data`), so
  the id always round-trips to a downstream Messages client.
- assistant text becomes `message` output items and contributes to
  `output_text`.
- assistant `tool_use` becomes `function_call` output items.
- `max_tokens` stop maps to `status: "incomplete"`; other normal stops map to
  `status: "completed"`.
- cache reads and total cache writes map to Responses
  `input_tokens_details`; 1-hour write detail remains in the internal billing
  sidecar.
- Output item order follows the original assistant block order.

Known losses:

- `stop_sequences`, `top_k`, and Messages `service_tier` have no Responses
  request counterpart and are omitted.
- Anthropic `thinking: { type: "enabled" }` without explicit effort has no
  Responses request-side equivalent and is not emulated.

## Responses To Messages

Request mapping:

- `instructions` and the leading contiguous input `system` / `developer`
  prefix become top-level Messages `system`; each source and content part stays
  a separate text block. Later system/developer messages remain inline to
  preserve chronology.
- string input becomes one user message.
- user `input_text` becomes Messages text; `input_image` URLs are resolved via
  the gateway-injected platform external-resource loader and converted to
  base64 image blocks when supported.
- assistant `output_text` becomes assistant text blocks.
- `function_call` becomes assistant `tool_use`.
- `function_call_output` becomes user `tool_result`; incomplete status marks the
  tool result as an error.
- `reasoning` becomes a Messages thinking carrier bound for the real Messages
  upstream, which owns and validates the signature: the genuine
  `encrypted_content` is sent verbatim with no gateway envelope — as
  `thinking.signature` when there is readable summary text, else as
  `redacted_thinking.data`. A reasoning with neither readable text nor opaque
  content has nothing the upstream can verify and is dropped; one with text but
  no opaque content becomes a `thinking` block with no signature.
- `max_output_tokens`, `temperature`, `top_p`, and `stream` pass through when
  present.
- `reasoning.effort: "none"` maps to disabled thinking; any other explicit
  effort maps to `output_config.effort`.
- Responses function tools become Messages tools, preserving explicit `strict`.
  Freeform `custom` tools are wrapped as single-string function tools; see
  "Responses Custom Tool Wrapping".
- Responses `tool_choice` maps to the corresponding Messages tool choice when
  representable. `{type:'custom', name}` collapses onto the wrapped function
  tool name.
- Programmatic Tool Calling state is native-Responses-only: `additional_tools`,
  `program`, `program_output`, program callers and tool declarations, deferred
  tools, and forced programmatic choice are rejected rather than projected
  lossily. Native Responses paths retain these items, caller metadata, and
  opaque fingerprints whenever snapshot persistence is active; HTTP
  `store: false` disables snapshots, while WebSocket `store: false` keeps them
  only in the current session's memory.

Response mapping:

- Responses output items are converted in output order.
- `reasoning` maps to a Messages thinking carrier; the upstream's genuine
  `signature` (or `redacted_thinking` `data`) is carried verbatim as the
  reasoning item's `encrypted_content`, with a fresh random `rs_` id.
- `message` content maps to text. `refusal` content is kept visible as text
  because Messages has no local refusal block.
- `function_call` maps to `tool_use`.
- `completed` maps to `end_turn` or `tool_use`; max-output incomplete maps to
  `max_tokens`.
- cached reads and writes are subtracted from Anthropic `input_tokens` and
  exposed as `cache_read_input_tokens` and cache-creation usage, retaining
  1-hour write detail.

Known losses:

- generic Responses `metadata` is omitted; it is not coerced into
  `metadata.user_id`.
- Pure Responses-to-Messages translation does not own response-level state.
  The API data plane expands `previous_response_id` and stored item ids before
  invoking this translator.
- Freeform `custom` tool `format.definition` is preserved as a
  `Lark grammar: ${definition}` description on the wrapped `input` parameter;
  other `format` fields are not preserved.
- Remote image fetch failures and unsupported image media types drop that image
  rather than failing the request.
- `input_file` content and assistant-side images have no Messages counterpart
  and are rejected.

## Messages To Chat Completions

Request mapping:

- top-level Messages `system` becomes a leading Chat `system` message.
- user text and images become Chat user content.
- user `tool_result` blocks become Chat `tool` messages. Mixed user text and
  tool results are split into multiple Chat messages to preserve source order.
- assistant text becomes Chat assistant `content`.
- assistant `tool_use` blocks become OpenAI `tool_calls`.
- assistant `thinking` / `redacted_thinking` projects only the first
  source-order scalar reasoning group into Chat `reasoning_text` /
  `reasoning_opaque`.
- `max_tokens`, `stop_sequences` -> `stop`, `stream`, `temperature`, and `top_p`
  pass through when present.
- non-empty `output_config.effort` maps directly to `reasoning_effort`;
  disabled thinking maps to `reasoning_effort: "none"`; enabled thinking
  without explicit effort is omitted.
- streaming translated requests force upstream `stream_options.include_usage` so
  gateway usage telemetry can see usage.
- Messages tools become OpenAI function tools; explicit `strict` is preserved
  and omitted `strict` remains omitted.
- Messages `tool_choice` maps to OpenAI `tool_choice` where representable.

Response mapping:

- assistant text blocks concatenate into Chat assistant `content`.
- `tool_use` blocks become `tool_calls`.
- only the first source-order reasoning group is projected into scalar Chat
  reasoning fields.
- usage maps to Chat prompt/completion tokens; cache reads and total cache
  writes use the OpenAI usage fields, with 1-hour write detail carried
  internally.
- `tool_use` stop maps to `tool_calls`; `max_tokens` maps to `length`; other
  normal stops map to `stop`.

Known losses:

- multiple Messages thinking blocks cannot be represented losslessly in legacy
  Chat scalar fields. Later groups are omitted rather than aggregated or
  mismatched.
- assistant-side images have no Chat counterpart and are omitted.
- `top_k`, `service_tier`, and other Messages-only fields are omitted.

## Chat Completions To Messages

Request mapping:

- the leading contiguous Chat `system` / `developer` prefix becomes top-level
  Messages `system`, preserving each source content part as a separate text
  block. Later instruction messages remain inline in chronological order.
- Chat user text and supported images become Messages user blocks. Remote images
  are resolved through the same gateway-injected external-resource loader.
- Chat assistant `content` becomes assistant text.
- Chat assistant scalar `reasoning_text` / `reasoning_opaque` becomes one
  `thinking` block or one `redacted_thinking` block.
- Chat assistant `tool_calls` become Messages `tool_use` blocks.
- Chat `tool` messages become Messages `tool_result` blocks.
- `max_tokens`, `temperature`, `top_p`, `stop`, `stream`, tools, and tool choice
  map where representable.
- OpenAI function tools preserve explicit `strict`; omitted `strict` stays
  omitted.

Response mapping:

- multiple Chat choices are merged into one Messages response.
- scalar reasoning blocks are emitted before text, and text before tool use.
- scalar opaque-only reasoning becomes `redacted_thinking` rather than fake
  readable thinking.
- Chat usage maps to Messages usage; cached prompt reads and writes become the
  corresponding disjoint Messages cache fields.

Known losses:

- Chat `message.name`, legacy `user`, and generic Chat metadata are omitted on
  translated Messages paths.
- Chat `reasoning_items[]` is not a Messages bridge; readable summaries in that
  shape are only used for the Chat <-> Responses path.
- Chat image `detail` is not represented in Messages.
- Multiple choices lose choice index and separation.

## Chat Completions To Responses

Request mapping:

- only the initial contiguous Chat `system` prefix becomes Responses
  `instructions`.
- later `system` messages and all `developer` messages remain ordered Responses
  input messages.
- user content becomes Responses user input content.
- assistant text becomes Responses assistant `output_text` content.
- assistant `tool_calls` become `function_call` input items.
- Chat `tool` messages become `function_call_output` input items.
- Chat `reasoning_items[]` entries with readable summaries are preferred over
  scalar reasoning. If absent, scalar `reasoning_text` becomes one Responses
  `reasoning` item; scalar `reasoning_opaque` is ignored.
- `temperature`, `top_p`, `max_tokens` -> `max_output_tokens`, `metadata`,
  `stream`, `store`, `parallel_tool_calls`, `prompt_cache_key`,
  `safety_identifier`, and `service_tier` pass through when present.
- `reasoning_effort` maps directly to `reasoning.effort` only when explicit.
- `response_format` maps directly to Responses `text.format`, including explicit
  `null`.
- OpenAI function tools become Responses tools. Explicit `strict` is preserved;
  omitted Chat `strict` becomes Responses `strict: false`.

Response mapping:

- Chat `reasoning_items[]` entries with readable summaries are preferred over
  scalar reasoning and become Responses reasoning output items.
- scalar `reasoning_text` becomes one Responses reasoning output item when no
  readable carrier is present; scalar `reasoning_opaque` is ignored.
- Chat content becomes one Responses `message` output item.
- Chat tool calls become Responses `function_call` output items.
- terminal Responses output is ordered by `output_index`, not completion time.
- `length` maps to `status: "incomplete"`; other finish reasons map to
  `completed`.

Known losses:

- Chat `stop` has no Responses request counterpart and is omitted.
- legacy Chat `user` is omitted on translated Chat/Responses paths.

## Responses To Chat Completions

Request mapping:

- `instructions` becomes a leading Chat `system` message.
- string input becomes a user message.
- input `message` items become Chat messages with matching roles.
- input `reasoning` items with readable summaries attach to the surrounding
  assistant message as `reasoning_items[]`; the first scalar-eligible group also
  projects to `reasoning_text`.
- `function_call` items become assistant `tool_calls`.
- `function_call_output` items become text-only Chat `tool` messages. Because
  Chat tool messages do not admit image parts, tool-output images are grouped
  after the contiguous tool-result run in one synthesized user image message;
  each tool call's image group is preceded by its source `call_id` label.
  The synthesized message's legal Chat `user` role is authoritative at provider
  boundaries, so a final lifted-image turn is reported as user-initiated even
  though its image originated in tool output; no out-of-band provenance
  contradicts the wire role.
- `max_output_tokens`, `stream`, `temperature`, `top_p`, `metadata`, `store`,
  `parallel_tool_calls`, `prompt_cache_key`, `safety_identifier`,
  `service_tier`, and explicit `reasoning.effort` pass through when present.
- Responses `text.format` maps directly to Chat `response_format`; `text: {}`
  omits `response_format`, while `text: null` stays explicit `null`.
- Responses function tools become Chat function tools, preserving `strict`.
  Freeform `custom` tools are wrapped as single-string function tools; see
  "Responses Custom Tool Wrapping".
- Programmatic Tool Calling state is native-Responses-only: `additional_tools`,
  `program`, `program_output`, program callers and tool declarations, deferred
  tools, and forced programmatic choice are rejected rather than projected
  lossily. Native Responses paths retain these items, caller metadata, and
  opaque fingerprints whenever snapshot persistence is active; HTTP
  `store: false` disables snapshots, while WebSocket `store: false` keeps them
  only in the current session's memory.

Response mapping:

- Responses `message` output text becomes Chat assistant `content`; refusal text
  is kept visible as text.
- Responses `function_call` output becomes Chat `tool_calls`.
- every Responses reasoning output item with readable summary text is preserved
  in Chat `reasoning_items[]`.
- legacy scalar `reasoning_text` projects only the first scalar-eligible
  reasoning group; no `reasoning_opaque` value is synthesized from Responses
  reasoning.
- max-output incomplete maps to Chat `finish_reason: "length"`; completed with
  tool calls maps to `tool_calls`; other completed responses map to `stop`.

Known losses:

- Responses request-level `reasoning` has no Chat request counterpart except
  explicit effort.
- Pure Responses-to-Chat translation does not own response-level state. The API
  data plane expands `previous_response_id` and stored item ids before invoking
  this translator, with readable reasoning ids then carried through
  `reasoning_items[]`.
- Freeform `custom` tool `format.definition` is preserved as a
  `Lark grammar: ${definition}` description on the wrapped `input` parameter;
  other `format` fields are not preserved.
- Lifting tool-output images into a user message changes their speaker role but
  keeps the visual bytes usable on Chat targets.
- `input_file` message/tool-output content and assistant-side files or images
  have no Chat counterpart and are rejected.
- File-id-only images cannot be materialized by the pure translator and are
  rejected. Chat image detail supports only `auto`, `low`, and `high`; other
  Responses values such as `original` are rejected.
- opaque Responses reasoning state is not requested, translated, or preserved on
  Chat fallback paths.

## Responses Custom Tool Wrapping

Responses Freeform `custom` tools have no Anthropic or Chat Completions
counterpart. The Responses-to-Messages and Responses-to-Chat-Completions
translators wrap each `custom` tool as a single-string function tool with the
schema:

```json
{ "type": "object", "additionalProperties": false,
  "required": ["input"], "properties": { "input": { "type": "string" } } }
```

When the source `custom` tool provides `format.definition` (the Lark grammar
source), the translator copies it into the `input` parameter's `description`
prefixed with `Lark grammar: ` so target models still see what shape the
freeform value should follow. Other `format` fields (`type`, `syntax`, ...)
are not preserved. Tool names get tracked per trip; the events translator
recognizes wrapped function calls coming back from the target by name,
unwraps the `input` field from the JSON arguments blob, and projects the
result as `custom_tool_call` output items plus
`response.custom_tool_call_input.delta` / `.done` events to the Responses
caller. Wrapped tool-call argument deltas are buffered and emitted as a single
input delta at stop time because freeform values cannot be safely split out of
partial JSON. Tool choice referencing a `custom` tool maps to the
function-shape choice for the wrapped target. Historical `custom_tool_call` /
`custom_tool_call_output` input items are projected into the wrapped
function-tool history shape so multi-turn conversations remain coherent.

Native Responses targets continue to receive `custom` tools, tool choices, and
historical custom tool call items unchanged.

## Streaming Semantics

- Anthropic-shaped streams never expose `[DONE]` to Messages clients.
- Chat-shaped streams use OpenAI `data:` chunks and may expose a final
  usage-only chunk only when the caller requested it.
- Responses-shaped streams use named Responses SSE events with monotonically
  increasing `sequence_number`.
- Chat -> Responses stream translation buffers scalar reasoning until it knows
  whether `reasoning_items[]` will be used, avoiding orphan or duplicated
  Responses reasoning items.
- Responses -> Chat and Responses -> Messages stream translation preserve output
  order when later visible output arrives before earlier reasoning/tool output
  is complete.
- Chat -> Messages stream translation keeps opaque-only reasoning in source
  order and flushes pending final usage before `message_stop`. Chat
  `reasoning_opaque` and Messages `signature_delta` values are replacement
  snapshots, not string fragments to concatenate.
- Tool/function argument streams guard against infinite whitespace in generated
  arguments and emit an error rather than continuing a degenerate stream.

## Reasoning Policy

- Translated Responses paths keep readable reasoning summaries and omit opaque
  encrypted reasoning state.
- Chat `reasoning_items[]` carries readable Responses reasoning summaries when
  Chat is the fallback protocol.
- legacy Chat scalar reasoning fields represent exactly one readable scalar
  group on Chat <-> Responses paths: `reasoning_text` only.
- Messages <-> Chat may still carry Anthropic opaque thinking through Chat
  `reasoning_opaque`, because that is a Messages/Chat compatibility surface and
  not a Responses encrypted-reasoning bridge.
- Floway affinity and native Responses persistence remain outside pure
  translators; their source-boundary behavior is documented in
  [AFFINITY.md](./AFFINITY.md).

## Standard OpenAI Field Policy

For translated Chat <-> Responses paths, same-purpose OpenAI fields pass through
directly where both APIs define them:

- `metadata`
- `store`
- `parallel_tool_calls`
- `response_format` / `text.format`
- `prompt_cache_key`
- `safety_identifier`
- explicit `reasoning_effort` / `reasoning.effort`

These fields are not bridged through Anthropic Messages-only paths unless the
Messages API has an explicit equivalent.

## Alias Rule Application

Alias rules apply **post-translate**, on the target IR, at the terminal
wire call. Each chat target has one `applyRulesToUpstream<Target>` helper
(`applyRulesToUpstreamChatCompletions`, `applyRulesToUpstreamMessages`,
`applyRulesToUpstreamResponses`) that reads `ctx.aliasRules` and writes
each rule onto the target protocol's native slot before dispatch. Gemini
is inbound-only — Gemini requests translate to a chat target, and the
rules apply on that chosen target.

Cross-protocol translation itself is pure native ↔ native; the
translators never lift or lower alias rules. A rule that has no native
slot on the chosen target is silently dropped by design — the wire has
nowhere to put it, and forcing the rule through a nearby field would
mean lying about what the operator asked for.

The mapping from `AliasRules` fields onto target-protocol slots:

| rule | -> Chat Completions | -> Messages | -> Responses |
|---|---|---|---|
| `reasoning.effort` | `reasoning_effort` | `output_config.effort` | `reasoning.effort` |
| `reasoning.budget_tokens` | dropped | `thinking.budget_tokens` + `thinking.type: 'enabled'` | dropped |
| `reasoning.adaptive` | dropped | `thinking.type: 'adaptive'` | dropped |
| `reasoning.summary` | dropped | `thinking.display` (`summarized` / `omitted`) | `reasoning.summary` |
| `verbosity` | `verbosity` | dropped | `text.verbosity` |
| `serviceTier` | `service_tier` | `speed: 'fast'` for `'fast'`, else `service_tier` | `service_tier` |

Passthrough endpoints (`/v1/embeddings`, `/v1/images/*`,
`/v1/completions`) have no rule-application step; a passthrough alias
must be seeded with empty rules (enforced at write time by a zod
refinement on the alias schema).
