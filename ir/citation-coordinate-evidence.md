# Citation coordinate evidence

This note preserves the session's observations and provisional interpretation for future implementation comments and Pull Request experiment material. Protocol names are ChatCompletions, Responses, Messages, and GenerateContent. In A via B, A is the client protocol and B is the upstream protocol; requests flow → and responses flow ←.

## Current interpretation

| Protocol | Coordinate referent | Unit | End convention | Evidence status |
| --- | --- | --- | --- | --- |
| ChatCompletions | Generated message text | Unicode code point, provisionally | Exclusive | Real captures exclude UTF-8 bytes and establish half-open ranges; code point versus UTF-16 remains an inference. |
| Responses | Generated output text | Unicode code point | Exclusive | Direct Copilot `gpt-6-luna` probes distinguish all three units using supplementary characters. Applies to the tested URL citation paths. |
| Messages | Source document text for `char_location` citations | Unicode code point | Exclusive | A captured response and its source document distinguish code points from UTF-16 with 📖. |

The intended IR and IAT coordinate unit is UTF-16 code units, preserving JavaScript string contents including lone surrogates. Converting an upstream code-point range into IR therefore requires calculating its corresponding UTF-16 offsets. The IR range type is `IRUTF16TextRange`.

ChatCompletions' code-point unit must be described as inferred in implementation comments. Responses' tested behavior must not be presented as experimental proof about ChatCompletions, every provider, or every annotation type.

## Direct Copilot experiments

The probes used the checked-in `probing-copilot` skill. Credentials were selected through a read-only production D1 query, exchanged at GitHub's token endpoint, and used against the token-advertised Copilot data-plane endpoint. Both exchange and data-plane traffic used the same configured SS proxy fallback. Requests did not traverse Floway. Headers followed the current provider authentication implementation. Credentials were never included in the experiment output; no database or repository changes were made by the probes.

The experiments ran during the session dated 2026-10-10 in Asia/Singapore. HTTP `/models` returned 200 and listed the exact requested model IDs. The observations below retain selected response fields, not complete raw HTTP recordings. Missing request or response details must not be reconstructed as if recorded.

### Retained Responses request

The successful Unicode-prefix probe used this exact body at `/responses`:

```json
{
  "model": "gpt-6-luna",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Use the built-in web search tool now to find the official Unicode character name for U+1F4D6. Begin the final answer exactly with the literal prefix A😀中B followed by one space. Then state the code point and official Unicode name in one short sentence, and include the literal symbol 📖 within that factual sentence. Do not type a URL, footnote, bracketed citation, or citation JSON; let the API provide server-generated source annotations."
        }
      ]
    }
  ],
  "tools": [{ "type": "web_search", "search_context_size": "low" }],
  "tool_choice": "required",
  "include": ["web_search_call.action.sources"],
  "reasoning": { "effort": "low" },
  "text": { "verbosity": "low" },
  "max_output_tokens": 1400
}
```

The `web_search_preview` request differed only in `tools[0].type`. The ASCII-prefix control retained the same settings with `web_search`, replacing `input` with:

```json
[
  {
    "role": "user",
    "content": "Use the built-in web search tool to find the official Unicode source confirming the name for U+1F4D6. Begin the final answer exactly with the ASCII prefix ASCII followed by one space. Then state the code point and official Unicode name in one short sentence that contains the literal symbol 📖. Do not type a URL, footnote, bracketed citation, or citation JSON; allow the server to attach its source annotation."
  }
]
```

### Responses: supplementary-character probe

Exact request model: `gpt-6-luna`; endpoint: `/responses`; native tool: `web_search`. The request returned HTTP 200 and a completed native search call with a server-generated `url_citation`.

```json
{
  "text": "A😀中B U+1F4D6 is officially named OPEN BOOK 📖. ([unicode.org](https://www.unicode.org/charts/PDF/U1F300.pdf?utm_source=openai))",
  "annotation": {
    "type": "url_citation",
    "start_index": 46,
    "end_index": 126,
    "title": "The Unicode Standard, Version 17.0",
    "url": "https://www.unicode.org/charts/PDF/U1F300.pdf?utm_source=openai"
  }
}
```

