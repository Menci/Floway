# Verified naming findings (main agent, independently confirmed)

Each entry was checked against the current source, not taken from an agent report.

## A. One name, two unrelated meanings

1. `roundTrip` in `src/protocols/composition.ts:38` (member, `SourceRoundTrip`, inbound
   sidecar recognition) vs `:50` (parameter of `writeStream`, `RoundTripWriter`, outbound
   writing). Same interface, opposite directions.
2. `legacyCalls` — `as-source/input-to.ts:63` `Map<name, occurrenceCount>`;
   `as-target.ts:37` `Map<callId, name>`; `as-target/segmented-request.ts:23` the latter.
3. `ContentState` — `round-trip/reference/reference-builder.ts:31` is the *emitted* field
   state; `gemini-generate-content/as-source/sse-to.ts:108` reuses the bare name for the
   per-content sidecar state and must alias the real one as `ReferenceContentState`.
4. `Segment` — composition conversation segment, `ReferenceSegment` range,
   `TextGroup.segments` offset records, `ContentReferenceSegment`.
5. `Candidate` in `round-trip/resolve.ts:19,26` — sidecar carrier vs replay material.

## B. Same concept, several names

6. `keyof AssistantTurnByProtocol` — `RoundTripProtocol` (sidecar.ts:7),
   `AssistantTurnKey` (composition.ts:18), `NativeProtocol` (test).
7. `openaiChatCompletionsFromIR` — `as-source/sse-to.ts:82` (IR → Chat SSE) and
   `as-target/input-from.ts:188` (IR → messages array only). The other two targets call
   the same thing `*ConversationFromIR`.
8. Prompt-part extraction across readers: `textParts` (Chat), `systemContent` (Responses),
   `textBlocks` (Messages).
9. `settleReading`/`settleTurns` vs the layer's own `resolved`/`resolve` vocabulary.

## C. Name promises something the code does not do

10. `IRInputSystemMessageItem` — discriminant is `'prompt'`, role may be `'developer'`.
11. `streamingFlag()` — throws; reads like a getter.
12. `GeminiGenerateContentFunctionResponsePart` (`as-source/tools.ts:17`) collides with the
    real protocol type of the same name (`packages/protocols/.../index.ts:36`).
13. `FlatNameRequest` — a `{ namespace, name }` pair, neither a request nor a call.
14. `parseJSONObjectAtCompletion` — the point is to *decline* to parse a truncated one.
15. `allowNone` (`collector.ts:20`) — `none` is tool_choice/reasoning vocabulary; the flag
    governs `IRAbsent`.
16. `rejectProgrammaticOpenAIResponsesPayload(payload, target)` — `target` only fills an
    error string; the sole call site passes the constant `'translation'`.
17. `irMessagesError` / `irGenerateContentError` / `irChatError` — consume an `IRErrorPayload`
    and produce a protocol object, while `ir<X>` elsewhere means "produces the IR".
18. `GeminiGenerateContentText` (`content.ts:65`) takes a `Content`, not a `Part`, and its
    sibling `PartText` includes thought text.
19. `TextPlacement.text` — the enclosing concatenated text, not this field's text.
20. `IR` (bare, `ir/output/types.ts:17`) — the accumulated output IR value, while every
    member type is `IROutput*` and "IR" alone means the whole concept package-wide.
21. `textParts(value, keepEmpty = false)` — positional boolean at `input-to.ts:182`.
22. `choice.refusal` is `{ category, explanation }` while `content[].refusal` is a `string`
    (`ir/output/types.ts:27` vs `:59`). `IROutputClassifierRefusal` also invents a
    classifier: `category` comes from `stop_details.category` / `error.code`.
23. `media_type` (input IR) vs `mime_type` (output IR) for the same value.
24. `candidate_count` is Gemini's `candidateCount`; the output half calls the same
    quantity `choices`, Chat calls it `n`.
25. `irSchemaMatchesIRTypes` is a compile-time assertion with zero call sites, named
    like a runtime predicate.
26. `createIROrdinalMapper` — every consumer names its result `index`; the IR's own
    fields are `item_index`/`content_index`.
27. `collector.optional()` returns value | undefined | `IRAbsent` — three states, no hint.
28. `dequeue()` returns void, unlike the conventional queue verb.
29. `IRWriteHandle.resolve()` only concatenates a base path; the real resolver is
    `resolveIRPath`.
30. `IRInputToolSelection` vs the package's own word "selector".
31. `openaiResponsesTurnToIR` inlines `OpenAIResponsesConversationTurn` instead of naming it.
32. `rejectProgrammaticOpenAIResponsesPayload(payload, 'translation')` — see 16.
33. `createRandomOpenAIResponsesResponseId` — triple "response".
34. `const ir = createIRBuilder()` in all three target readers — `ir` is a writer.
35. `TextGroup.segments` collides with composition `Segment` (see 4).
36. `candidate` has four meanings; the only conflicting pair is `resolve.ts` (sidecar
    carrier) and `flat-names.ts` (string candidate) — the 26 replay uses are consistent.
37. `target` means "target protocol" everywhere, except `WriteTarget` /
    `ResponsesTextTarget` in `openai-responses/as-target/sse-from.ts:32,37`, which are
    handle + relative path.
38. `startForContent` (`chat .../as-target/sse-from.ts:193`) only guards `hasModel`
    before calling `start`.
39. `validateAllowedTools`'s `expanded` loop binds each element to `selector` and then
    `selected_`; the elements may be either the original selector or an expanded member.
40. `TextPlacement.text` is the enclosing channel text; `textViews`/`contentViews` are
    both `TextPlacement` carriers but differ only by nesting depth.
