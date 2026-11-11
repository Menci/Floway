# Translation Protocols and Shared Helpers

`src/protocols/<protocol>/` owns translation entrypoints and protocol-specific
code. `__tests__/protocols/` mirrors production ownership. Package callers
import the pair's named export from the package root and call it with a source
payload and `TranslateOptions` to create an independent trip.

## Categories

1. **Composition** — a route pairs a source and a target and states nothing else.
   Anything a pair alone needs belongs to one of its sides; if it truly needs
   both, it belongs in `composition/index.ts`.
2. **Source-only helper** — keep it in `protocols/<protocol>/as-source/`.
   Only routes whose source is that protocol may import it.
3. **Target-only helper** — keep it in `protocols/<protocol>/as-target/`.
   Only routes whose target is that protocol may import it.
4. **Output IR** — keep private types, its path schema, stream operations,
   validation, accumulation, operation paths, and native ordinal mapping under
   `ir/output/`, and the input model under `ir/input/`. A reading holds the
   source's native assistant turns beside the IR it would produce, so it belongs
   to composition rather than to the IR. Native SSE adapters
   belong to their protocol: `as-target/sse-from.ts` consumes upstream SSE and
   `as-source/sse-to.ts` emits client SSE with its sidecar. The return path is
   upstream SSE → IR SSE → client SSE with sidecar. IR stays internal to translate.
5. **Assistant-turn round trips** — keep owner-specific sidecar validation, replay
   validation, and native stream coordination under `round-trip/`. Source replay
   inspection and carriers belong in `as-source/round-trip.ts`; native assistant-turn
   shapes and output-to-input converters belong in `as-target/assistant-turn.ts`.
   Transport encoding is injected through `TranslateOptions.sidecarCodec`.
6. **Protocol-independent utility** — keep it in `shared/`, with tests under
   `__tests__/shared/`. Protocol behavior belongs in its owning protocol directory.

## Current Production Subdirectories

- `ir/common/` — values both directions share: the JSON shape, `IRAbsent`, the error payload, text ranges.
- `ir/input/` — the request conversation model, its types, and the target-side
  selection helpers.
- `composition/` — what a trip needs before the IR is written: a
  source conversation read into turn slots, and the segmentation that splits a
  writer's input at the turns a sidecar restored.
- `ir/output/` — the returned-stream model, its path schema, and protocol-independent streaming state.
- `round-trip/` — authenticated assistant-turn sidecars, replay validation, and native stream coordination.
- `protocols/anthropic-messages/as-source/` — interprets Messages requests and emits Messages SSE.
- `protocols/anthropic-messages/as-target/` — maps requests to Messages and consumes Messages SSE.
- `protocols/gemini-generate-content/as-source/` — interprets GenerateContent parts and schemas and emits GenerateContent SSE.
- `protocols/openai-chat-completions/as-source/` — emits ChatCompletions SSE.
- `protocols/openai-chat-completions/as-target/` — consumes ChatCompletions SSE.
- `protocols/openai-responses/as-source/` — interprets Responses tools, restores event identities, and emits Responses SSE.
- `protocols/openai-responses/as-target/` — consumes Responses SSE.
- `composition/index.ts` — pairs one source protocol with one target protocol into a trip; the only file that names two protocols.
- `protocols/<protocol>/as-source.ts` — states that protocol as the side a request comes from.
- `protocols/<protocol>/as-target.ts` — states that protocol as the side a request goes to.
- `shared/` — cross-route coordinate conversion, error classification, JSON handling, and token validation.

## Rules

- Inspect helpers by content and consumers. Keep protocol behaviour on the side
  that owns it; `composition/index.ts` holds only what needs both sides.

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
