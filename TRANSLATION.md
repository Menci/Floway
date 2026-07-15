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
membranes outside `packages/translate`.

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
without any endpoint required by the operation is removed before affinity and
attempt dispatch. Model resolution and affinity ordering are documented in
[RESOLUTION.md](./RESOLUTION.md).

## Source membranes versus pure translation

The complete chat path is:

```text
client source payload
→ source state expansion (Responses only)
→ source affinity ingress
→ candidate resolution and force/prefer ordering
→ candidate-specific restoration or removal of opaque state
→ source interceptors
→ zero or one pairwise translation trip
→ target interceptors and provider boundary
→ decoded target events
→ translation events mapper back to the source protocol
→ source affinity egress
→ source state persistence and ID rewriting (Responses only)
→ HTTP/SSE/WebSocket client
```

`packages/translate` never reads an API key, encrypts an affinity envelope,
selects an upstream, or writes Responses state. It sees only protocol-native
values restored for the candidate currently being attempted. Conversely, the
affinity layer does not translate content or provider controls; it only owns
opaque carrier placement and exact-target provenance.

### Client-carried affinity envelope

Each API key has an internal 32-byte server secret for gateway-private per-key
data. The codec derives an affinity-specific key and encrypts this version 1
object with AES-256-GCM:

```ts
{
  version: 1,
  origin?: 'raw' | 'base64' | 'base64url',
  affinity: {
    upstreamId: string,
    modelId: string,
    rulesPresent: boolean,
    rules?: AliasRules,
    upstreamItemId?: string,
    syntheticItem?: true,
  },
}
```

The envelope stores identity and restoration data only. Source ingress derives
request-local prefer/force evidence from the carrier's current protocol
location. Ordinary assistant state prefers its target; Responses compaction
and program state forces the associated target.

Wire framing has no delimiter and no magic marker:

```text
original bytes || IV[12] || ciphertext+tag || encryptedLength:u16be
```

Additional authenticated data is a length-delimited carrier-domain name
followed by the original bytes. Moving a trailer to another protocol field,
item slot, or original value therefore fails authentication.

The complete bytes are encoded as canonical Base64, or Base64URL when the
original was canonical Base64URL. Canonical Base64/Base64URL input is decoded
before appending the trailer, so it is never encoded a second time. Other text
is UTF-8 `raw`. A synthetic value has no origin and no original bytes.

Ingress authenticates the tail with the current key. An invalid length,
unknown envelope, authentication failure, or another key's carrier is foreign:
it remains byte-for-byte and contributes no affinity. This is intentional for
cascaded Floway deployments. An outer gateway can wrap a complete inner
carrier; on the next turn it restores the inner value exactly before the inner
gateway sees it.

Owned values are removed at the early source edge and retained in a
request-local plan. Every candidate gets a fresh payload clone. Compatible
carriers restore their original value; incompatible owned state is
omitted; incompatible synthetic blocks/items are removed; foreign values pass
through. Thus Floway's encrypted metadata is invisible to translators,
interceptors, and upstream providers.

After a successful attempt identifies the exact candidate, source egress runs
outside the complete translation/interceptor stack. Its inner transform wraps
every natural opaque value. Its outer transform ensures the first logical
assistant element has a carrier, augmenting it or inserting a protocol-native
prefix element. Count-token responses have no assistant turn and therefore
perform ingress/routing only.

### Protocol affinity placement

#### Chat Completions

`reasoning_opaque` is a last-write-wins snapshot, independently tracked for
every choice index. The egress transformer removes opaque-only snapshots from
intermediate client frames while forwarding content, readable reasoning, tool
calls, argument deltas, choice extras, and usage immediately. At each choice's
finish it emits one wrapped `reasoning_opaque` snapshot, then the original
finish event. If there was no upstream opaque value, that snapshot is
synthetic. Non-stream reassembly also uses last-write-wins for this field and
maintains independent state for all choices.

#### Messages

Anthropic `signature_delta` is also a last-write-wins snapshot, not a string
fragment. Readable `thinking_delta` events are forwarded immediately while the
latest signature is retained. Immediately before `content_block_stop`, egress
emits one wrapped replacement signature. If the first thinking block has no
natural signature, the replacement is originless. `redacted_thinking.data` is
complete on `content_block_start` and is wrapped there. When the first block
cannot carry a blob, egress emits a synthetic `redacted_thinking` block at
index zero and shifts every original block event by one. An empty successful
message receives that prefix immediately before its terminal event.

#### Gemini

Gemini intentionally buffers one complete source event and inspects the next.
Natural signatures remain attached to content-bearing Parts and are wrapped in
place. An immediate signature-only trailer is moved onto the buffered Part;
when the lookahead provides no natural carrier for the same text/function-call
element, the buffered first Part receives an originless signature. This avoids
the metadata-only Parts rejected or discarded by several Gemini clients. A
successful candidate with no content-bearing Part still requires a
signature-only best-effort fallback. Candidate state is independent by index.

#### Responses

