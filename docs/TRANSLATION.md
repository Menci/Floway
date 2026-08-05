# Data Plane Translation

This document specifies Floway's translated data-plane protocols:

- Anthropic Messages generation and token counting;
- OpenAI Responses generation and compaction;
- OpenAI Chat Completions;
- Google Gemini generation, token counting, and model projection;
- Cohere-, Jina-, Voyage-, and DashScope-shaped rerank requests.

Chat-family route planning resolves a provider candidate first, then chooses a
target protocol from that candidate's `endpoints`; model resolution and target
selection are separate stages described in [RESOLUTION.md](./RESOLUTION.md).
Chat-family request/event translation is direct and pairwise and has no
canonical internal request IR. Rerank is different: its source dialects
normalize through `CanonicalRerankRequest` and a canonical result before being
rendered back to the source dialect.

Translation pair names use **X Via Y**: X is the client/source protocol and Y is
the selected upstream/target protocol. The names match directories such as
`messages-via-responses/` and `responses-via-messages/`. Provider-specific wire
quirks stay in provider-owned projection, fetch, or interceptor modules rather
than in pairwise translators.

## Boundary Rules

- Pairwise translators preserve source semantics where the target protocol has
  a natural counterpart. Fields with no target meaning are omitted rather than
  hidden in private wire bridges.
- Responses wire input accepts OpenAI's EasyInputMessage shorthand without a
  `type`. HTTP, WebSocket, and direct Responses-source translator boundaries
  normalize it to `type: "message"` before storage, interception, or
  translation; malformed untyped items are caller errors.
- Responses create and compact model open-string `prompt_cache_options` and
  `prompt_cache_retention`. Native compact projection forwards them unchanged;
  a provider that rejects one owns that wire-boundary policy.
- Explicit `prompt_cache_breakpoint` metadata on text, image, and file content
  survives canonicalization and retained-message compaction.
- Translators do not invent defaults merely to satisfy a target shape. They do
  not add translated-only `temperature: 1`, `store: false`,
  `parallel_tool_calls: true`, or `reasoning.summary: "detailed"`.
- Gateway Hono middleware and protocol interceptors are separate abstractions.
  Hono middleware owns HTTP auth, validation, logging, CORS, and top-level error
  shaping. `Interceptor<Ctx, Env, Result>` callbacks receive `(ctx, env, run)`
  around a typed protocol invocation; they can transform request payloads and
  decoded result events but never receive Hono's `Context`/`Next` pair.
- A protocol's gateway interceptor list runs whenever an invocation enters that
  protocol shape, whether it is the client source or a translated target. The
  registration files live at
  `packages/gateway/src/data-plane/chat/<protocol>/interceptors/index.ts`.
- Role compatibility is target-side within those lists, so pair sections below
  describe the translator's intermediate target shape, not an unconditional
  final wire role. Chat Completions and Responses apply enabled role rewrites
  system-to-developer, developer-to-system, then mid-conversation system-to-user.
  Messages can rewrite inline system messages because its only dedicated system
  slot is top-level `system`.
- A provider may run another typed interceptor envelope inside `call*`, after
  the gateway protocol envelope and immediately before its wire call. Provider
  registration files and their referenced implementation comments are the
  authority for wire workarounds; the provider parses upstream SSE into typed
  protocol frames before returning them. The source HTTP/WebSocket adapter
  performs final serialization only after translation back to the source.
- `anthropic-beta` belongs to the Messages source boundary. Messages ingress
  parses it into typed call metadata independently of the provider's ordinary
  inbound header allowlist. A native Messages target receives those tokens;
  translations from other source protocols supply none, and a Messages source
  translated to another target does not leak them through the ordinary header
  bag. Copilot copies the tokens into `MessagesBoundaryCtx.anthropicBeta`, lets
  its interceptor chain normalize the list, and serializes that typed value
  once at the wire terminal.
