# Structure review — main agent's independent findings

Scope: `packages/translate/src`. Judged: does each symbol live in the file that
owns it; should any file split or merge.

## Split candidates (verified by reading)

1. **`ir/output/collector.ts` (223 lines)** — three unrelated responsibilities:
   - value validation: `assertPlainValue`, `walkValue`, `assertComplete`
   - lifecycle bookkeeping: `createCounter`, `createLifecycle`
   - the collector itself: `createIRCollector`
   The first two never touch collector state; they only read a schema node.
   Proposed: `ir/output/validate-value.ts` and `ir/output/lifecycle.ts`.

2. **`protocols/openai-responses/as-target/sse-from.ts` (695 lines)** — the
   snapshot reconciliation block (`deepEqual`, `closedSnapshotEqual`,
   `validateSnapshotIdentity`, `ensure*`, `reconcile*`, lines 80–540) is
   contiguous and separable from the event loop. Proposed:
   `as-target/snapshot.ts` exporting what `reconcileItem`/`closeItem` need.

3. **`protocols/openai-responses/as-source/sse-to.ts` (853 lines)** — the
   reason* event constructors (`reasoningPartAdded`, `reasoningTextDelta`,
   `reasoningTextDone`, `reasoningPartDone`) plus the type guards
   (`isRecord`, `initializedType`, `textPartLogprobMetadata`,
   `isIRTokenLogprob`) are a preamble of pure builders. Separable, though the
   win is smaller than (2).

4. **`ir/output/schema.ts` (123 lines)** — DSL constructors + `ValueOf`
   type-level inference + the `irSchemaMatchesIRTypes` assertion. The
   type-level half is independent of the runtime DSL.

## Wrong-file candidates (to weigh)

5. **`ir/input/select-tools.ts`** — pure policy over IR values, but every
   consumer is a *target writer* or `shared/flatten-request.ts`; no IR reader
   uses it. Two prior reviews disagreed; the user now asks to re-examine file
   placement specifically, so it deserves a fresh verdict.
6. **`ir/input/stream.ts` (17 lines, one function `requireStreaming`)** — a
   target-side precondition living in the input-IR directory, and its filename
   collides with `ir/output/stream.ts` (a real record stream). The input IR has
   no stream.
7. **`shared/reasoning-budget.ts`** — hard-codes OpenAI effort tiers
   (`low/medium/high`, 2048/8192). Only the two OpenAI *targets* use it. Its
   knowledge is OpenAI's, not protocol-independent.
8. **`shared/custom-tool.ts`** — `buildCustomToolInputSchema` builds the
   single-`input`-string function schema used by the Chat and Messages targets;
   `unwrapCustomToolInput` is used by the Chat and Messages *readers*. The
   wrapper shape is a cross-protocol convention, so `shared/` is defensible;
   verify no third protocol needs a different wrapper.
9. **`shared/text-coordinate-index.ts`** imports `IRTextRange` from
   `ir/output/types.ts`, but the type is defined in `ir/common/text-range.ts`.
   `shared/` reaching through the output half for a shared type is a layering
   smell even though it type-checks.

## Merge candidates (to weigh)

10. **`protocols/composition/reading.ts` (65) + `segments.ts` (46)** — 111 lines
    total, one concept ("what a writer consumes"). Reading produces the turn
    list; segmentation splits it. They are two stages of one pipeline.
11. **`ir/common/absent.ts` (6) + `json.ts` (7) + `text-range.ts` (7)** — three
    six-to-seven-line type declarations. `error.ts` (13) is the fourth. Could be
    one `ir/common/types.ts`, at the cost of three precise filenames.
12. **`round-trip/reference/text-groups.ts` (47)** — produces `TextPlacement`,
    consumed only by the reference builder. Is it round-trip, or a shared text
    concern?

## Checked and judged fine

- `shared/token-count.ts` (4 lines) — one guard used by every usage converter
  in all four protocols. Its own file is right.
- `round-trip/sidecar-tagged-value.ts` (10) — the transport wrapper, distinct
  from `reference/content-reference-tag.ts` (the ContentReference mapping).
- `ir/` never imports a protocol module (verified by grep).
- No protocol subtree imports another protocol subtree (verified).

## Additional (verified later)

13. **`protocols/composition.ts` holds two test-only entrypoints**
    (`buildTargetPayloadFor`, `buildSourceEventsFor`). Zero production callers;
    27 test files import them. It is real structure, but moving them is a test
    architecture decision (rewriting ~30 call shapes), not a file move.

## Behaviour spot-checks done by hand
- `turn-digest.ts` unchanged except import path; sidecar compatibility intact.
- Every `as-source/round-trip.ts` diff is a rename/import change; digest
  material is identical to main.
- Messages cache-breakpoint placement matches main, including excluding
  restored turns.
- Messages target ceiling equals main's `max_tokens ?? fallback ?? constant`.
- Gateway diff is call-form migration plus folding `model` into the payload.
- Found: `anthropic-messages/as-source/input-to.ts:280,285` has a redundant
  `format === undefined` test (`input_schema` is required) and an avoidable
  `as unknown as Readonly<Record<string, unknown>>` on `klona(...)`.

## Confirmed from the protocol-subtree reviewer

14. **`round-trip/assistant-turn.ts` + `source-assistant-turn.ts` +
    `reference/assistant-turn.ts` import from `protocols/*/`.** The round-trip
    layer is conceptually below the protocols but acts as their type registry.
    It is the only genuine layering inversion in the package.
15. **Dead re-export** — `anthropic-messages/as-target/input-from.ts:302`
    `export type { IRInputAssistantContentPart }`; no consumer.
16. **`mediaFromUrl` + `DATA_URL` copied byte-identically** in three
    `as-source/input-to.ts` files (anthropic, chat, responses). Protocol-
    independent data-URL decoding.
17. **`isRecord` copied five times** while `shared/json/object.ts` already wraps
    the protocols package's `isJsonObject`.
18. **`verify*TurnDigest` is the same version-switch skeleton four times.**
19. **Tiny files with one consumer**: `openai-responses/as-source/response-id.ts`
    (1 line), `anthropic-messages/as-source/client-tools.ts` (6 lines),
    `gemini-generate-content/as-source/reasoning.ts` (15 lines).
20. **Gemini reader fragmented into five files** (`content.ts` 102, `tools.ts`
    49, `reasoning.ts` 15, `schema.ts` 46) where the other three protocols keep
    the same logic inline; `content.ts`/`tools.ts` have one consumer and no test.
21. **Chat `as-target.ts` (76 lines) holds payload-assembly helpers**
    (`legacyFunctionCallId`, `legacyFunctionCallNamesOf`) while the other two
    `as-target.ts` are 42/32 lines of pure protocol declaration.
22. **Error spelling split**: every protocol's `error-body.ts` owns the
    envelope while its `sse-to.ts` owns the wording and status mapping, despite
    comments saying the two must agree.