| Measurement | Result |
| --- | --- |
| Full text, Unicode code points | 126 |
| Full text, UTF-16 code units | 128 |
| Full text, UTF-8 bytes | 134 |
| Code-point range `[46,126)` | Complete parenthesized Markdown citation link |
| Corresponding UTF-16 range | `[48,128)` |
| Corresponding UTF-8 range | `[54,134)` |

The actual JavaScript code-unit slice at the reported coordinates was:

```text
. ([unicode.org](https://www.unicode.org/charts/PDF/U1F300.pdf?utm_source=openai
```

Code-point slicing selected:

```text
([unicode.org](https://www.unicode.org/charts/PDF/U1F300.pdf?utm_source=openai))
```

Thus the reported offsets count code points, and the reported end equals the exclusive code-point text length. The supplementary characters precede the citation; no supplementary character inside the generated citation link was observed.

### Responses: independent checks

| Tool / output | Reported range | Code-point length | UTF-16 length | UTF-8 length | Observation |
| --- | --- | --- | --- | --- | --- |
| `web_search_preview`, Unicode-prefix variant | `[46,146)` | 146 | 148 | 154 | Code-point slicing selected the complete citation link; code-unit and byte slicing did not. |
| `web_search`, ASCII-prefix control | `[49,129)` | 129 | 130 | 132 | Code-point slicing again selected the complete citation link. |

The ASCII-prefix control began `ASCII U+1F4D6 is officially named OPEN BOOK (📖). `, so a supplementary character still occurred before the citation. These are independent returned outputs, not synthetic annotations supplied by the model in its message text.

Retained output and annotation for `web_search_preview`:

```json
{
  "text": "A😀中B U+1F4D6 is officially named OPEN BOOK 📖. ([unicode.org](https://www.unicode.org/Public/UCD/latest/charts/nameslist/1f300/?utm_source=openai))",
  "annotation": {
    "type": "url_citation",
    "start_index": 46,
    "end_index": 146,
    "title": "Miscellaneous Symbols and Pictographs – Unicode 18.0.0",
    "url": "https://www.unicode.org/Public/UCD/latest/charts/nameslist/1f300/?utm_source=openai"
  }
}
```

Retained output and annotation for the ASCII-prefix control:

```json
{
  "text": "ASCII U+1F4D6 is officially named OPEN BOOK (📖). ([unicode.org](https://www.unicode.org/charts/PDF/U1F300.pdf?utm_source=openai))",
  "annotation": {
    "type": "url_citation",
    "start_index": 49,
    "end_index": 129,
    "title": "The Unicode Standard, Version 17.0",
    "url": "https://www.unicode.org/charts/PDF/U1F300.pdf?utm_source=openai"
  }
}
```

### ChatCompletions: normal models

| Requested model | Returned model | Normal generation | Search-option observations |
| --- | --- | --- | --- |
| `gpt-4o` | `gpt-4o-2024-11-20` | HTTP 200 | Three attempts with `{}`, `search_context_size: "low"`, and `search_context_size: "medium"` returned no native annotations. The first two stated that live search was unavailable; the third returned plain factual text. |
| `gpt-5-mini` | `gpt-5-mini` | HTTP 200, `READY`, finish reason `stop` | `{}` and `search_context_size: "low"` returned no native annotations and stated that live search was unavailable. |
| `gpt-4.1` | `gpt-4.1-2025-04-14` | HTTP 200, `READY`, finish reason `stop` | `{}` and `search_context_size: "low"` returned plain text without native annotations. |

The successful normal `gpt-5-mini` request used `reasoning_effort: "low"` and `max_completion_tokens: 512`. An earlier 32-token budget ended with empty content and finish reason `length`; it did not establish endpoint failure.