- Claude Code Messages has two provider-owned paths. A request recognized as
  Claude Code-shaped skips the re-mimicry envelope. At the candidate boundary,
  the gateway reduces ordinary inbound headers to the allowlist exported by
  that provider module; the Messages boundary carries `anthropic-beta`
  separately. The fetch path supplies Content-Type and
  provider-owned Authorization, stamps the dated provider model id, and forces
  streaming. Other clients and translated sources run the ordered re-mimicry
  chain before that fetch path. See the
  [provider branch](../packages/provider-claude-code/src/provider.ts),
  [boundary registration](../packages/provider-claude-code/src/interceptors/messages/index.ts),
  and [wire call](../packages/provider-claude-code/src/fetch.ts).
- Native Stateful Responses and affinity belong to the Responses source edge,
  outside candidate attempts. A translation whose target is Responses receives
  a no-backing scratchpad store and cannot take ownership of another source
  protocol's durable item state. See [AFFINITY.md](./AFFINITY.md).

Copilot audits build their inventory from provider registration/default code
and the `audit-copilot-workarounds` skill, including auth, model shaping,
compaction, and item-id behavior outside interceptor registries. Support
details that do not cross a translation boundary remain in those owners.

## Usage And Billing Facts

Usage translation keeps billing metrics disjoint. OpenAI-style inclusive
input totals are checked and split into uncached input, cache read, and cache
write counts; inclusive output totals are likewise split into visible output
and reasoning where the target exposes both. Negative, fractional, or
overlapping counts are rejected rather than clamped.

Messages already reports disjoint input metrics. Its flat cache-creation
total and optional 5-minute / 1-hour detail are normalized into two cache-write
buckets. Streaming `message_start` and `message_delta` usage is accumulated as
one snapshot, including late input counts and atomic replacement of the
`speed` / `service_tier` pair.

Some billing facts have no native field in every OpenAI/Gemini usage shape —
the 1-hour cache-write subset, and on Gemini a cache-write count or served
tier at all. Translation carries none of them. Pricing does not read the usage
Floway sends the client, so a fact the target protocol cannot express is not a
fact anything downstream is missing: `BillableUsage` is read from the
upstream's own usage in the upstream's own protocol, where every bucket is
native, and travels on `EventResultMetadata` rather than through translation.
A translated usage object is therefore a wire projection and nothing else, and
loses whatever the target shape has no field for.

Response-side blank, `default`, and `standard` tier markers identify base
service. Every other open-string tier is preserved byte-for-byte. Gemini
candidate and thought counts remain disjoint in `usageMetadata`; thought tokens
are billed as reasoning/output exactly once.

## Safety Refusals And Model Fallback

Anthropic Messages classifier refusals are successful Messages transports with
`stop_reason: "refusal"` and structured `stop_details`. The category is an open
string: current values are `cyber`, `bio`, `frontier_llm`,
`reasoning_extraction`, `general_harms`, and `null`, but future values must
survive native Messages parsing and reassembly unchanged. The human-readable
`explanation` is display text, not a stable discriminator.

Source protocols expose that terminal condition according to their own wire:

- Responses Via Messages is Codex-first. A `cyber` refusal becomes
  `response.failed` with `error.code: "cyber_policy"`; `bio` becomes
  `bio_policy`; every other or future category becomes the non-retryable public
  `invalid_prompt`. The upstream explanation becomes the error message. The
  biology message retains Codex's recognized biology prefix so its dedicated
  Trusted Access surface is selected. A refusal never becomes an empty
  `response.completed`.
- Chat Completions Via Messages emits the standard scalar `delta.refusal` and
  ends with `finish_reason: "stop"`. Non-stream assembly places the text in
  `message.refusal` with `message.content: null` when there was no partial text.
- Gemini Via Messages ends the candidate with `finishReason: "SAFETY"` and
  carries the explanation in standard `finishMessage`. It does not fabricate
  `safetyRatings`: Anthropic policy categories do not map honestly to Gemini's
  harm-category probabilities.
