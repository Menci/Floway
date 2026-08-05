# Client-carried affinity

Floway can resolve one public model name or alias to several upstream/model
targets. Client-carried affinity records which target produced each opaque
assistant blob. A later request keeps candidates that can retain every natural
blob ahead of candidates that would discard one, and requires a target when the
surrounding protocol state is not portable.

Affinity is a source-protocol membrane. Each source protocol authenticates and
projects Floway metadata before candidate attempts enter protocol interceptors,
translators, or providers. Egress wraps source-shaped events only after the
selected candidate has returned through translation. Native Responses first
hydrates its own stored source items, then applies affinity to the hydrated
payload; on output it applies affinity before Stateful Responses persists the
client-facing items. The Stateful Responses store and Copilot's provider-private
item-id membrane are neighboring layers, not parts of affinity.

## Encrypted data

Each API key has a hidden 256-bit `serverSecret` for gateway-private data.
Normal key CRUD never exposes it; admin export/import preserves it. The
encrypted plaintext is exactly:

```ts
{
  version: 1,
  origin?: 'raw' | 'base64' | 'base64url',
  syntheticItem?: true,
  affinity: {
    upstreamId: string,
    modelId: string,
    rules?: AliasRules,
  },
}
```

Routing policy is not serialized. Ingress assigns policy from the carrier's
current protocol position: ordinary history is optional, while non-portable
continuation state requires the target that produced it. `origin` records how
to restore original opaque bytes; its absence means the blob was created solely
for affinity and contains no original value.
`syntheticItem` is an independent, authenticated statement that Floway created
the complete protocol item carrying the blob. It is valid only without
`origin`. Item IDs and persistence metadata are not affinity data and are not
consulted when interpreting `syntheticItem`.

The carrier has no delimiter or magic prefix:

```text
original bytes || IV[12] || ciphertext+tag || encryptedLength:u16be
```

The original bytes and the protocol slot are authenticated data. Canonical
Base64 and unpadded canonical Base64URL values are decoded before appending the
encrypted trailer; other strings are stored as raw UTF-16 code units. An
originless blob may augment an existing protocol item or reside in a complete
item synthesized by Floway; only `syntheticItem: true` distinguishes the latter.

Authentication failure, malformed framing, an undeclared plaintext property,
an invalid `origin`/`syntheticItem` combination, or another key's carrier makes
the complete value foreign. Foreign values pass through byte-for-byte and add
no routing evidence, allowing nested Floway deployments to unwrap their own
layer independently. The implementation and byte-freeze coverage live in
[`data-plane/chat/shared/affinity/`](../packages/gateway/src/data-plane/chat/shared/affinity/).

## Ingress and routing

Ingress first analyzes the source request without reference to the model
catalog. Chat Completions, Messages, and Gemini record their decoded optional
blob locations. Responses performs one ordered item walk that records each blob
as optional or required, the complete items authenticated as synthetic, and the
required target inherited by blob-less compaction, program, and program-output
state. This analysis is the only place Responses interprets item position.

The request analysis then evaluates every viable model candidate exactly once.
Each blob projection produces one of three decisions:

- **preserve** — forward a foreign value unchanged, or restore an owned natural
  value for a compatible candidate;
- **remove** — remove an originless carrier without degradation, or remove an
  optional natural value and mark the candidate as degrading;
- **reject** — required owned state cannot be restored for this candidate.

Optional owned blobs require an exact upstream/model/rules match. Required
owned state requires the upstream/model pair but deliberately ignores alias
rules, so every rule variant of the same physical target remains eligible. A
direct candidate's absent rules and an alias target's empty `rules: {}` are the
same no-overlay variant for optional matching. Foreign blobs never impose a
requirement and always pass through byte-for-byte.

Responses removes an item in full only when an owned carrier authenticates
`syntheticItem: true`. That marker is necessarily originless, so removing the
item is not degradation. A markerless originless blob — including one written
by an older Floway — removes only its own slot. A synthetic item can still
establish the latest owned target from which a later blob-less program or
program-output item inherits a requirement.

Candidate evaluation returns either `rejected`, or `accepted` with a degradation
bit and a lazy payload materializer. Eligibility and degradation therefore come
from the same protocol projection decisions. No candidate payload is cloned
while ordering. [`selectAffinityCandidates`](../packages/gateway/src/data-plane/chat/shared/affinity/selection.ts)
rejects candidates that cannot retain required state, then stable-partitions the
accepted candidates: every non-degrading candidate stays in resolver order at
the front and every degrading fallback stays in resolver order behind it. If all
accepted candidates have the same degradation status, resolver order is
unchanged. The selected payload is cloned and materialized only when its attempt
actually runs, and repeated access reuses that materialization.

Mutually incompatible required targets and an unavailable sole required target
are routing errors. Candidate attempts otherwise follow the sequential
result-class rules in [RESOLUTION.md](./RESOLUTION.md). A failed non-degrading
attempt can fall through to a degrading candidate before egress records the
target of the first successful attempt.

## Egress

Egress performs two independent operations:

1. wrap every natural opaque/signature blob;
2. ensure the first logical assistant element has a blob by adding one with no
   `origin` when necessary.

Chat Completions, Messages, and Responses do not buffer visible deltas for
affinity. Gemini delays one complete upstream event; the window never grows
beyond that event.

### Chat Completions