The normal-generation prompt was `Reply with only the word READY.`. The successful normal `gpt-4.1` request used `max_tokens: 64`.

The search attempts for `gpt-5-mini` and `gpt-4.1` used this shared message:

```json
{
  "role": "user",
  "content": "Use live web search now for an official Unicode source confirming the character name for U+1F4D6. Begin the response exactly with the literal prefix A😀中B followed by one space. State the code point and official Unicode name in one short factual sentence that includes the literal symbol 📖. Do not type a URL, footnote, Markdown citation, or citation JSON. If live search is unavailable, say so plainly."
}
```

Their bodies set `model`, `messages: [the message above]`, and one of the two tested `web_search_options` values. `gpt-5-mini` additionally used `reasoning_effort: "low"` and `max_completion_tokens: 1024`; `gpt-4.1` used `max_tokens: 256`.

All three `gpt-4o` search attempts used `max_tokens: 180`. Their retained prompts were:

- Low-context attempt: `Search the web now for the official Unicode character name for U+1F4D6. Begin the answer exactly with the literal prefix A😀中B followed by one space. Then state the code point and official Unicode name in one short sentence, and include the literal symbol 📖 within that factual sentence. Do not type any URL, footnote, bracketed citation, or citation JSON. Use the search result rather than prior knowledge.`
- Empty-options attempt: retained as the same prompt with an ending asking `If live search unavailable, say that plainly.` The exact replacement versus addition of the final sentence was not retained unambiguously.
- Medium-context attempt: `Use web search to check the official Unicode name for U+1F4D6. Begin the answer exactly with A😀中B followed by a space; state the code point and official name in one short sentence, including 📖. Do not type a URL, footnote, bracketed citation, or citation JSON; use live search if available, and say plainly if it is unavailable.`

These experiments establish ChatCompletions endpoint availability for the tested models. They do not measure citation offsets or prove absence of other citation mechanisms.

## Native ChatCompletions citation trigger

The inspected [official web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search) documents a dedicated search-model path:

```json
{
  "model": "gpt-5-search-api",
  "web_search_options": {},
  "messages": [
    { "role": "user", "content": "What was a positive news story from today?" }
  ]
}
```

Native returned citations are under `choices[].message.annotations[].url_citation`. Ordinary `gpt-4o`, `gpt-5-mini`, and `gpt-4.1` requests with `web_search_options` did not exercise that documented search-model path. Access to the dedicated search model was unavailable for further probes.