- Native Messages streaming and non-streaming preserve `stop_details`, beta
  fallback-credit fields, fallback content blocks, and `usage.iterations`.

Public OpenAI refusal output remains supported independently of the Codex
policy-failure adaptation. Responses refusal parts use the native
`response.refusal.delta` / `.done` lifecycle; Chat refusal uses
`delta.refusal`. The reverse translators restore a Messages refusal and
`stop_details.explanation` rather than turning refusal text into an ordinary
assistant text block. A Responses `cyber_policy` or `bio_policy` failure maps
back to the matching Messages category.

Anthropic server-side fallback is distinct from final refusal. A successful
fallback block updates the effective model used by translated Responses and
Chat output and is not emitted as user-visible text. Native Messages retains
the boundary at its original content position. OpenAI `safety_buffering` is a
Codex-private "still checking" signal, not an automatic-reroute record, so
Floway does not synthesize it. Floway also does not synthesize Codex's
`OpenAI-Model` cyber-reroute signal for Anthropic models because the current
Codex notice is OpenAI-model-specific. Cross-protocol clients therefore see the
fallback model and its content but not a fabricated OpenAI safety notice.

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
- Messages classifier refusal becomes `finishReason: "SAFETY"`; its
  human-readable explanation becomes candidate `finishMessage`.
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
- `safetySettings` are omitted because the available chat target protocols have
  no equivalent control.
- `candidateCount > 1` is not represented by the pairwise chat target paths; the
  gateway returns one candidate.
- Gemini response safety ratings, grounding metadata, and citation metadata are
  not synthesized from ordinary target output. Anthropic refusal categories
  likewise do not become invented Gemini safety ratings.

## Messages Via Responses

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
- `speed: "fast"` maps to `service_tier: "fast"`. When `speed` is absent,
  Messages `service_tier` passes through verbatim; other `speed` values have no
  OpenAI counterpart and are omitted.
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
  the id round-trips to a downstream Messages client.
- Responses message output text becomes Messages text blocks, and
  `function_call` output becomes Messages `tool_use`.
- Responses refusal parts become terminal Messages refusal metadata; their text
  becomes `stop_details.explanation`, not a visible text block. Responses
  `cyber_policy` and `bio_policy` failures become the corresponding Messages
  classifier-refusal categories.
- Output is emitted in Responses `output_index` order even when later text
  arrives before an earlier reasoning/tool item completes.
- completed output with a function call maps to Messages `tool_use`; other
  completed output maps to `end_turn`; max-output incomplete maps to
  `max_tokens`.
- inclusive Responses input/cache usage is split into disjoint Messages input,
  cache-read, and cache-write fields; 1-hour write detail is retained. Target
  `service_tier: "fast"` maps to Messages `speed: "fast"`; other non-null tiers
  map to Messages `service_tier`.

Known losses:

- `stop_sequences`, `top_k`, and non-fast Messages `speed` values have no
  Responses request counterpart and are omitted.
- Anthropic `thinking: { type: "enabled" }` without explicit effort has no
  Responses request-side equivalent and is not emulated.

## Responses Via Messages

Request mapping:

- `instructions` and the leading contiguous input `system` / `developer`
  prefix become top-level Messages `system`; each source and content part stays
  a separate text block. Later system/developer messages remain inline to
  preserve chronology.
- string input becomes one user message.
- user `input_text` becomes Messages text; `input_image` URLs are resolved via
  the gateway-injected external-image loader and converted to base64 image
  blocks when supported.
- assistant `output_text` becomes assistant text blocks.
- `function_call` becomes assistant `tool_use`.
- `function_call_output` becomes user `tool_result`; incomplete status marks the
  tool result as an error.
