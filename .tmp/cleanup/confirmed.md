# Confirmed comment defects — ir/input/types.ts (batch 1)

## C1 line 25-26 — stale, tools already present
"Tool declarations are not here yet, because `allowed_tools` selectors reference
them and the two must enter together."
Reality: IRInputRequest.tools and .tool_choice both exist (lines 121-123), and
IRInputToolChoice has the allowed_tools arm (line 177). Fix: delete the clause.

## C2 line 391-394 — contradicts the interface it documents
"No `name` field: Chat Completions, Responses, and Messages all correlate a
result to its call by ID, and GenerateContent is not a translation target."
Reality: IRInputToolResultItem.name exists (line 404) and the GenerateContent
reader sets it (as-source/input-to.ts:64-67). The claim "GenerateContent is not
a translation target" is true but is used here to justify a field that exists.
Fix: delete the "No `name` field" block; the per-field comment at 401-404 already
states the correct rule.

## C3 line 349-354 — false claim about Chat Completions
"Chat Completions is a target here but not a source ... its reader cannot
identify one and produces no reasoning item"
Reality: openai-chat-completions/as-source.ts exists, is wired in routes.ts, and
openaiChatCompletionsRead is a real reader. The second half of the claim
("GenerateContent is a source only: no route targets it") IS correct — verified:
routes.ts exports no *ViaGemini and geminiGenerateContentTargetProtocol does not
exist. So only the Chat "not a source" half is false.
Fix: rewrite to state only the durable fact: Chat's reasoning aliases have no
wire contract, so its reader yields no reasoning item, while its writer emits
`reasoning_text` for translated output.

## C4 line 51-54 — claims the opposite of the implementation
"A source that states several names keeps the widest ceiling it stated"
Reality: openai-chat-completions/as-source/input-to.ts:279
`const ceiling = payload.max_completion_tokens ?? payload.max_tokens;`
takes max_completion_tokens when present, NOT the wider of the two.
Fix: state the actual rule, or (behavior decision) report not fix.
The SAME false claim appears in the reader's own docblock:
openai-chat-completions/as-source/input-to.ts:213-221 "A request that states
both is collapsed to the wider bound" — while line 285 is
`payload.max_completion_tokens ?? payload.max_tokens`. Both blocks need the same
correction; neither implementation widens.

## C5 chat as-source/input-to.ts:323-331 — names a component that no longer exists
"Presenting the request, the conversation, and the reader that carries that
state together keeps the state with the code that needs it."
Reality: the return type is IRInputReading = { request, turns }. There is no
"reader" in the returned value; the state lives in a `context` closure captured
by each turn's `toIRTurn`. Fix: say that the closure keeps the state with the
thunks that need it.

## C6 types.ts:9-27 — describes fields the interface does not have
"Every field here comes from outside this package: the codec that carries
private sidecars, the model the caller resolved, and the runtime adapters a
protocol may need to state a request. A protocol reads the ones it needs and
ignores the rest, so there is one context rather than one per pair"
Reality: TranslateOptions has exactly two fields — `sidecarCodec` and
`fallbackMaxOutputTokens`. There is no model field (the same block later says
"No model travels here", so the block contradicts itself) and no runtime
adapters. Fix: drop the enumeration and the "one context rather than one per
pair" sentence, which describes a design this interface no longer is.

## C7 stale symbol name `apiError` -> `errorBody`
translate/src/types.ts:36 and gateway/src/data-plane/chat/shared/translate-traverse.ts:39-44
both call the hook `apiError`; TranslateTripResult declares `errorBody`
(translate/src/types.ts:79) and the gateway calls `trip.errorBody?.(...)`
(translate-traverse.ts:75). Also gateway:175. Fix: rename the referent in all
three comments.

## C8 ir/output/types.ts:82-88 — Messages misattributed on the output custom tool call
`IROutputCustomToolCallItem` labels every field `// ChatCompletions, Responses, Messages`,
but Messages has no custom-tool concept at all: its reader never produces one
(grep 'custom' in anthropic-messages/as-source/input-to.ts is empty) and its
writer throws `Messages cannot represent custom tool calls`
(anthropic-messages/as-source/sse-to.ts:156). The input IR's
IRInputCustomToolCallItem correctly says `// ChatCompletions, Responses`. Fix:
drop Messages from all four labels in this interface.

## C9 gemini-generate-content/as-source/input-to.ts:225-240 — same stale "reader" framing as C5
"Presenting the request, the conversation, and the reader that owns both
counters together keeps that state where it belongs"
Reality: returns IRInputReading = { request, turns }. The counters live in a
closure (`context`) captured by each turn's toIRTurn thunk; nothing returned is
a "reader". Fix: same as C5.

## C10 anthropic-messages/as-target/input-from.ts:295-299 — self-contradictory clause
"Messages states one ceiling, `max_tokens`, ... It has no `seed` and no
`max_tokens` alias"
The second clause reads as "Messages has no max_tokens", contradicting the
first. Intended meaning: Messages does not accept Chat's *other* name
`max_completion_tokens`. Fix: say that explicitly.
