# Translation Protocols and Shared Helpers

`src/protocols/<protocol>/` owns translation entrypoints and protocol-specific
code. `__tests__/protocols/` mirrors production ownership. Package callers
import the source protocol's subpath and call
`route<Protocol>(input).via<Target>(context)` to create an independent trip.

## Categories

1. **Single-pair helper** — keep it in
   `protocols/<source>/via-<target>/`, beside its request and event translators.
2. **Source-only helper** — keep it in `protocols/<protocol>/as-source/`.
   Only routes whose source is that protocol may import it.
3. **Target-only helper** — keep it in `protocols/<protocol>/as-target/`.
   Only routes whose target is that protocol may import it.
4. **Both directions** — keep it in `protocols/<protocol>/common/`.
   Routes using that protocol as source or target may import it. Keep another
   protocol's wire mapping in the matching `via-*` route. Retained files use
   functional names without another protocol name.
5. **Output IR** — keep private types, its path schema, stream operations,
   validation, accumulation, operation paths, and native ordinal mapping under
   `ir/`. Native SSE adapters
   belong to their protocol: `as-target/sse-from.ts` consumes upstream SSE and
   `as-source/sse-to.ts` emits client SSE with its sidecar. The return path is
   upstream SSE → IR SSE → client SSE with sidecar. IR stays internal to translate.
6. **Assistant-turn round trips** — keep owner-specific sidecar validation, replay
   validation, and native stream coordination under `round-trip/`. Source replay
   inspection and carriers belong in `as-source/round-trip.ts`; native assistant-turn
   shapes and output-to-input converters belong in `as-target/assistant-turn.ts`.
   Transport encoding is injected through `TranslationContext.sidecarCodec`.
7. **Protocol-independent utility** — keep it in `shared/`, with tests under
   `__tests__/shared/`. Protocol behavior belongs in its owning protocol directory.

## Current Production Subdirectories

- `ir/` — output model, its path schema, and protocol-independent streaming state.
- `round-trip/` — authenticated assistant-turn sidecars, replay validation, and native stream coordination.
- `protocols/anthropic-messages/as-source/` — interprets Messages requests and emits Messages SSE.
- `protocols/anthropic-messages/as-target/` — maps requests to Messages and consumes Messages SSE.
- `protocols/gemini-generate-content/as-source/` — interprets GenerateContent parts and schemas and emits GenerateContent SSE.
- `protocols/openai-chat-completions/as-source/` — emits ChatCompletions SSE.
- `protocols/openai-chat-completions/as-target/` — consumes ChatCompletions SSE.
- `protocols/openai-chat-completions/common/` — reads scalar reasoning aliases and summary content.
- `protocols/openai-responses/as-source/` — interprets Responses tools, restores event identities, and emits Responses SSE.
- `protocols/openai-responses/as-target/` — consumes Responses SSE.
- `protocols/openai-responses/common/` — owns wrapper formats used in both translation directions.
- `protocols/<source>/via-<target>/` — owns request translation and composes native SSE adapters for one protocol pair.
- `shared/` — cross-route coordinate conversion, error classification, JSON handling, and token validation.

## Rules

- Inspect helpers by content and consumers. Keep most translation logic in the
  owning `via-*` route; extract only cohesive logic shared by multiple routes.

- Shallow wrappers that only rename or stringify must be inlined at every call
  site, not extracted. A helper that defines a format two or more routes must
  agree on is not such a wrapper.
- Tests stay under `__tests__/` in the same category as their production code.
  Cross-protocol public route contract tests belong under `__tests__/protocols/`.
- Helpers that fit no shared category stay in their route directory.
- A helper that is not translation logic, such as defense against a malformed
  upstream stream, belongs to the gateway boundary that owns that policy.

See the project root `AGENTS.md` for package boundary rules
(`packages/protocols` vs `packages/translate` vs `packages/gateway`).