- readable `agent_message` content uses the Messages user wire role, while
  an explicit non-user-source notice and XML-escaped `<agent-message>` wrapper
  keep it from acquiring user authority. The wrapper preserves `author` and
  `recipient`. Ordinary text, image, and file payloads use their native target
  carriers; summary, reasoning, refusal, and screenshot content retains a
  typed XML boundary when projection would otherwise erase that distinction.
- `reasoning` becomes a Messages thinking carrier bound for the real Messages
  upstream, which owns and validates the signature: the genuine
  `encrypted_content` is sent verbatim with no gateway envelope — as
  `thinking.signature` when there is readable summary text, else as
  `redacted_thinking.data`. A reasoning with neither readable text nor opaque
  content has nothing the upstream can verify and is dropped; one with text but
  no opaque content becomes a `thinking` block with no signature.
- `max_output_tokens`, `temperature`, `top_p`, and `stream` pass through when
  present.
- `service_tier: "fast"` maps to Messages `speed: "fast"`; every other defined
  open-string tier passes through as Messages `service_tier`.
- `reasoning.effort: "none"` maps to disabled thinking; any other explicit
  effort maps to `output_config.effort`.
- Responses function tools become Messages tools, preserving explicit `strict`
  and `description`. Messages requires `input_schema`, so a tool that specifies
  no `parameters` gets the empty object schema.
  Freeform `custom` tools are wrapped as single-string function tools; see
  "Responses Custom Tool Wrapping".
- Responses `tool_choice` maps to the corresponding Messages tool choice when
  representable. `{type:'custom', name}` collapses onto the wrapped function
  tool name.
- Programmatic Tool Calling state is native-Responses-only: `additional_tools`,
  `program`, `program_output`, program callers and tool declarations, deferred
  tools, and forced programmatic choice are rejected rather than projected
  lossily. Native Responses paths retain these items, caller metadata, and
  opaque fingerprints whenever snapshot persistence is active. HTTP
  `store: false` writes no new state. WebSocket `store: false` writes the new
  snapshot only to session memory while still permitting durable reads.

Response mapping:

- Messages content blocks become Responses output items in source block order.
- Thinking maps to a Responses reasoning item; the upstream's genuine
  `signature` (or redacted-thinking `data`) is carried verbatim as
  `encrypted_content` under a fresh random `rs_` id.
- Messages text becomes Responses message output text, and `tool_use` becomes a
  `function_call` output item. Structured Messages search citations become
  Responses URL-citation annotations when they carry enough cited text to
  anchor an output span.
- Messages `tool_use` stop produces a completed response with function calls;
  `max_tokens` produces max-output incomplete. Classifier refusal produces a
  failed response with the Codex-compatible policy code described in "Safety
  Refusals And Model Fallback"; other normal stops complete.
- `message_start.message.model` is authoritative. A fallback boundary switches
  subsequent and terminal Responses envelopes to its `to.model` without
  becoming an output item.
- disjoint Messages cache counts are folded into inclusive Responses input
  usage while the 1-hour subset remains in the billing sidecar. Messages
  `speed: "fast"` returns as Responses `service_tier: "fast"`; otherwise
  Messages `service_tier` passes through.

Known losses:

- generic Responses `metadata` is omitted; it is not coerced into
  `metadata.user_id`.
- Responses Via Messages does not own response-level state. The native
  Responses source edge expands `previous_response_id` and stored item ids
  before invoking this translator.
- Freeform `custom` tool `format.definition` is preserved as a
  `Lark grammar: ${definition}` description on the wrapped `input` parameter;
  other `format` fields are not preserved.
- Remote image fetch failures and unsupported image media types drop that image
  rather than failing the request.
- `input_file` content and assistant-side images have no Messages counterpart
  and are rejected.

## Messages Via Chat Completions

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
- `speed: "fast"` maps to `service_tier: "fast"`; with no `speed`, Messages
  `service_tier` passes through. Other `speed` values are omitted.
