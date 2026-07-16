# Data-plane translation

Floway exposes four chat-shaped source APIs:

- Anthropic Messages;
- OpenAI Responses, including compact and WebSocket transports;
- OpenAI Chat Completions;
- Google Gemini generate and count-token actions.

Translation is direct and pairwise. There is no canonical request IR. A
translation trip converts one complete source request to one target request and
returns an event mapper that converts decoded target events back to the source
protocol. Provider-specific behavior belongs in provider boundary chains;
Floway-specific affinity and Responses persistence belong in gateway source
membranes outside `packages/translate`. Affinity wire behavior is documented in
[AFFINITY.md](./AFFINITY.md).

## Route planning

Target preference is selected from the chosen candidate's advertised endpoint
metadata:

| Source operation | Target preference |
| --- | --- |
| Messages generate | Messages → Responses → Chat Completions |
| Messages count tokens | Messages only |
| Responses generate | Responses → Messages → Chat Completions |
| Responses compact | Responses → Messages → Chat Completions |
| Chat Completions | Chat Completions → Messages → Responses |
| Gemini generate | Chat Completions → Messages → Responses |
| Gemini count tokens | Messages only |

Gemini is source-only: no provider exposes a native Gemini target. A candidate
without an endpoint required by the operation is removed before attempt
dispatch. Model resolution is documented in [RESOLUTION.md](./RESOLUTION.md).

## General translation rules

- Responses EasyInputMessage shorthand is canonicalized to explicit
  `type: "message"` at HTTP, WebSocket, and translator source boundaries.
- Malformed untyped Responses items are caller input errors.
- Open-string fields pass through where the target has the same semantic slot;
  translators do not narrow future values onto a closed vendor enum.
- `prompt_cache_options`, `prompt_cache_retention`, and explicit
  `prompt_cache_breakpoint` metadata survive native Responses canonicalization
  and compact history retention.
- Translators do not add convenience defaults such as `temperature: 1`,
  `store: false`, `parallel_tool_calls: true`, or an unsolicited reasoning
  summary mode.
- Fields without a meaningful target slot are omitted or rejected rather than
  hidden in private translator metadata.
- Every gateway protocol interceptor list operates on that protocol shape
  wherever it appears in the trip. Provider boundary interceptors run later,
  inside the chosen provider's `call*` method.
- Providers return decoded protocol events. Only the final source adapter
  serializes JSON/SSE/WebSocket frames.

## Usage and billing

Usage dimensions are disjoint. OpenAI-style inclusive input totals are split
into uncached input, cache reads, and cache writes; inclusive output totals are
split into visible output and reasoning when both are available. Invalid
negative, fractional, or overlapping counts fail instead of being clamped.

Messages already reports disjoint input dimensions. Its flat cache-creation
total and optional 5-minute / 1-hour detail are normalized into separate write
buckets. Streaming `message_start` and `message_delta` usage is accumulated as
one snapshot, with late input counts and atomic replacement of tier fields.

Some billing facts have no public field in every protocol. A symbol-keyed
`USAGE_BILLING` sidecar carries cache-write TTL detail and selected tier only
inside the typed pipeline. JSON serialization omits it. Blank, `default`, and
`standard` tier markers mean Base; every other open string is retained.

## Gateway and provider boundary workarounds

### Messages gateway boundary

- rejects body-level `anthropic_beta` and `betas`; beta flags belong in the
  `anthropic-beta` header;
- rewrites native web-search tools into the configured gateway shim when the
  selected target cannot execute them, including `count_tokens` request
  preparation;
- strips reserved billing-attribution and cache-marker prompt lines;
- applies forced-tool reasoning and inline-system compatibility;
- removes stray `[DONE]` sentinels from Messages-shaped streams.

### Copilot Messages boundary

- promotes active `thinking.display` to avoid idle gaps while retaining
  downstream omitted-thinking semantics;
- whitelists supported Anthropic beta headers and adds
  `interleaved-thinking-2025-05-14` when required;
