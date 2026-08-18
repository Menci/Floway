# Translation Shared Helpers

`src/shared/` contains translate-internal helpers, and `__tests__/shared/`
mirrors their test coverage. A helper's production location is an import
ceiling over the sibling translation-pair directories. Pick the narrowest
matching category before writing a helper or its tests; do not put flat `.ts`
files at the top level of either `shared/` tree.

## Categories

1. **Single-pair helper** — keep it in the pair's directory
   (`anthropic-messages-via-openai-responses/`, etc.). Do not extract it into `shared/`.
2. **Source-locked, `<X>-via/`** — only `X-via-*` pairs may import the helper.
   A helper does not need to serve every pair within that ceiling.
3. **Target-locked, `via-<Y>/`** — only `*-via-Y` pairs may import the helper.
   A helper does not need to serve every pair within that ceiling.
4. **One-protocol-bidirectional, `<P>/`** — only pairs with `P` as either source
   or target may import the helper. No helper currently occupies this ceiling.
5. **Two-protocol-bidirectional, `<A>-and-<B>/`** — only the `A-via-B` and
   `B-via-A` pairs may import the helper. For example,
   `openai-chat-completions-and-openai-responses/reasoning.ts` runs both directions of the
   OpenAI Chat Completions ↔ OpenAI Responses reasoning round trip.

## Current Production Subdirectories

- `openai-chat-completions-and-openai-responses/` — available only to
  `openai-chat-completions-via-openai-responses` and `openai-responses-via-openai-chat-completions`.
- `openai-chat-completions-and-anthropic-messages/` — available only to
  `openai-chat-completions-via-anthropic-messages` and `anthropic-messages-via-openai-chat-completions`.
- `anthropic-messages-and-openai-responses/` — available only to `anthropic-messages-via-openai-responses` and
  `openai-responses-via-anthropic-messages`.
- `anthropic-messages-via/` — available only to `anthropic-messages-via-*` pairs.
- `openai-responses-via/` — available only to `openai-responses-via-*` pairs.
- `gemini-generate-content-via/` — available only to `gemini-generate-content-via-*` pairs.
- `via-anthropic-messages/` — available only to `*-via-anthropic-messages` pairs.
- `via-openai-responses/` — available only to `*-via-openai-responses` pairs.

## Rules

- Shallow wrappers that only rename or stringify must be inlined at every call
  site, not extracted. Delete the wrapper rather than retaining a shim. A
  one-liner that *defines* a format two or more pairs must agree on is not such
  a wrapper: `via-openai-responses/openai-responses-stream.ts` owns the composite stream-part
  key both OpenAI-Responses-target pairs build and compare, and inlining it would let
  the copies drift apart.
- Flat `.ts` files at the top level of either `src/shared/` or
  `__tests__/shared/` are forbidden. Every shared helper and test suite lives
  in one of the categories above.
- Tests stay in the same category as the helper or cross-helper behavior they
  cover. Suite names describe the tested behavior; they do not need a
  one-to-one production basename.
- Helpers that fit no category stay in their pair directories. Do not invent a
  folder pattern without explicit confirmation.
- A helper that is not translation logic, such as defense against a malformed
  upstream stream, belongs to the gateway boundary that owns that policy.

See the project root `AGENTS.md` for package boundary rules
(`packages/protocols` vs `packages/translate` vs `packages/gateway`).