- non-empty `output_config.effort` maps directly to `reasoning_effort`;
  disabled thinking maps to `reasoning_effort: "none"`; enabled thinking
  without explicit effort is omitted.
- streaming translated requests force upstream `stream_options.include_usage` so
  gateway usage telemetry can see usage.
- Messages tools become OpenAI function tools; explicit `strict` is preserved
  and omitted `strict` remains omitted.
- Messages `tool_choice` maps to OpenAI `tool_choice` where representable.

Response mapping:

- the first Chat choice becomes the Messages assistant stream; later choices are
  dropped because Messages has no multi-candidate response shape.
- Chat scalar `reasoning_text` and `reasoning_opaque` become Messages thinking
  or redacted-thinking blocks in source order.
- Chat content becomes Messages text blocks; tool calls become `tool_use`
  blocks. Text interleaved inside streamed tool arguments is deferred until the
  tool block closes so trailing argument fragments remain valid.
- Chat `delta.refusal` is accumulated into Messages
  `stop_details.explanation`; its terminal stop reason is `refusal`, even though
  native Chat ends a generated refusal with `finish_reason: "stop"`.
- inclusive Chat prompt usage is split into plain input, cache-read, and
  cache-write Messages fields; 1-hour cache-write detail is retained. Target
  `service_tier: "fast"` maps to Messages `speed: "fast"`; other non-null tiers
  map to Messages `service_tier`.
- Chat `tool_calls` finish maps to Messages `tool_use`, `length` maps to
  `max_tokens`, and `content_filter` maps to `refusal`. A `stop` carrying prior
  refusal deltas also maps to `refusal`; an ordinary `stop` maps to `end_turn`.

Known losses:

- multiple Messages thinking blocks in request history cannot be represented
  losslessly in legacy Chat scalar fields. Later groups are omitted rather than
  aggregated or mismatched.
- assistant-side images have no Chat request counterpart and are omitted.
- `top_k`, non-fast `speed`, and other Messages-only request fields without Chat
  counterparts are omitted.
- Chat response choices after index zero are omitted.

## Chat Completions Via Messages

Request mapping:

- the leading contiguous Chat `system` / `developer` prefix becomes top-level
  Messages `system`, preserving each source content part as a separate text
  block. Later instruction messages remain inline in chronological order.
- Chat user text and supported images become Messages user blocks. Remote images
  are resolved through the same gateway-injected external-image loader.
- Chat assistant `content` becomes assistant text.
- Chat assistant scalar `reasoning_text` / `reasoning_opaque` becomes one
  `thinking` block or one `redacted_thinking` block.
- Chat assistant `tool_calls` become Messages `tool_use` blocks.
- Chat `tool` messages become Messages `tool_result` blocks.
- `max_tokens`, `temperature`, `top_p`, `stop`, `stream`, tools, and tool choice
  map where representable.
- `service_tier: "fast"` maps to Messages `speed: "fast"`; every other defined
  open-string tier passes through as Messages `service_tier`.
- OpenAI function tools preserve explicit `strict`; omitted `strict` stays
  omitted.

Response mapping:

- Messages text deltas become Chat assistant `content`; `tool_use` blocks become
  indexed Chat `tool_calls`.
- Messages classifier refusal becomes Chat `delta.refusal`, followed by the
  standard terminal `finish_reason: "stop"`. It is not flattened into visible
  assistant content or mislabeled as `content_filter`.
- only the first Messages thinking/redacted-thinking block is projected into the
  scalar Chat `reasoning_text` / `reasoning_opaque` fields. Opaque-only state
  remains opaque rather than becoming fake readable reasoning.
- disjoint Messages input/cache usage is folded into inclusive Chat prompt
  usage, with 1-hour cache-write detail retained internally. Messages
  `speed: "fast"` returns as Chat `service_tier: "fast"`; otherwise Messages
  `service_tier` passes through.
