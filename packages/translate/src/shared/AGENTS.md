# `shared/` Convention

Helpers in this folder are translate-internal. Their location encodes who is
allowed to import them. Pick the folder before writing the file; do not put
flat `.ts` files at the top level of `shared/`.

## Categories

1. **Single-pair helper** — inline into the pair's directory
   (`messages-via-responses/`, etc.). Do not extract.
2. **Source-locked, `<X>-via/`** — helpers shared by every pair that has `X`
   as the source. Example: `responses-via/` is consumed only by
   `responses-via-*` pairs.
3. **Target-locked, `via-<Y>/`** — helpers shared by every pair that has `Y`
   as the target. Example: `via-messages/` is consumed only by
   `*-via-messages` pairs.
4. **One-protocol-bidirectional, `<P>/`** — helpers used wherever protocol `P`
   appears as either source or target.
5. **Two-protocol-bidirectional, `<A>-and-<B>/`** — helpers used by both
   `A-via-B` and `B-via-A`. Example:
   `chat-completions-and-responses/reasoning.ts` runs both directions of the
   Chat Completions ↔ Responses reasoning round trip.

## Current subdirectories

- `chat-completions-and-responses/` — helpers used by both
  `chat-completions-via-responses` and `responses-via-chat-completions`.
- `chat-completions-and-messages/` — helpers used by both
  `chat-completions-via-messages` and `messages-via-chat-completions`.
- `messages-and-responses/` — helpers used by both `messages-via-responses` and
  `responses-via-messages`.
- `messages-via/` — helpers used by all `messages-via-*` pairs
  (source-locked).
- `responses-via/` — helpers used by all `responses-via-*` pairs
  (source-locked).
- `gemini-via/` — helpers used by all `gemini-via-*` pairs (source-locked).
- `via-messages/` — helpers used by all `*-via-messages` pairs
  (target-locked).
- `via-responses/` — helpers used by all `*-via-responses` pairs
  (target-locked).

## Rules

- Shallow wrappers (one-liners that only rename or stringify) must be inlined
  at every call site, not extracted. The shim file should be deleted.
- Flat `.ts` files at the top level of `shared/` are forbidden. Every helper
  lives in one of the five categories above.
- Helpers that do not fit any of the five categories must be inlined into
  every consumer. Do not invent new folder patterns without explicit
  confirmation. If a helper feels like it does not belong to translation at
  all (defending against degenerate upstream streams, etc.), it belongs to a
  `packages/gateway` interceptor instead.

See the project root `AGENTS.md` for package boundary rules
(`packages/protocols` vs `packages/translate` vs `packages/gateway`).
