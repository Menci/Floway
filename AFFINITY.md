# Client-carried affinity

Floway can resolve one public model name or alias to several upstream/model
bindings. Client-carried affinity records which binding produced opaque
assistant state so a later turn can prefer that binding, or require it when
the state is not portable.

Affinity is a gateway source membrane, not a protocol or a translation layer.
Ingress removes Floway metadata before interceptors, translators, and providers
run. Egress adds it only after events return to the client-facing protocol.

## Encrypted data and framing

Each API key has a hidden 256-bit `serverSecret` for gateway-private per-key
data. Normal key CRUD never exposes it; admin export/import preserves it.
Affinity derives an AES-256-GCM key with HKDF and encrypts:

```ts
{
  version: 1,
  origin?: 'raw' | 'base64' | 'base64url',
  affinity: {
    upstreamId: string,
    modelId: string,
    rules?: AliasRules,
    upstreamItemId?: string,
    syntheticItem?: true,
    boundItem?: {
      type: string,
      upstreamItemId?: string,
      contentHash: string,
    },
  },
}
```

Routing strength is not serialized. Ingress derives `prefer` or `force` from
the carrier's current protocol location.

The carrier has no delimiter or magic prefix:

```text
original bytes || IV[12] || ciphertext+tag || encryptedLength:u16be
```

The original bytes and a length-delimited protocol/slot domain are additional
authenticated data. Canonical Base64 and unpadded canonical Base64URL values
are decoded before the encrypted trailer is appended, so existing data is not
Base64-encoded twice. Other strings are stored as UTF-16 code units, preserving
even lone surrogates exactly. A synthetic carrier has no `origin` and no
original bytes.

Authentication failure, an invalid frame, unsupported encrypted data, or
another key's carrier is foreign. Foreign values pass through byte-for-byte and
add no routing evidence, which allows nested Floway deployments to unwrap their
own layers independently.

## Ingress and routing

Ingress authenticates all recognized opaque fields and builds a request-local
candidate payload factory. Each attempt receives a fresh source payload:

- ordinary/discardable blobs restore only for exact upstream, model, and
  optional alias rules;
- force-state blobs restore for any candidate with the required upstream and
  model, regardless of alias rules;
- incompatible owned blobs and authenticated synthetic elements are removed;
- foreign blobs remain unchanged.

Every owned carrier also adds an exact-rules preference. The latest preferred
target that remains available moves first. Responses compaction and
program/program-output state additionally force upstream and model. Force
never narrows alias rules; an exact preferred rule variant still wins when it
is available. A direct candidate's absent rules and an alias target's empty
`rules: {}` are the same no-overlay variant.

Responses expands `previous_response_id` and hydrates complete stored items
before affinity ingress. Persistence contains no separate routing record.

## Egress layers

Egress performs two independent operations:

1. wrap every natural opaque/signature value with restoration metadata;
2. ensure the first logical assistant element has a carrier when no natural
   value provides one.

Chat Completions, Messages, and Responses do not buffer visible deltas for
affinity. Gemini deliberately delays one complete upstream event; the window
never grows beyond that event.

### Chat Completions

One choice is one logical element. `reasoning_opaque` is last-write-wins per
choice. Visible deltas pass through; Floway emits one wrapped natural or
synthetic opaque snapshot immediately before `finish_reason`, or immediately
before `[DONE]` when the upstream omits a finish reason.

### Messages

`signature_delta` is last-write-wins. Thinking text passes through and the
wrapped signature is emitted immediately before `content_block_stop`.
`redacted_thinking.data` is wrapped at block start. If the first block cannot
carry a blob, Floway inserts a `redacted_thinking` prefix at index zero and
shifts every original block index by one.

### Gemini

Gemini buffers at most one upstream event. Signature snapshots for each
same-event logical element are reduced to the latest value and placed on that
element's first content-bearing Part. Across events, a late signature can move
back only onto the immediately preceding buffered chunk. Empty text and
`thought` metadata alone do not make a Part content-bearing. Immediate
signature-only prefixes/trailers are moved onto adjacent content when the
one-event window can determine ownership.

This adds one upstream event of latency. It deliberately favors direct Google
GenAI Chat compatibility and cannot repair a first-wins client when a natural
function signature arrives more than one continuation after the first chunk.
The evidence and exact client tradeoffs are recorded beside the
[Gemini affinity egress state machine](./packages/gateway/src/data-plane/chat/gemini/affinity/egress.ts).

### Responses

Natural carriers include top-level `encrypted_content`, program `fingerprint`,
and `agent_message.content[].encrypted_content`. A carrier-capable first item
without a natural value receives one at `output_item.done`; a program without
a natural fingerprint receives a synthetic fingerprint in the same slot.

Other first items and `program_output` items receive an adjacent reasoning
prefix. Its `output_item.added` event is emitted immediately
without buffering the bound item's visible stream. Its encrypted
`output_item.done` is emitted immediately before the bound item's done event,
using the final upstream ID and a canonical SHA-256 content hash that excludes
the replaceable item ID. The hash also applies Codex's output-to-history
projection: message/function-call `status` and empty output-text `annotations`
or `logprobs` are omitted. Terminal output contains the same completed prefix.
Output indexes and sequence numbers include each inserted lifecycle event.

On replay, the authenticated type and content hash must match the adjacent
item. A mismatch is a client input error. Preferred bindings restore IDs only
for exact optional rules; force-item bindings restore across rule variants on
the same upstream/model. Stored server-private payloads are re-keyed to the
restored wire ID before Responses interceptors run.

Failed/error streams do not invent a missing final carrier. A prefix already
opened before an eventual failure cannot be retracted.