- Messages `tool_use` stop maps to Chat `tool_calls`, `max_tokens` maps to
  `length`, and other terminal reasons map to `stop`. A fallback boundary
  updates the serving model on subsequent chunks. The Messages terminal becomes
  the Chat `[DONE]` sentinel.

Known losses:

- Chat `message.name`, legacy `user`, generic metadata, and `n` have no Messages
  request counterpart and are omitted. The returned Chat stream always uses
  choice index zero.
- Chat `reasoning_items[]` is not a Messages bridge; readable summaries in that
  shape are used only by Chat Completions Via Responses and Responses Via Chat
  Completions.
- Chat image `detail` is not represented in Messages.
- Messages structured citation deltas and later thinking groups have no legacy
  Chat response representation and are omitted.

## Chat Completions Via Responses

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

- every readable Responses reasoning output item is preserved in Chat
  `reasoning_items[]`; the first scalar-eligible group also projects to
  `reasoning_text`. No Chat `reasoning_opaque` is synthesized.
- Responses message output text becomes Chat assistant content; Responses
  refusal parts become Chat `delta.refusal`. Function calls become Chat
  `tool_calls`.
- Responses output is held in `output_index` order when later visible output
  finishes before earlier reasoning/tool output.
- max-output incomplete maps to Chat `finish_reason: "length"`; completed with
  tool calls maps to `tool_calls`; other completed responses map to `stop`.

Known losses:

- Chat `stop` has no Responses request counterpart and is omitted.
- legacy Chat `user` is omitted on translated Chat/Responses paths.
- opaque Responses reasoning state has no Chat output field; only readable
  summaries survive the target response.

## Responses Via Chat Completions

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
- readable `agent_message` content uses one Chat user wire message with the
  same non-user-source notice and selective typed XML boundaries as the
  Messages target.
- `max_output_tokens`, `stream`, `temperature`, `top_p`, `metadata`, `store`,
  `parallel_tool_calls`, `prompt_cache_key`, `safety_identifier`,
  `service_tier`, and explicit `reasoning.effort` pass through when present.
- Responses `text.format` maps directly to Chat `response_format`; `text: {}`
  omits `response_format`, while `text: null` stays explicit `null`.
- Responses function tools become Chat function tools, preserving explicit
  `strict`, `parameters`, and `description`. Chat has no `null` spelling, so an
  unspecified one is omitted rather than forwarded.
  Freeform `custom` tools are wrapped as single-string function tools; see
  "Responses Custom Tool Wrapping".
- Programmatic Tool Calling state handling is identical to Responses Via
  Messages (see above).

Response mapping:

- Chat `reasoning_items[]` entries with readable summaries are preferred and
  become Responses reasoning output items. Without one, scalar
  `reasoning_text` becomes one reasoning item; scalar `reasoning_opaque` is
  ignored.
- Chat assistant content becomes one Responses message output item, and Chat
  tool calls become Responses `function_call` output items.
- Chat `delta.refusal` becomes a Responses message item with refusal content and
  the native `response.refusal.delta` / `.done` lifecycle. Refusal text does not
  enter the Responses `output_text` convenience projection.
- output items are emitted in source order by `output_index`.
- Chat `finish_reason: "length"` maps to Responses incomplete; other finish
  reasons produce a completed response.

Known losses:

- Responses request-level `reasoning` has no Chat request counterpart except
  explicit effort.
- Responses Via Chat Completions does not own response-level state. The native
  Responses source edge expands `previous_response_id` and stored item ids
  before invoking this translator, with readable reasoning ids then carried
  through `reasoning_items[]`.
- Freeform `custom` tool `format.definition` handling is identical to Responses
  Via Messages (see below).
- Lifting tool-output images into a user message changes their speaker role but
  keeps the visual bytes usable on Chat targets.
- `input_file` message/tool-output content and assistant-side files or images
  have no Chat counterpart and are rejected.
