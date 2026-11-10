# Behavior differences vs origin/main — classified

Base: `origin/main`. Branch: `feat/fit-ir-input` @ `0de0e97bd`.
Scope: packages/translate (+ the gateway comments it renamed).

## A. Existing bugs this branch fixes

1. **Gemini budget/effort** — main flattened a numeric budget into an effort name and dropped the level; the branch keeps both quantities on separate fields. main `gemini/as-source/tools.ts:48-53`; new `gemini/as-source/input-to.ts:277-283`.
2. **Chat ceiling read** — main read only `max_tokens`; the branch prefers `max_completion_tokens`. main `chat/via-responses/request.ts:187`; new `chat/as-source/input-to.ts:262`.
3. **Chat ceiling written** — main emitted the deprecated `max_tokens` (rejected by o-series); branch writes `max_completion_tokens`. new `chat/as-target/input-from.ts:285`.
4. **Chat→Responses grammar** — main passed a nested grammar straight through; branch flattens it. new `chat/as-source/input-to.ts:246-253`.
5. **Gemini no-arg call** — main dropped `arguments` for `functionCall` without `args`; branch writes `{}`. new `responses/as-target/input-from.ts:106`.
6. **tool_result structure** — main stringified multi-block / image tool results; branch keeps structured parts. new `messages/as-target/input-from.ts:92-104`.
7. **Gemini id-less pairing** — main matched by `'last'`, branch by `'first'`. new `gemini/as-source/input-to.ts`.
8. **Messages non-string metadata** — main silently dropped the whole field; branch raises `TranslatorInputError`. new `messages/as-source/input-to.ts:354-362`.
9. **Chat tool_result images** — main stuffed base64 into text; branch lifts them into a following user message. new `chat/as-target/input-from.ts:73-87`.
10. **Responses→Chat json_schema without name** — main sent it as-is; branch adds `name: 'response'`. new `chat/as-target/input-from.ts:308`.
11. **Chat choice count** — main threw `RangeError` past `maxChoices`; branch admits by sequence. See D1 for the residual question.
12. **Responses→Chat refusal** — main dropped model output; branch keeps it as Chat `refusal`. new `responses/as-source/input-to.ts:100-103`.
13. **Responses namespace on announcement** — fixed during this cleanup (`cbecfe0ae`); main restored it via `restoreNamespaceOutputItem`, and that restoration was lost when the helper went away.
14. **Undeclared grouped selector** — main raised `TranslatorInputError`; an intermediate cleanup step made it a bare `Error`, fixed in `0de0e97bd`.

## B. Requested by the session's user messages

1. Every request field lives in the IR (no route patches a writer's output).
2. The IR stores `namespace` + `name`; flat spelling exists only in targets.
3. Legacy tool-call form is accepted as input, never emitted.
4. `model` folds into the payload; `stream` lives in the IR and a target throws on `false`.
5. `server_tool_use` becomes a plain function call on the way in.
6. Consecutive user messages merge before the IR is handed out.
7. Cross-protocol errors are restated in the source protocol's shape; status/headers preserved, unrecognized bodies passed verbatim.
8. translate's IR-reading/writing code never knows the other side's protocol.
9. One package entry file exports the named routes.
10. Chat writer always asks for the fullest usage report.

## C. Obvious bugs on this branch (reported, NOT fixed)

1. **→Messages non-first system message** — main wrote `content: ''`; branch writes `content: []`, which the wire rejects. `messages/as-target/input-from.ts:252`.
2. **Responses→Messages `arguments:"null"`** — main produced `{raw_arguments:'null'}`; branch produces `input: null`. `messages/as-target/input-from.ts:144-155`.
3. **Gemini→Messages budget 0 + level** — main emitted `thinking:{type:'disabled'}`; branch emits no `thinking`. `messages/as-target/input-from.ts:308-324`.
4. **Orphan `functionResponse`** — main synthesized a positional id; branch throws a bare `Error` → 502. `shared/call-ids.ts:35-41`.
5. **Orphan `tool_choice` without tools** — main omitted it (xAI-backed upstreams reject the shape, per its own comment); branch writes `'auto'`. `chat/as-target/input-from.ts:262`; main `chat/via-responses/request.ts:189-192`.
6. **Messages→Responses orphan `auto`/`none` without tools** — main omitted; branch writes.
7. **Responses→Chat multi-part text joins with `\n\n`** — main concatenated with no separator. `chat/as-target/input-from.ts:54`; main `responses/via-chat/request.ts:31`.
8. **Messages→Chat multi-part tool-result text** — main used `\n\n`, branch uses `''`. `chat/as-target/input-from.ts:79`.
9. **Gemini→Chat thought text** — main used `\n\n`, branch uses `''`. `chat/as-target/input-from.ts:103-104`.
10. **Messages→Chat legacy round-trip** — the assistant turn is written without a `function_call` id while the result carries a `tool_call_id` nothing declared. `chat/as-target.ts:17` + `shared/call-ids.ts:57-64`.
11. **Messages→Chat multiple `search_result` blocks** — each is stringified separately, producing `[{a}][{b}]`, which is not valid JSON. `messages/as-source/input-to.ts:98` + `chat/as-target/input-from.ts:79`.

## D. Needs discussion

1. **Choice count ceiling** — `maxChoices` was removed by deliberate commit `cb8002413` ("the upstream's own count is what decides how many there are"). Consequence: an upstream reporting more choices than the request's `n` is now rendered. Whether to keep this relaxation is a product decision.
2. **Responses terminal snapshot no longer echoes `tools` / `tool_choice`** — main rewrote them back to the client's original declarations; the IR carries no request declarations into the returned stream, so restoring them needs a new path.
3. **Remote images** — main fetched them and converted to base64 (dropping unsupported ones); the branch forwards the URL and accepts `input_file`/`document`. Fits the Fit rule but changes what a Messages target receives.
4. **Responses source HTTP error body** — restated as the SSE event shape `{type:'error',message,code,param}` rather than the HTTP envelope `{error:{...}}`; a client parsing `error.message` may now miss it.
5. **Gemini→Messages tool declarations** — main wrote `type:'custom'`, branch omits it.
6. **Responses→Chat single system message** — main kept the array form, branch folds to a string.
7. **Responses source reasoning** — main used only `summary`, branch merges `summary` + `content`.
8. **Unmodelled inlineData MIME** — main threw, branch forwards as a Chat `file`.
9. **Metadata forwarding (Messages source / Chat target)** — main never sent it, branch does.
10. **Dropped-reasoning warning** — main logged `console.warn`, branch is silent (commit `a4cc8f404`).
11. **Same-name namespace function+custom** — main threw "ambiguous", branch merges flat names.
