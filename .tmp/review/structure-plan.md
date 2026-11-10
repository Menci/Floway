# Structure fixes — implementation order

Verified against the current tree. Grouped so each step is independently
compilable and testable.

## Step 1 — delete dead weight (no behaviour, minimal ripple)

1. `anthropic-messages/as-target/input-from.ts:302` — remove
   `export type { IRInputAssistantContentPart };` (no consumer).
2. `openai-responses/as-source/response-id.ts` (1 line) — move
   `createRandomOpenAIResponsesResponseId` into `as-source/sse-to.ts`, delete the
   file, update `as-source.ts`.
3. `anthropic-messages/as-source/client-tools.ts` (6 lines) — inline
   `filterAnthropicMessagesClientTools` into `anthropicMessagesToolsToIR`.
4. `gemini-generate-content/as-source/reasoning.ts` (15 lines) — inline
   `geminiGenerateContentThinkingLevelEffort` into `input-to.ts`; keep its test
   by re-pointing it at the new home or move the assertions to `input_test`.

## Step 2 — remove accidental duplication

5. New `shared/media.ts`: `dataURLToMedia(url: string): IRInputMedia` (the
   regex + body currently triplicated). Three readers import it.
   `AUDIO_MEDIA_TYPES` stays in Chat's reader.
6. `shared/json/object.ts`: export one `isJSONRecord` guard; replace the five
   local `isRecord` copies.
7. `round-trip/turn-digest.ts`: add `versionedTurnDigestVerifier(materialOf)`
   and `versionedTurnDigestComputer(materialOf)`; the four per-protocol
   `verify*`/`compute*` become one-line bindings of their material function.

## Step 3 — file placement

8. `ir/input/stream.ts` (17 lines) — same declaration covers it: a target-side
   helper in the input-IR directory. Only the filename collides with
   `ir/output/stream.ts`; rename to `require-streaming.ts` if anything.
9. ~~`ir/input/select-tools.ts`~~ — WITHDRAWN. `AGENTS.md:36` declares
   `ir/input/` to include "the target-side selection helpers", so this placement
   is the documented design, not a defect.
10. Gemini: fold `content.ts` and `tools.ts` into `input-to.ts` (single
    consumer each, no tests). Keep `schema.ts`.
11. Chat `as-target.ts`: move `legacyFunctionCallId` +
    `legacyFunctionCallNamesOf` into `as-target/segmented-request.ts`.
12. Error spelling: one `as-source/error.ts` per protocol holding both the
    envelope and the stream shape; `sse-to.ts` imports it.

## Step 4 — splits of the large readers

13. `openai-responses/as-target/sse-from.ts` — extract reconciliation
    (lines 80–540 family) into `as-target/reconcile.ts`, taking a context
    parameter rather than closing over generator locals.
14. `openai-responses/as-source/sse-to.ts` — extract the pure native-event
    constructors (`reasoning*`, `emptyContentPart`) into
    `as-source/native-events.ts`.
15. `ir/output/collector.ts` — extract `validate-value.ts` (walkValue,
    assertPlainValue, assertComplete) and `lifecycle.ts`.

## Deferred (needs a decision, not a mechanical move)

16. `protocols/composition.ts` test-only entrypoints (27 test files).
17. `round-trip/` importing protocol type tables (layering inversion).
18. `ir/common/` four tiny files — merge or keep.

## From the round-trip/composition reviewer (verified)

23. **`round-trip/reference/assistant-turn.ts` is four things in one file** and
    is a real cycle: each `protocols/*/as-target/assistant-turn.ts` imports the
    generic five types from it, while it imports those same four protocol
    modules to build `ReferenceableAssistantTurnByProtocol` /
    `AssistantTurnStateByProtocol`. Split: `reference-type.ts` (generic
    relations, no protocol import), `content-reference.ts` (the class +
    segments), `ReplayContent` into `restore.ts`, tables into the registry.
24. **`reference-builder.ts` / `reference-selection.ts` are cut by the wrong
    seam** — builder bookkeeping vs field state vs emitted placements vs
    finalizer vs budget policy vs turn rewriting all share two files.
25. **`reference/text-provenance.ts` has no round-trip consumer** — only the
    four source emitters use it; it is writer-side emission bookkeeping.
    Proposed `round-trip/provenance.ts`.
26. **`SidecarRecognition` is declared in `composition.ts`** (the pair-aware
    file) although it names one protocol; `resolve.ts` restates it inline.
27. **`composition/reading.ts` re-declares `ResolvedTurn`'s shape inline**
    instead of importing it from `segments.ts`. Files should stay separate.
    `Piece`/`Segment` are exported with zero importers.
28. **`types.ts` mixes the trip contract with the `TranslatorInputError`
    class**; `SidecarCodec` is split from `SidecarTaggedValue`.
29. **The protocol key set is hand-maintained in six places**, including a
    handwritten `||` chain of four string literals in `sidecar.ts` that no
    compiler checks against the type table.
30. **`composition.ts`'s three exports re-implement the same two step
    sequences** (write step ×3, stream wiring ×2).
31. **`text-groups.ts` mixes a generic channel-grouping utility with the
    reference placement index.**

## From the ir/shared reviewer (verified)

32. **`shared/reasoning-budget.ts` is OpenAI vocabulary** (effort names + 2048/8192
    edges); only the two OpenAI targets use it. `shared/custom-tool.ts` encodes
    the Responses `custom` arm as a single-`input` function schema and duck-types
    `format` instead of using `IRInputCustomToolFormat`. Both are cross-route
    formats, so they should move (not inline): `protocols/openai-reasoning.ts`
    and `protocols/custom-tool.ts`.
33. **`shared/call-ids.ts` / `flatten-request.ts` / `flat-names.ts` are pipeline
    stages that import `protocols/composition/segments.ts`** — `shared/` →
    `protocols/` is the backwards edge. Move into `protocols/composition/`.
    `flat-names.ts` has one importer and no test.
34. **`ir/output/stream.ts` conflates the record vocabulary with the builder**;
    `operation-paths ↔ stream` is a type-only cycle. Split `records.ts`.
35. **`ir/output/collector.ts` four responsibilities** (validation / lifecycle /
    ownership / collector); **`operation-paths.ts` three layers** (resolution /
    unit layout / record→units).
36. **`IRQueuedUnit`'s intrusive `nextPending` leaks a queue detail into three
    protocol unit interfaces.**
37. **`ir/output/types.ts` re-exports `ir/common` types**, forcing `shared/` and
    `round-trip/` to import the output IR for neutral JSON/text-range types.
38. **`ir/input/types.ts` mixes the wire model with the post-`assignCallIds`
    "addressed" model** (`IRInputAddressed*`, lines 224–244).
39. **`ir/common/` is not shared by both halves** — `ir/input/` never imports it;
    `absent.ts`/`text-range.ts` are output-side only. The `AGENTS.md` line
    "values both directions share" contradicts `absent.ts`'s own comment.
40. **`irSchemaMatchesIRTypes` is an export nothing imports** — drop `export`.
41. **`isIRAppendTarget` / `isIRAbsentTarget` have only test consumers.**