- File-id-only images cannot be materialized by the pure translator and are
  rejected. Image `detail` is forwarded verbatim and the target decides what it
  accepts; an absent or null value becomes an omitted key, which both protocols
  read as `auto`.
- opaque Responses reasoning state is not requested, translated, or preserved on
  Chat fallback paths.

## Responses Custom Tool Wrapping

Responses Freeform `custom` tools have no Messages or Chat Completions
counterpart. Responses Via Messages and Responses Via Chat Completions wrap each
currently declared `custom` tool as a function tool whose only input is a
required string:

```json
{ "type": "object", "additionalProperties": false,
  "required": ["input"], "properties": { "input": { "type": "string" } } }
```

Chat Completions wrappers set `strict: false`; the Messages wrapper uses the
same input schema. If `format.definition` is a non-empty string, regardless of
other `format` fields, it becomes the `input` property's description prefixed
with `Lark grammar: `. Other format fields are not projected.

The request translator returns the set of custom tool names declared on that
turn alongside the target payload. The matching events translator uses that
set to distinguish a wrapped function/tool call from an ordinary function
call. It buffers the complete JSON arguments, then extracts a string `input`;
invalid JSON, a missing field, or a non-string field falls back to the raw
arguments blob. At close it emits a `custom_tool_call` item, one
`response.custom_tool_call_input.delta` when the recovered input is non-empty,
and a `.done` event. Partial JSON cannot produce safe freeform deltas.

A named custom tool choice maps to the target's named function/tool choice.
Historical `custom_tool_call` input becomes a wrapped call with
`{"input": <freeform>}`, and string `custom_tool_call_output` becomes target
tool-result history. Multimodal custom outputs are rejected rather than
flattened. Native Responses targets receive custom declarations, choices, and
history unchanged.

## Streaming Semantics

- Anthropic-shaped streams never expose `[DONE]` to Messages clients.
- Chat-shaped streams use OpenAI `data:` chunks and may expose a final
  usage-only chunk only when the caller requested it.
- Responses-shaped streams use named Responses SSE events with monotonically
  increasing `sequence_number`.
- Responses refusal content uses the complete output-item/content-part/refusal
  lifecycle. Codex policy failures instead terminate with `response.failed`;
  they never emit a contradictory `response.completed`.
- Chat Completions Via Responses buffers scalar reasoning until it knows whether
  `reasoning_items[]` will be used, avoiding orphan or duplicated Responses
  reasoning items.
- Responses Via Chat Completions and Responses Via Messages preserve output order
  when later visible output arrives before earlier reasoning/tool output is
  complete.
- Chat Completions Via Messages keeps opaque-only reasoning in source order and
  flushes pending final usage before `message_stop`. Chat `reasoning_opaque` and
  Messages `signature_delta` values are replacement snapshots, not string
  fragments to concatenate.
- Tool/function argument streams guard against infinite whitespace in generated
  arguments and emit an error rather than continuing a degenerate stream.

## Reasoning Policy

- Messages Via Responses and Responses Via Messages preserve genuine opaque
  signature/encrypted-content carriers alongside readable reasoning where the
  two protocols provide matching replay slots.
- Chat Completions Via Responses and Responses Via Chat Completions preserve
  readable summaries only. Chat `reasoning_items[]` carries every readable
  Responses group; legacy scalar `reasoning_text` represents the first eligible
  group. No Responses opaque state is projected through Chat.
- Gemini Via Responses ignores opaque signatures and carries readable thought
  summaries only. Gemini Via Messages and Gemini Via Chat Completions may use
  their native `thoughtSignature` compatibility slots.
- Messages Via Chat Completions and Chat Completions Via Messages may carry
  Anthropic opaque thinking through Chat `reasoning_opaque`; that is the
  Messages/Chat compatibility surface, not a Responses bridge.
- Floway affinity and native Responses persistence remain outside pure
  translators; their source-boundary behavior is documented in
  [AFFINITY.md](./AFFINITY.md).