- removes unsupported eager input streaming and `cache_control.scope`;
- rewrites Copilot context-window errors into the compact Messages shape.

### Claude Code Messages boundary

Already Claude-Code-shaped traffic passes through. Other Messages-shaped
traffic is rebuilt to match the CLI wire:

- required max-token and temperature defaults are supplied;
- `metadata.user_id` is synthesized in the appropriate legacy or JSON form;
- caller system text is hoisted into a synthetic exchange;
- the billing/identity block, canonical CLI identity, and cached boilerplate
  system blocks are injected;
- provider fetch code owns user-agent, Stainless, beta, and dated-model headers.

### Responses gateway boundary

- executes hosted web search and image generation through the shared
  server-tool shim where the selected target lacks the native tool;
- validates hosted declarations and preserves last-complete configuration;
- downloads remote image/edit sources through the bounded external-resource
  loader; Node pins DNS to public addresses;
- removes unsupported hosted image tools before translated target construction;
- wraps Freeform custom tools for Messages/Chat targets;
- retries transient upstream `cyber_policy` failures before source rendering.

### Copilot Responses boundary

The same chain serves generate and compact:

- removes unsupported `service_tier` and native image-generation tools;
- forces upstream `store: false`; Floway's source store remains authoritative;
- compresses inline images to WebP;
- injects `copilot-vision-request` and derives `x-initiator` from canonical
  item roles;
- synchronizes mismatched streamed output item IDs on generate.

### Codex Responses boundary

Codex only serves Responses. It promotes system input roles to developer by
default, adds neutral instructions only when the request has none, removes
parameters rejected by the subscription backend, and derives a stable
`session-id` from instructions plus the first user-message text. Native compact
dispatches to `/codex/responses/compact`; translated compact uses the gateway
shim when the target is not Responses.

### Chat Completions gateway boundary

Upstream usage is requested when needed for telemetry. A streaming Chat source
only receives a final usage-only chunk when it explicitly requested
`stream_options.include_usage`.

### Gemini gateway boundary

- removes unsupported file, executable-code, code-result, tool, and safety
  fields before translation;
- hides readable thought parts unless `includeThoughts` is true;
- renders source errors as Google RPC Status while retaining debug fields for
  gateway failures.

## Gemini source translation

Shared request behavior:

- the URL model ID becomes the target model after normal resolution;
- user/model contents become user/assistant history;
- text, supported inline images, function calls, and function responses map to
  target-native equivalents;
- missing function-call IDs use deterministic
  `gemini_call_<turn>_<part>` IDs, and ID-less responses match the earliest
  unmatched same-name call;
- `systemInstruction` text becomes target system/instructions text;
- `thought: true` text maps to readable target reasoning;
- `thoughtSignature` maps to Messages signature or Chat `reasoning_opaque`;
  Responses translation keeps readable thought but has no pure signature
  bridge;
- thinking budget/level maps to the closest target control. Budget zero means
  no reasoning; positive budgets map to effort when the target has no numeric
  budget. Open-string levels pass through for upstream validation;
- sampling, output-limit, stop, schema, and function-choice controls map only
  where a target has a natural slot.

Shared response behavior:

- text becomes model text parts;
- readable target reasoning becomes thought parts, later hidden unless the
  caller requested it;
- Messages and Chat opaque snapshots become a signature on the next visible
  action part, or a signature-only part when no action follows;
- tools become `functionCall` parts;
- usage becomes `usageMetadata`, with cache and thought counts disjoint;
- streaming emits data-only `GenerateContentResponse` objects and no `[DONE]`.

`GET /v1beta/models` and the per-model route translate Floway catalog metadata
to Gemini generation methods. `:countTokens` translates through Messages
counting.

Unsupported Gemini file APIs, cached-content IDs, native code execution,
grounding metadata, URL context, maps, computer use, and MCP server tools are
omitted. `candidateCount > 1` is not supported by current upstream targets.

## Messages → Responses

Request mapping:

- a string or one text-block system value becomes `instructions`; multiple
  blocks become one leading system input message with separate parts;