One choice is one logical element. `reasoning_opaque` is last-write-wins per
choice. Visible deltas pass through immediately. Floway emits one wrapped
natural or originless opaque snapshot immediately before `finish_reason`, or
before `[DONE]` when the upstream omits a finish reason.

### Messages

`signature_delta` is last-write-wins. Thinking text passes through while the
latest signature waits for `content_block_stop`. `redacted_thinking.data` is
wrapped at block start. If the first block cannot carry a blob, Floway emits a
complete `redacted_thinking` prefix at index zero before the original block and
shifts every original block index by one.

### Gemini

Gemini buffers at most one upstream event. Signature snapshots for each
same-event logical element reduce to the latest value on that element's first
content-bearing Part. Across events, a late signature can move back only onto
the immediately preceding buffered chunk. Empty text and `thought` metadata do
not make a Part content-bearing. Immediate signature-only prefixes or trailers
move onto adjacent content when the one-event window can determine ownership.

This costs one upstream event of latency. It favors direct Google GenAI Chat
compatibility and cannot repair a first-wins client when a natural function
signature arrives more than one continuation after the first chunk. Evidence
and client tradeoffs are recorded beside the
[Gemini egress state machine](../packages/gateway/src/data-plane/chat/gemini/affinity/egress.ts).

### Responses

Natural blobs are top-level `encrypted_content`, program `fingerprint`, and
`agent_message.content[].encrypted_content`. A carrier-capable first item
without a natural blob receives an originless blob in its own slot when that
item closes. The blob has no `syntheticItem` marker because the upstream item
already existed.

If the first item cannot carry a blob, Floway emits a complete originless
reasoning `output_item.added` + `output_item.done` pair before the original
item's first event. Its blob carries `syntheticItem: true`. Original output
indexes and sequence numbers are shifted by that prefix. On ingress the
authenticated marker is the sole authority for removing the entire item;
Floway does not infer ownership from the item ID or payload shape.

Only the first logical item receives synthetic affinity. Later program and
program-output items inherit force from the latest earlier owned carrier; they
do not receive additional blobs. Failed streams do not invent a missing first
carrier.

## Copilot item IDs

The Copilot provider has an independent inner item-id membrane. For reasoning,
compaction, program, and agent-message outputs that carry replay state, it
appends plaintext JSON `{version:1, origin, id}` plus a trailing big-endian
two-byte JSON length to each decoded/original carrier value. `origin` is `raw`,
`base64`, or `base64url`; no account identifier or encryption is part of this
provider-private layer. The client-facing item receives a fresh type-correct
random ID at `output_item.added`, while raw Copilot IDs travel only inside the
matching carrier trailers. Known output types without a carrier also receive
random IDs. An unknown output type fails before its raw ID is yielded.

Affinity egress subsequently appends its authenticated outer layer, so two
trailers on one client-visible blob are expected and independent. On the next
request, affinity ingress removes or projects the outer layer for each
candidate. If Copilot then receives its inner layer, the provider restores the
raw ID and original carrier value. A foreign value, or an item whose carrier
was removed by affinity routing, passes through without item-id restoration.
Neither layer buffers visible deltas. The closed output-type policy and OpenAI
prefix references live beside the
[Copilot item-id membrane](../packages/provider-copilot/src/interceptors/responses/item-id-membrane.ts);
its framing is implemented by the adjacent
[item-id carrier](../packages/provider-copilot/src/interceptors/responses/item-id-carrier.ts).

## Stateful Responses

Stateful Responses is a native Responses source-edge membrane. Before affinity,
it expands `previous_response_id`, loads exact API-key-scoped item IDs, replaces
stored full items and `item_reference`s with their first durable client-facing
payload, and carries any server-private payload in a request-local scratchpad.
Item IDs are opaque: hydration performs no prefix validation and no
candidate-specific rewrite. Affinity never reads, writes, authenticates, or
validates item IDs, including when it recognizes a fully synthetic item.

On output, closed item lifecycles first canonicalize any partial terminal
restatement. Affinity wraps that source-shaped canonical stream, then, when
state is writable, persistence stores the first `response.output_item.done`
value for every output index under the exact client-facing item ID; duplicate
done or terminal frames remain wire-visible but cannot replace that durable
row. Completed item rows survive a later failed stream, but a response snapshot
commits only before a successful `response.completed` or `response.incomplete`
terminal.

An ordinary successful turn appends prior-snapshot IDs, newly staged input IDs,
and output IDs into the new response snapshot. If any completed output is a
`compaction` item, the snapshot instead replaces history with only that turn's
output IDs. Non-streaming `/v1/responses/compact` is converted to the same
added/done/terminal event path, so it has identical affinity and snapshot
semantics.

When state is writable, idless input items use content hashes to reuse or mint
internal storage keys; those internal keys never alter the wire item. HTTP
`store: false` may read durable state but neither stages nor writes new state.
WebSocket `store: false` writes new state only to its session-local in-memory
backing; when durable retention is enabled, reads check session-local state and
then the durable backing. It never writes the new turn durably. Every backing
accepts reuse of the same item/private payload and rejects a different payload
under the same API-key-scoped ID. The ordering is owned by the
[native client-output boundary](../packages/gateway/src/data-plane/chat/responses/client-output.ts)
and the
[Stateful Responses output wrapper](../packages/gateway/src/data-plane/chat/responses/items/output.ts).