## Standard OpenAI Field Policy

For Chat Completions Via Responses and Responses Via Chat Completions,
same-purpose OpenAI fields pass through directly where both APIs define them:

- `metadata`
- `store`
- `parallel_tool_calls`
- `response_format` / `text.format`
- `prompt_cache_key`
- `safety_identifier`
- `service_tier`
- explicit `reasoning_effort` / `reasoning.effort`

These fields are not bridged through Anthropic Messages-only paths unless the
Messages API has an explicit equivalent.

## Alias Rule Application

Alias rules live on `ModelCandidate.rules`. After target selection and any
translation, the terminal chat wire call passes that exact overlay to one
`applyRulesToUpstream<Target>` helper. The helper mutates the selected target
protocol's native payload immediately before provider dispatch. Gemini is a
source only, so its rules land on the selected Chat Completions, Messages, or
Responses target.

Pairwise translators remain source-native Via target-native and never carry
alias extensions. A rule with no native target slot is dropped; projecting it
onto a merely similar field would misstate the operator's intent.

| rule | Chat Completions target | Messages target | Responses target |
|---|---|---|---|
| `reasoning.effort` | `reasoning_effort` | `output_config.effort` | `reasoning.effort` |
| `reasoning.budget_tokens` | dropped | `thinking.budget_tokens` + `thinking.type: 'enabled'` | dropped |
| `reasoning.adaptive` | dropped | `thinking.type: 'adaptive'` when true | dropped |
| `reasoning.summary` | dropped | mapped to `thinking.display`; `auto` omits the override | `reasoning.summary` |
| `verbosity` | `verbosity` | dropped | `text.verbosity` |
| `serviceTier` | `service_tier` | `speed: 'fast'` for `fast`, otherwise `service_tier` | `service_tier` |

Embeddings, Images, Audio Transcriptions, and Rerank have no rule-application
step and their non-chat alias schemas require empty rules. OpenAI Completions
also has no application step, but it resolves `kind: 'chat'`; a chat alias can
therefore carry non-empty rules that Completions intentionally ignores. See
[RESOLUTION.md](./RESOLUTION.md) for candidate and endpoint selection.

## Rerank Translation

Rerank is non-streaming JSON but not a passthrough protocol: four strict
source routes normalize into `CanonicalRerankRequest`, and each custom manual
model selects one of six target wires.

| public route | source protocol | target protocols |
|---|---|---|
| `/v1/rerank` | Cohere v1 | Cohere v1/v2, Jina v1, Voyage v1, DashScope compatible/native |
| `/v2/rerank` | Cohere v2 | same set |
| `/jina/v1/rerank` | Jina v1 | same set |
| `/voyage/v1/rerank` | Voyage v1 | same set |

The IR keeps the query, ordered source documents, top-N intent,
return-documents intent, and the source protocol's representable optional
controls. Jina text objects can become JSON text on string-only targets. Jina
image queries or documents narrow the candidate pool to Jina and DashScope
native targets, which preserve their multimodal objects; text-only dialects
are never asked to reinterpret an image as text. A ranked result normalizes to
`(index, relevanceScore)` plus optional document and embedding data.
Cross-protocol output reconstructs returned documents from the original
indexed source array, preventing a target-specific document wrapper from
leaking onto the source wire.

Same-dialect calls preserve opaque request fields while replacing only the
model id, and forward the successful upstream response body unchanged. A
cross-dialect success is parsed strictly and rendered in the source envelope.
All non-2xx upstream responses keep their status, body, and forwardable
headers unchanged.

Cohere's `meta.billed_units.search_units` records `rerank_searches`, while any
reported token total records `input_tokens`. The two counters are independent:
when a response reports both, both metrics are retained and each uses its own
configured per-search or per-token rate. A metric without a configured rate is
stored with a null unit price, and a settled response with no metric still
records its request count.