- user text/images become message content;
- tool results become ordered `function_call_output` items;
- assistant text and tools become message and function-call items;
- thinking/redacted blocks become reasoning items. The translator's
  `${encrypted_content}@${id}` interop carrier recovers a Responses item ID
  where present; a native signature without `@` becomes `encrypted_content`
  with a synthetic local reasoning ID;
- output limits, sampling, metadata, and stream controls map where defined;
- explicit Messages effort maps to Responses effort; disabled thinking maps to
  `none`;
- Messages tools and tool choice map to Responses function shapes.

Response mapping:

- Responses reasoning becomes Messages thinking or redacted thinking; the
  translator packs the Responses item ID with its opaque content so a Messages
  client can round-trip both through a protocol that has no item-ID slot;
- text and function calls map in output order;
- max-token stop becomes incomplete;
- usage retains cache-read and cache-write dimensions.

The `${encrypted_content}@${id}` bridge is trip-local translation state.

Messages stop sequences, top-k, and Messages-only tier controls have no
Responses request slot. Enabled thinking without explicit effort is not
invented on Responses.

## Responses → Messages

Request mapping:

- instructions and the leading system/developer prefix become top-level
  Messages system blocks; later instruction messages remain inline;
- string input becomes a user message;
- user text/images, assistant text, function calls, and function outputs map to
  their Messages counterparts;
- reasoning sends the genuine restored `encrypted_content` to the target
  Messages provider as `thinking.signature` or `redacted_thinking.data`;
- limits, sampling, effort, tools, wrapped custom tools, and representable
  tool-choice values map directly;
- Programmatic Tool Calling state is rejected on translated targets rather
  than projected lossily.

Response mapping converts Messages blocks back in source order. Native thinking
signatures become Responses reasoning encrypted content with a trip-local ID;
text and tool use become message and function-call items; stop and usage fields
map to Responses semantics.

The translator never expands `previous_response_id` or gateway item IDs. The
native Responses source membrane completes that work before invoking the trip.
Remote image failures drop the image; input files and assistant-side images
without a Messages counterpart are rejected.

## Messages → Chat Completions

Request mapping:

- system, user text/images, and tool results become their Chat counterparts;
- assistant text blocks are concatenated and tool calls are collected, so
  text/tool interleaving collapses to scalar text followed by the tool list;
- the first non-empty readable reasoning is retained, while later
  thinking/redacted blocks can replace the scalar `reasoning_opaque` snapshot;
- limits, sampling, stop, tools, and representable tool choice map directly;
- explicit effort maps to `reasoning_effort`; disabled thinking maps to
  `none`.

Response mapping buffers parallel Chat tool drafts and emits them as sequential
Messages tool blocks. Only after the complete tool run does it emit deferred
text/reasoning, preserving arrival order among those deferred segments. Other
text and tool argument fragments concatenate; stop reasons and usage map
directly.
When visible content, a tool-call start, or finish closes a thinking block, an
already-available signature is emitted inside that block. A signature that
arrives after the boundary becomes a later standalone redacted block. Assistant
images remain lossy.

## Chat Completions → Messages

Request mapping:

- the leading system/developer prefix becomes top-level Messages system;
- supported user images are resolved through the external-resource loader;
- assistant scalar reasoning becomes one thinking or redacted block;
- Chat tool calls/results become Messages tool use/results;
- limits, sampling, stop, tools, and strictness map where representable.

Response mapping projects the first Messages reasoning block onto Chat scalar
reasoning, concatenates text, maps sequential tool blocks to indexed Chat tool
call deltas, and translates stop/usage fields. Later Messages reasoning blocks
are not representable in Chat's scalar response shape.

Chat name/user/generic metadata and image detail are omitted where Messages has
no native equivalent.

## Chat Completions → Responses

Request mapping:

- the initial system prefix becomes instructions; later system/developer
  messages remain ordered input messages;
- user and assistant content map to Responses messages;
- Chat tool calls/results map to function call/output items;
- readable `reasoning_items[]` is preferred. Otherwise scalar
  `reasoning_text` becomes one reasoning item; scalar opaque state is not a
  pure Responses bridge;