The [pinned official SDK](https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/resources/chat/completions/completions.ts#L1871) associates message annotations with web search and declares the nested URL citation shape. Its [request definition](https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/resources/chat/completions/completions.ts#L2710) declares `web_search_options` separately from function/custom tools. The documentation's character-index wording does not resolve code point versus UTF-16. Model-authored citation JSON in `message.content` is not evidence about native response-envelope annotations.

## Public response captures

### ChatCompletions

[Actual SSE fixture, pinned revision](https://github.com/achappey/aihappey-ai/blob/8d791a6dc9696ade9876cfcbd3bb16bd4f17d7a6/Core/AIHappey.Tests/Fixtures/chat-completions/raw/openai-web-search-chat-completions.jsonl): returned model `gpt-5-search-api-2025-10-14`.

After concatenating `choices[0].delta.content`, the text lengths are 538 code points, 538 UTF-16 units, and 542 UTF-8 bytes. Native annotations are delivered in a later `delta.annotations`.

| Reported range | Code-point / UTF-16 slice | UTF-8 byte slice |
| --- | --- | --- |
| `[73,162)` | Complete parenthesized axios.com link | Same, because preceding text is ASCII |
| `[231,341)` | Complete parenthesized axios.com link | Misaligned after `vóór`; begins with preceding punctuation and truncates the link |
| `[434,538)` | Complete final parenthesized axios.com link | Misaligned after non-ASCII text; truncates the link |

The first two ends are followed by spaces; the final end equals the full character length. This establishes end-exclusive behavior in the capture. There are no supplementary characters in the body, so code point versus UTF-16 cannot be distinguished.

A second [ChatCompletions-shaped capture](https://github.com/b0glarka/ai-search-visibility/blob/a93e946d384084f438eb80f319bc8c31783402e8/data/raw/gpt-web_q3_run2.json), with `model: "openai/gpt-5.5"` and `provider: "OpenAI"`, was routed through OpenRouter. Its `[328,421)` citation selects the complete fidelity.com Markdown link by character offsets, and position 421 is the following newline. Preceding `’` and `—` invalidate byte slicing. It likewise has no supplementary characters; forwarding through OpenRouter also limits provenance.

### Responses

[Official Cookbook captured output, pinned revision](https://github.com/openai/openai-cookbook/blob/5bd6cb40b6b84b69b2032d810610aa85064102df/examples/responses_api/responses_api_tool_orchestration.ipynb#L776): U+2019 appears at code-point position 531. Citation `[625,753)` selects the complete rifnote.com Markdown link; position 753 is a newline. UTF-8 slicing is displaced by two bytes. All five citations align with half-open character ranges. The body has no supplementary characters, so this capture alone does not distinguish code points from UTF-16; the live experiment above does.

### Messages

[Captured `char_location` citation](https://github.com/cschoelzel/Statlas/blob/230da4c832b86dfafd2057e7bd92c2569872dfdf/data/extraction/D084.citations.response.json#L14) and [matching source document](https://github.com/cschoelzel/Statlas/blob/230da4c832b86dfafd2057e7bd92c2569872dfdf/participant-final-no-hour16%203/corpus/text/D084.txt#L25): range `[732,1080)` selects a quote containing 📖.

| Measurement | Result |
| --- | --- |
| Reported range width | 348 |
| Quote code-point length | 348 |
| Quote UTF-16 length | 349 |
| Quote UTF-8 length | 353 |
| Code-point slice matches quote | Yes |
| UTF-16 slice at reported offsets matches | No |
| Corresponding UTF-16 range | `[732,1081)` |

These coordinates refer to the source document, not the generated assistant text. They cannot be copied into an IR output-text range. [A Python consumer](https://github.com/Peter-McCann-Strain/chemical-patent-analysis/blob/e50f08614cb272ceff1bfffb1ffbf83fb087b376/api/src/api/services/chat_stream.py#L239) and [another consumer](https://github.com/Grzmro/RAG/blob/1d6a00f8f0e9bc881d1c265e379081c3ab0614bb/rag/citations.py#L67) slice source text using these character coordinates.

## Client and gateway interpretations

### Explicit code-point interpretation: new-api

[ChatCompletions annotation conversion](https://github.com/QuantumNous/new-api/blob/1d4328e97417a043a161a0dd30a5b129be3ace49/relaykit/relayconvert/internal/oai_chat/citations.go#L56):

```go
runes := []rune(text)
return string(runes[start:end])
```

The caller reads nested `annotation["url_citation"]`. This explicitly interprets ChatCompletions coordinates as code points and end-exclusive. It is a gateway implementation assumption, not an upstream specification.

### Conflicting direct client: Promptfoo

[Native ChatCompletions annotation consumer](https://github.com/promptfoo/promptfoo/blob/69e0c140de5e3d08c0def5ee028946a718d16a1a/src/providers/openai/chat.ts#L125):

```ts
output.slice(citation.start_index, citation.end_index + 1).trim()
```

The [call site](https://github.com/promptfoo/promptfoo/blob/69e0c140de5e3d08c0def5ee028946a718d16a1a/src/providers/openai/chat.ts#L1368) supplies `message.annotations`. This assumes UTF-16 and an inclusive end. Its [test](https://github.com/promptfoo/promptfoo/blob/69e0c140de5e3d08c0def5ee028946a718d16a1a/test/providers/openai/chat.test.ts#L1392) uses a hand-authored ASCII response `Current answer`, start 0, end 6, and expects `Current`. It does not test supplementary characters or validate a real server response. The inclusive-end assumption conflicts with the captures above; `.trim()` can conceal an extra space or newline. This is not sufficient evidence for a UTF-16 upstream contract.

### Pass-through official client

[OpenAI Agents JS ChatCompletions streaming adapter](https://github.com/openai/openai-agents-js/blob/0712e8e8ee40aa00a80f5ebf782e7cc85394d494/packages/agents-openai/src/openaiChatCompletionsStreaming.ts#L105) validates and retains `start_index` and `end_index` without slicing or coordinate conversion. Its implementation language does not establish the upstream coordinate unit.

### Other consumers and limitations

- [LobeHub](https://github.com/lobehub/lobehub/blob/d65f485941cca3e558074ac080590f7efd82a9fb/packages/model-runtime/src/core/streams/openai/openai.ts#L364) extracts native ChatCompletions citation URL/title and discards coordinates.
- [Mattermost UI](https://github.com/mattermost/mattermost-plugin-agents/blob/4491b8a6b9f7e00459124b12961a08fe45817332/webapp/src/components/citations/citation_processor.tsx#L12) inserts markers with JavaScript slicing, and its [type](https://github.com/mattermost/mattermost-plugin-agents/blob/4491b8a6b9f7e00459124b12961a08fe45817332/llm/annotations.go#L14) describes UTF-16. However, the inspected [adapter](https://github.com/mattermost/mattermost-plugin-agents/blob/4491b8a6b9f7e00459124b12961a08fe45817332/bifrost/annotations.go#L25) consumes normalized Responses annotations. Tests use ASCII. This is not direct ChatCompletions evidence and conflicts with the tested Responses behavior.
- [SymbolicAI](https://github.com/ExtensityAI/symbolicai/blob/89ea6976cf3a3463c56b175c0348f7f268cf2d18/symai/backend/engines/search/openai/engine.py#L69) consumes Responses output annotations and uses Python code-point lengths; its [renderer](https://github.com/ExtensityAI/symbolicai/blob/89ea6976cf3a3463c56b175c0348f7f268cf2d18/symai/backend/engines/search/utils.py#L170) uses half-open Python slices. It is not ChatCompletions evidence.
- [Tinfoil's producer](https://github.com/tinfoilsh/confidential-model-router/blob/e6ed815880fde6511fcec4dc3aeddf73209e9742/toolruntime/citations/state.go#L179) converts byte offsets to rune offsets when emitting ChatCompletions-style annotations. Its [test](https://github.com/tinfoilsh/confidential-model-router/blob/e6ed815880fde6511fcec4dc3aeddf73209e9742/toolruntime/citations/state_test.go#L204) distinguishes bytes from characters using BMP text, not code points from UTF-16. It records another implementation assumption.

Research included global web searches and global GitHub code searches across annotation field names, protocol names, slicing operations, coordinate encodings, and language-specific consumers. Schema declarations, pass-through adapters, URL-only displays, hand-authored annotations, and consumers of another protocol were not treated as proof of native ChatCompletions units. Some follow-up GitHub searches reached the shared API rate limit. No inspected direct ChatCompletions client supplied a supplementary-character test establishing its coordinate interpretation.

## Future implementation and PR use

When coordinate conversion is implemented, comments should cite pinned primary sources and distinguish measured behavior from assumptions. Per the repository's comment policy, committed code comments must not cite this temporary research note.

For the corresponding PR, include the Responses Unicode probe's selected response, measured lengths, and slice comparison; include the native ChatCompletions fixture and contradictory client behavior alongside the explicit code-point inference. Present retained fragments as selected observations, not complete raw recordings. Attach any subsequently saved experiment file through the GitHub attachment workflow when PR work is requested.

Pending evidence that could settle ChatCompletions' unit is an authentic native annotation response with a supplementary character before its range, or a primary upstream contract explicitly specifying the coordinate unit. Current lack of access to a dedicated ChatCompletions search model does not justify promoting a client assumption to an experimental result.