Responses opaque slots include top-level `encrypted_content` on reasoning,
compaction, context-compaction, and other output items, plus
`agent_message.content[].encrypted_content`. Existing slots are wrapped with a
cached value across repeated snapshots. If the first item can carry a blob but
has none, egress adds an originless value at `output_item.done` and reuses it in
the terminal response. Otherwise it emits a synthetic reasoning prefix through
`output_item.added` / `output_item.done`, shifts every original `output_index`
by one and `sequence_number` by two, and prepends the same item to later
response snapshots. The storage membrane runs afterward and therefore assigns
and persists client IDs for the exact prefixed output.

Ingress derives strength from the reconstructed input. Compaction and
context-compaction carriers are force evidence. Program/program-output state
forces the nearest preceding owned target; ordinary reasoning and agent-message
carriers prefer. `response.failed` and `error` do not synthesize a missing
carrier, though a prefix already emitted before a later failure cannot be
retracted.

## Responses state membrane

The native Responses source owns state. An inner Responses attempt reached by
Messages, Chat, or Gemini translation has only request-local hosted-tool state
and never constructs or writes a Responses persistence store.

Inbound ordering is strict:

1. expand `previous_response_id` into gateway item references;
2. load referenced rows and hydrate gateway IDs into complete stored payloads;
3. decode affinity from the hydrated items;
4. route candidates;
5. hydrate server-private item payloads for the chosen attempt;
6. restore or remove opaque values for that candidate.

This order keeps the repository independent of routing while allowing a
stored, affinity-wrapped item to route exactly like an inline client item.

Outbound ordering is the reverse boundary:

1. finish provider interception and translate events back to Responses;
2. add source affinity;
3. when state is enabled, mint gateway response/item IDs and store the exact
   complete affinity-wrapped client item;
4. commit item rows at `output_item.done` and the snapshot before yielding a
   successful terminal event.

Ordinary snapshots append previous history, this turn's input, and this turn's
output. Any compaction item makes the output an atomic replacement snapshot.
There is one stored item shape: complete payload, content hash, API-key scope,
and creation time. Optional server-private payload is stored beside the public
item for server-tool replay.

HTTP `store: false` performs no item or snapshot writes. WebSocket
`store: false` writes complete state only to a session-owned memory backing;
the same socket can reference it, but later sessions cannot. With storage
enabled, item and snapshot rows expire 30 days after creation. Large compressed
item payloads may spill to the file provider and use the same lifetime.

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
- preserves opaque thought signatures through the affinity source membrane;
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

The `${encrypted_content}@${id}` bridge is translation state, not Floway
affinity encryption. Source affinity egress later wraps the complete Messages
signature outside the pure trip.

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

- system, user text/images, tool results, assistant text, and tool use become
  their Chat counterparts while preserving source order;
- only the first source-order thinking group fits Chat's scalar
  `reasoning_text` / `reasoning_opaque` fields;
- limits, sampling, stop, tools, and representable tool choice map directly;
- explicit effort maps to `reasoning_effort`; disabled thinking maps to
  `none`.

Response mapping concatenates text and tool argument fragments, uses the latest
opaque reasoning snapshot, maps tools, stop reasons, and usage, and retains
only the first Messages reasoning group representable by Chat. Multiple
Messages thinking groups and assistant images are lossy.

## Chat Completions → Messages

Request mapping:

- the leading system/developer prefix becomes top-level Messages system;
- supported user images are resolved through the external-resource loader;
- assistant scalar reasoning becomes one thinking or redacted block;
- Chat tool calls/results become Messages tool use/results;
- limits, sampling, stop, tools, and strictness map where representable.

Response mapping emits scalar reasoning before text and text before tools.
`reasoning_opaque` is treated as a replacement snapshot; when several snapshots
arrive before a block is emitted, the latest value wins. Opaque-only reasoning
uses `redacted_thinking`. Chat alternatives have no Messages representation,
so only the first choice is translated. Usage cache dimensions remain
disjoint.

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
by the pure translator; the source affinity membrane remains outside it.

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

- Chat, Messages, and Responses defer only opaque carrier state to a
  protocol-valid boundary. Gemini holds one complete event so a natural
  signature can remain attached to content-bearing output.
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
  events replace the complete response snapshot; prefix insertion rewrites all
  later output indexes and terminal output consistently.
- Pairwise translators preserve source output order even when target items
  complete out of order.
- Tool/custom argument guards reject infinite whitespace or malformed partial
  JSON instead of silently producing empty calls.

## Reasoning policy

Readable reasoning is translated where the target has a natural field. Opaque
state is never guessed. Pairwise Messages/Chat and Messages/Responses bridges
carry restored native values needed by the target protocol; Floway affinity is
added only after the trip returns to the client source shape.

Chat `reasoning_opaque` and Messages `signature_delta` are replacement
snapshots. Gemini thought signatures belong to parts. Responses encrypted
content belongs to an item and may bind its upstream item ID. These semantics
are protocol contracts, not interchangeable string-fragment conventions.

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