- standard OpenAI request fields, effort, format, function tools, and
  strictness map directly where both protocols define them.

Response mapping produces reasoning items, message output, function calls, and
terminal state ordered by `output_index`. Scalar opaque Chat state is ignored
by the pure translator.

Chat stop sequences and legacy user have no Responses counterpart.

## Responses → Chat Completions

Request mapping:

- instructions become a leading system message;
- string/message input becomes Chat messages;
- readable Responses reasoning summaries become `reasoning_items[]` and the
  first scalar-eligible group also becomes `reasoning_text`;
- function calls/outputs map to assistant tools and tool messages;
- tool-output images are lifted after the contiguous tool-result run into one
  user image message, labelled by call ID;
- standard OpenAI fields, effort, formats, tools, and wrapped custom tools map
  where representable;
- Programmatic Tool Calling state is rejected on translated targets.

Response mapping returns Chat text, tools, readable reasoning items, the first
scalar reasoning group, finish reason, and usage. The translator does not
synthesize Chat opaque reasoning from Responses state. Input files,
assistant-side files/images, file-ID-only images, and unsupported image detail
values are rejected.

## Freeform custom tools

Responses Freeform `custom` tools have no Messages or Chat equivalent.
Translations wrap each as a function with one required string property:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["input"],
  "properties": { "input": { "type": "string" } }
}
```

`format.definition` is included as `Lark grammar: ...` in that property's
description. The trip records wrapped tool names, buffers the complete JSON
argument value, extracts `input`, and maps it back to Responses custom-tool
events. Historical calls/results and custom tool choice use the same wrapper.
Native Responses targets receive custom tools unchanged.

## Streaming semantics

- Messages streams never expose `[DONE]`.
- Chat streams end with `[DONE]`; usage-only chunks remain conditional on the
  source request.
- Gemini streams contain complete response chunks and no sentinel.
- Responses streams use named events and monotonic sequence numbers.
- Chat non-stream reassembly is per choice. Readable strings concatenate,
  opaque reasoning snapshots replace, tools merge by tool index, and extras
  remain isolated per choice.
- Messages thinking text concatenates while signatures replace.
- Responses `output_item.done` replaces the item snapshot and terminal response
  events replace the complete response snapshot.
- Pairwise translators preserve source output order even when target items
  complete out of order.
- Tool/custom argument guards reject infinite whitespace or malformed partial
  JSON instead of silently producing empty calls.

## Reasoning policy

Readable reasoning is translated where the target has a natural field. Opaque
state is never guessed. Pairwise Messages/Chat and Messages/Responses bridges
carry native values needed by the target protocol.

Chat `reasoning_opaque` and Messages `signature_delta` are replacement
snapshots. Gemini thought signatures belong to parts. Responses encrypted
content belongs to an item. These semantics are protocol contracts, not
interchangeable string-fragment conventions.

## Standard OpenAI fields

Chat ↔ Responses translation passes same-purpose fields directly where both
APIs define them:

- metadata;
- store;
- parallel tool calls;
- response format / text format;
- prompt cache key;
- safety identifier;
- explicit reasoning effort;
- service tier where defined.

These fields are not tunneled through Messages when Messages has no native
equivalent.

## Alias rule application

Alias rules are applied after translation on the terminal target IR. Pure
translation never lifts or lowers them.

| Rule | Chat Completions | Messages | Responses |
| --- | --- | --- | --- |
| `reasoning.effort` | `reasoning_effort` | `output_config.effort` | `reasoning.effort` |
| `reasoning.budget_tokens` | omitted | enabled thinking budget | omitted |
| `reasoning.adaptive` | omitted | adaptive thinking | omitted |
| `reasoning.summary` | omitted | `thinking.display` | `reasoning.summary` |
| `verbosity` | `verbosity` | omitted | `text.verbosity` |
| `serviceTier` | `service_tier` | fast mode or `service_tier` | `service_tier` |

A rule with no target slot is omitted. Passthrough aliases must carry empty
rules.
