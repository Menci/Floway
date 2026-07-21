# Client-carried affinity

Floway can resolve one public model name or alias to several upstream/model
targets. Client-carried affinity records which target produced an opaque
assistant blob so a later request can prefer that target, or require it when
the surrounding protocol state is not portable.

Affinity is a source-protocol membrane. Ingress authenticates and removes
Floway metadata before interceptors, translators, and providers run. Egress
adds metadata only after events return to the client-facing protocol.

## Encrypted data

Each API key has a hidden 256-bit `serverSecret` for gateway-private data.
Normal key CRUD never exposes it; admin export/import preserves it. The
encrypted plaintext is exactly:

```ts
{
  version: 1,
  origin?: 'raw' | 'base64' | 'base64url',
  affinity: {
    upstreamId: string,
    modelId: string,
    rules?: AliasRules,
  },
}
```

Routing strength is not serialized. Ingress derives `prefer` or `force` from
the blob's current protocol location. Item IDs and persistence metadata are
not affinity data.

The carrier has no delimiter or magic prefix:

```text
original bytes || IV[12] || ciphertext+tag || encryptedLength:u16be
```

The original bytes and the protocol slot are authenticated data. Canonical
Base64 and unpadded canonical Base64URL values are decoded before appending the
encrypted trailer; other strings are stored as raw UTF-16 code units. A blob
created solely for affinity has no `origin` and no original bytes.

Authentication failure, malformed framing, an undeclared plaintext property,
or another key's carrier makes the complete value foreign. Foreign values pass
through byte-for-byte and add no routing evidence, allowing nested Floway
deployments to unwrap their own layer independently.

## Ingress and routing

Ingress builds routing evidence and a request-local payload factory. Each
candidate attempt receives a fresh source payload:

- ordinary blobs restore only for the exact upstream, model, and optional
  alias rules;
- force-state blobs restore for the required upstream and model regardless of
  alias rules;
- incompatible owned blobs and originless synthetic blobs are removed;
- foreign blobs remain unchanged.

Every owned carrier also supplies an exact-rules preference. The latest
available preference moves first. Force never narrows alias rules; an exact
preferred rule variant still wins when available. A direct candidate's absent
rules and an alias target's empty `rules: {}` are the same no-overlay variant.

Affinity only orders or narrows candidates already produced by model
resolution. Missing preferred targets fall back normally. Missing or mutually
incompatible forced upstream/model targets are routing errors.

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
item closes. If the first item cannot carry a blob, Floway emits a complete
originless reasoning `output_item.added` + `output_item.done` pair before the
original item's first event. Original output indexes and sequence numbers are
shifted by that prefix.

Only the first logical item receives synthetic affinity. Later program and
program-output items inherit force from the latest earlier owned carrier; they
do not receive additional blobs. Failed streams do not invent a missing first
carrier.

The Copilot provider has an independent inner item-identity membrane. For
reasoning, compaction, program, and agent-message outputs that already carry an
opaque blob, it appends plaintext JSON `{version:1, origin, id}` plus a trailing
big-endian two-byte JSON length to the decoded/original blob bytes. `origin` is
`raw`, `base64`, or `base64url`; no account identifier or encryption is part of
this provider-private layer. The provider-facing item receives a fresh
type-correct random ID at `output_item.added`, while the raw Copilot ID from
each canonical blob-bearing frame travels only inside that frame's blob
trailer. Verified Copilot output types without a blob also receive random IDs.
When the source state store has a write backing, the client-output membrane
aliases that provider-facing ID; without one, it passes through. An unknown
output type fails the stream before its raw ID is yielded.

Affinity egress subsequently appends its own authenticated outer layer. Two
appends on the client-visible blob are therefore expected and remain
independent. On the next request, affinity ingress removes or projects the
outer layer before candidate dispatch. If Copilot receives its inner layer, the
provider restores the raw ID and original blob; a blob without that layer, or
an item whose blob was stripped by affinity routing, remains foreign and passes
through unchanged. Neither layer buffers visible stream deltas.

Responses persistence is a separate membrane. It stores complete client items
and their native upstream item identity. After affinity has selected a
candidate, the item layer restores a stored upstream item ID only when the
candidate uses the same upstream. Affinity never reads, writes, authenticates,
or validates item IDs.
