// Responses API type definitions
// Used for translating Messages ↔ Responses APIs

// ── Request types ──

export interface ResponsesPayload {
  model: string;
  input: string | ResponsesInputItem[];
  previous_response_id?: string | null;
  instructions?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  // Per the OpenAI Responses spec: "The maximum number of total calls to
  // built-in tools that can be processed in a response. This maximum
  // number applies across all built-in tool calls, not per individual
  // tool. Any further attempts to call a tool by the model will be
  // ignored." Reference (openai-python parameter declaration):
  // https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_create_params.py
  max_tool_calls?: number | null;
  tools?: ResponsesTool[] | null;
  tool_choice?: ResponsesToolChoice;
  metadata?: Record<string, unknown> | null;
  stream?: boolean | null;
  store?: boolean | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: {
    effort?: string;
    summary?: 'detailed' | 'auto' | 'concise' | (string & {});
  };
  include?: string[];
  // `text.verbosity` is a native GPT-5-family Responses field that controls
  // response length; `text.format` carries structured-output schemas. Both
  // ride on the same `text` object.
  // Reference: https://platform.openai.com/docs/api-reference/responses/create
  text?: { format?: Record<string, unknown> | null; verbosity?: string | null } | null;
  prompt_cache_key?: string | null;
  safety_identifier?: string | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
}

// Narrower payload for `/responses/compact`. The official endpoint accepts a
// strict subset of `/responses` fields — model/input/instructions/
// previous_response_id/prompt_cache_*/service_tier — plus we honour `store`
// as a gateway-policy hint for snapshot persistence. Anything from
// `ResponsesPayload` not listed here (tools, temperature, max_output_tokens,
// reasoning, stream, etc.) is create-only and would be rejected or silently
// ignored by the upstream compact endpoint.
// Reference: https://developers.openai.com/api/reference/resources/responses/methods/compact
export interface ResponsesCompactPayload {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string | null;
  previous_response_id?: string | null;
  prompt_cache_key?: string | null;
  prompt_cache_retention?: 'in_memory' | '24h' | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  // Gateway-only: controls whether the compact response's output items + the
  // committed snapshot persist. Forwarded NEITHER to upstream nor to the
  // provider call body.
  store?: boolean | null;
}

// Project a (possibly-wider) ResponsesPayload-shaped object into the strict
// compact wire shape. Every native-compact provider terminal calls this
// before dispatching to its upstream's `/responses/compact` endpoint, so a
// post-chain action pivot that arrived carrying generate-only fields
// (tools/temperature/reasoning/...) cannot leak them onto the compact wire.
// `model` and `store` are caller-supplied at the dispatch site (model is
// the resolved upstream id; store is gateway-only). `prompt_cache_retention`
// only exists on the compact payload type today, so there is no
// generate-side value to forward.
export const toCompactPayloadShape = (payload: Omit<ResponsesPayload, 'model'>): Omit<ResponsesCompactPayload, 'model' | 'store'> => ({
  input: payload.input,
  ...(payload.instructions !== undefined && { instructions: payload.instructions }),
  ...(payload.previous_response_id !== undefined && { previous_response_id: payload.previous_response_id }),
  ...(payload.prompt_cache_key !== undefined && { prompt_cache_key: payload.prompt_cache_key }),
  ...(payload.service_tier !== undefined && { service_tier: payload.service_tier }),
});

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionToolCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesCustomToolCallItem
  | ResponsesCustomToolCallOutputItem
  | ResponsesInputReasoning
  | ResponsesItemReference
  | ResponsesInputWebSearchCall
  | ResponsesFileSearchCallItem
  | ResponsesComputerCallItem
  | ResponsesComputerCallOutputItem
  | ResponsesToolSearchCallItem
  | ResponsesToolSearchOutputItem
  | ResponsesCompactionItem
  | ResponsesCompactionTriggerItem
  | ResponsesInputImageGenerationCall
  | ResponsesCodeInterpreterCallItem
  | ResponsesLocalShellCallItem
  | ResponsesLocalShellCallOutputItem
  | ResponsesShellCallItem
  | ResponsesShellCallOutputItem
  | ResponsesApplyPatchCallItem
  | ResponsesApplyPatchCallOutputItem
  | ResponsesMcpCallItem
  | ResponsesMcpListToolsItem
  | ResponsesMcpApprovalRequestItem
  | ResponsesMcpApprovalResponseItem;

export interface ResponsesInputMessage {
  type: 'message';
  id?: string;
  status?: string;
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesInputContent[];
}

export type ResponsesInputContent = ResponsesInputText | ResponsesInputImage;

export interface ResponsesInputText {
  type: 'input_text' | 'output_text';
  text: string;
}

export interface ResponsesInputImage {
  type: 'input_image';
  image_url: string;
  detail: 'auto' | 'low' | 'high';
}

export interface ResponsesInputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  // Opaque reasoning blob the upstream signs against `(account, id)`. Never
  // auto-requested via `include: ['reasoning.encrypted_content']` (forcing it
  // breaks non-OpenAI reasoning models); present only when the upstream
  // volunteers it, and round-tripped verbatim so the next-turn signature
  // check passes.
  encrypted_content?: string;
}

export interface ResponsesFunctionToolCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed' | 'in_progress' | 'incomplete';
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  id?: string;
  call_id: string;
  // Multimodal tool outputs carry an array of content parts (e.g. a screenshot
  // tool returning `input_image` parts) in addition to the plain-string form.
  output: string | ResponsesInputContent[];
  status?: 'completed' | 'incomplete';
}

// Freeform custom tool invocation echoed back to the model in conversation
// history. The model's own emission of a custom tool call is identical in
// shape (it is also a `custom_tool_call` item).
export interface ResponsesCustomToolCallItem {
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  input: string;
  id?: string;
  namespace?: string;
  status?: string;
}

export interface ResponsesCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id: string;
  output: string;
  id?: string;
  status?: string;
}

export interface ResponsesItemReference {
  type: 'item_reference';
  id: string;
}

// Tolerant input mirror of ResponsesOutputWebSearchCall: clients may
// echo previously emitted web_search_call items back. Every field is
// optional so the wire shape accepts whatever the client carries.
export interface ResponsesInputWebSearchCall {
  type: 'web_search_call';
  id?: string;
  status?: 'completed' | 'in_progress' | 'searching' | 'failed';
  action?: ResponsesWebSearchAction;
  results?: ResponsesWebSearchResult[];
}

export interface ResponsesPermissiveItem<TType extends string> {
  type: TType;
  id?: string;
  call_id?: string;
  status?: string;
  output?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

export interface ResponsesFileSearchCallItem extends ResponsesPermissiveItem<'file_search_call'> {
  queries?: string[];
  results?: unknown[];
}

export interface ResponsesComputerCallItem extends ResponsesPermissiveItem<'computer_call'> {
  call_id: string;
  action?: unknown;
  pending_safety_checks?: unknown[];
}

export interface ResponsesComputerCallOutputItem extends ResponsesPermissiveItem<'computer_call_output'> {
  call_id: string;
  output?: unknown;
  acknowledged_safety_checks?: unknown[];
}

export interface ResponsesToolSearchCallItem extends ResponsesPermissiveItem<'tool_search_call'> {
  call_id?: string;
  query?: string;
  results?: unknown[];
}

export interface ResponsesToolSearchOutputItem extends ResponsesPermissiveItem<'tool_search_output'> {
  call_id?: string;
  output?: unknown;
}

export type ResponsesCompactionItem = ResponsesPermissiveItem<'compaction'>;

// Trailing input item recognised by codex's RemoteCompactionV2: the upstream
// turns a normal `/responses` call into a compaction round-trip and replies
// with a single `compaction` output item. Payload-free on the wire (any extra
// keys are tolerated by the permissive base).
export type ResponsesCompactionTriggerItem = ResponsesPermissiveItem<'compaction_trigger'>;

export interface ResponsesCodeInterpreterCallItem extends ResponsesPermissiveItem<'code_interpreter_call'> {
  call_id?: string;
  code?: string;
  results?: unknown[];
}

export interface ResponsesLocalShellCallItem extends ResponsesPermissiveItem<'local_shell_call'> {
  call_id: string;
  command?: string;
}

export interface ResponsesLocalShellCallOutputItem extends ResponsesPermissiveItem<'local_shell_call_output'> {
  call_id: string;
  output?: unknown;
}

export interface ResponsesShellCallItem extends ResponsesPermissiveItem<'shell_call'> {
  call_id: string;
  command?: string;
}

export interface ResponsesShellCallOutputItem extends ResponsesPermissiveItem<'shell_call_output'> {
  call_id: string;
  output?: unknown;
}

export interface ResponsesApplyPatchCallItem extends ResponsesPermissiveItem<'apply_patch_call'> {
  call_id: string;
  patch?: string;
}

export interface ResponsesApplyPatchCallOutputItem extends ResponsesPermissiveItem<'apply_patch_call_output'> {
  call_id: string;
  output?: unknown;
}

export interface ResponsesMcpCallItem extends ResponsesPermissiveItem<'mcp_call'> {
  call_id: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
}

export interface ResponsesMcpListToolsItem extends ResponsesPermissiveItem<'mcp_list_tools'> {
  tools?: unknown[];
}

export interface ResponsesMcpApprovalRequestItem extends ResponsesPermissiveItem<'mcp_approval_request'> {
  call_id?: string;
}

export interface ResponsesMcpApprovalResponseItem extends ResponsesPermissiveItem<'mcp_approval_response'> {
  call_id?: string;
  output?: unknown;
}

export interface ResponsesInputImageGenerationCall {
  type: 'image_generation_call';
  id?: string;
  status?: 'completed' | 'in_progress' | 'generating' | 'failed';
  result?: string;
  revised_prompt?: string;
  output_format?: 'png' | 'jpeg';
  error?: { message: string; code: string; type?: string };
}

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  description?: string;
}

// Codex and other Responses clients ship hosted server tools (web_search,
// image_generation, tool_search, namespace) and Freeform `custom` tools
// alongside ordinary function tools. Native Responses targets pass `custom`
// through; translated targets wrap each `custom` as a single-string-parameter
// function tool and unwrap matching function calls back into `custom_tool_call`
// outputs. The wire-level tools array is still a heterogeneous union and
// translators must narrow on `type === "function"` (or `"custom"`) before
// reading `name` / `parameters`.
//
// `web_search` ships under four equivalent type values (current + dated
// + preview + dated-preview). All four name the same hosted tool. The
// canonical list lives here so the runtime Set and this TS union can't
// drift.
export const WEB_SEARCH_HOSTED_TYPE_NAMES = [
  'web_search',
  'web_search_2025_08_26',
  'web_search_preview',
  'web_search_preview_2025_03_11',
] as const;

export type ResponsesHostedToolType =
  | typeof WEB_SEARCH_HOSTED_TYPE_NAMES[number]
  | 'image_generation'
  | 'tool_search'
  | 'namespace';

export interface ResponsesHostedTool {
  type: ResponsesHostedToolType;
  // web_search-specific fields per the OpenAI Responses guide. Typed
  // explicitly to avoid unsafe index-signature casts at the call site.
  filters?: {
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
  user_location?: {
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
  search_context_size?: 'low' | 'medium' | 'high';
  external_web_access?: boolean;
  search_content_types?: string[];
  return_token_budget?: 'default' | 'unlimited';
  name?: string;
  // Forward-compat catch-all for other hosted-tool fields the gateway
  // doesn't currently inspect.
  [key: string]: unknown;
}

export interface ResponsesCustomTool {
  type: 'custom';
  name: string;
  description?: string;
  format?: Record<string, unknown>;
}

export type ResponsesTool = ResponsesFunctionTool | ResponsesHostedTool | ResponsesCustomTool;

export type ResponsesToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }
  | { type: 'custom'; name: string }
  | { type: ResponsesHostedToolType };

// ── Response types ──

export interface ResponsesResult {
  id: string;
  object: string;
  model: string;
  output: ResponsesOutputItem[];
  // SDK-only convenience alias for "all assistant text in this
  // response". Optional on the wire because OpenAI's SDKs derive it
  // from `output` rather than reading it from the JSON (see
  // openai-python `Response.output_text` `@property`, openai-dotnet
  // `[CodeGenSuppress("OutputText")]`, openai-go `func (r Response)
  // OutputText() string`). The captured wire fixture at
  // `openai-dotnet/tests/SessionRecords/ResponsesToolTests/WebSearchCallAsync.json`
  // confirms the field is absent from the response body. Producers
  // that happen to emit it (some OpenAPI implementations do) are
  // preserved as-is on pass-through.
  output_text?: string;
  status: 'completed' | 'incomplete' | 'failed' | 'in_progress';
  // `error` and `incomplete_details` are REQUIRED on the wire shape
  // per the OpenAI Responses spec (both can be null). Reference:
  // https://github.com/openai/openai-openapi/blob/master/openapi.yaml
  // `Response.required` lists both. Native upstreams emit them as
  // `null` on success-path frames; downstream clients (typed SDKs)
  // probe for the field's presence rather than its truthiness, so
  // omitting them on synthesized envelopes breaks parse-time validation.
  //
  // `error.type` is NOT in the OpenAI spec (see ResponseError schema —
  // only `code` and `message` are defined), but kept optional here to
  // accommodate upstreams that publish it as an extension; the shim
  // never synthesizes it.
  incomplete_details: { reason: string } | null;
  error: { message: string; code: string; type?: string } | null;
  // https://developers.openai.com/api/reference/resources/responses/methods/create
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  // Request params echoed back on the response body. The `Response`
  // schema in OpenAI's openapi.yaml composes `ResponseProperties`, which
  // declares both fields; observed upstream echoes (Copilot, Azure)
  // confirm they're populated with server-enriched defaults.
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  };
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesFunctionCallOutputItem
  | ResponsesOutputCustomToolCall
  | ResponsesCustomToolCallOutputItem
  | ResponsesOutputReasoning
  | ResponsesOutputWebSearchCall
  | ResponsesFileSearchCallItem
  | ResponsesComputerCallItem
  | ResponsesComputerCallOutputItem
  | ResponsesToolSearchCallItem
  | ResponsesToolSearchOutputItem
  | ResponsesCompactionItem
  | ResponsesCodeInterpreterCallItem
  | ResponsesLocalShellCallItem
  | ResponsesLocalShellCallOutputItem
  | ResponsesShellCallItem
  | ResponsesShellCallOutputItem
  | ResponsesApplyPatchCallItem
  | ResponsesApplyPatchCallOutputItem
  | ResponsesMcpCallItem
  | ResponsesMcpListToolsItem
  | ResponsesMcpApprovalRequestItem
  | ResponsesMcpApprovalResponseItem
  | ResponsesOutputImageGenerationCall;

export interface ResponsesOutputMessage {
  type: 'message';
  id?: string;
  status?: string;
  role: 'assistant';
  content: ResponsesOutputContentBlock[];
}

export type ResponsesOutputContentBlock = ResponsesOutputText | ResponsesOutputRefusal;

interface ResponsesOutputText {
  type: 'output_text';
  text: string;
}

interface ResponsesOutputRefusal {
  type: 'refusal';
  refusal: string;
}

export interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

export interface ResponsesOutputCustomToolCall {
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  input: string;
  id?: string;
  namespace?: string;
  status?: string;
}

export interface ResponsesOutputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  // See `ResponsesInputReasoning.encrypted_content`.
  encrypted_content?: string;
}

// Web-search call types. `results` is opt-in on the wire (native gates
// it on `include: ["web_search_call.results"]`); consumers must
// tolerate its absence.

export type ResponsesWebSearchAction =
  // `type: 'search'` carries either `queries: string[]` (preferred,
  // emitted by newer variants) or the deprecated `query: string` (older
  // codex). Producers should populate `queries`; consumers should read
  // `queries` first. `sources` is opt-in on the wire (native gates it
  // on `include: ["web_search_call.action.sources"]`); consumers must
  // tolerate its absence. The element shape mirrors openai-python
  // `ActionSearch.sources[]` — `type: 'url'` with the source URL.
  | { type: 'search'; query?: string; queries?: string[]; sources?: { type: 'url'; url: string }[] }
  // `url` is optional on `open_page`: native upstreams drop the field on
  // soft failures (404, network, blocked) rather than emitting a placeholder.
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url: string; pattern: string };

export interface ResponsesWebSearchResult {
  type: 'text_result';
  url: string;
  title: string;
  snippet: string;
}

export interface ResponsesOutputWebSearchCall {
  type: 'web_search_call';
  id: string;
  status: 'in_progress' | 'searching' | 'completed' | 'failed';
  // Optional because upstream omits `action` on the in-flight
  // `output_item.added` and only populates it on `.done` once the
  // action shape (search vs open_page vs find_in_page) is known.
  action?: ResponsesWebSearchAction;
  results?: ResponsesWebSearchResult[];
}

export interface ResponsesOutputImageGenerationCall {
  type: 'image_generation_call';
  id: string;
  status: 'in_progress' | 'generating' | 'completed' | 'failed';
  result?: string;
  revised_prompt?: string;
  action?: 'generate' | 'edit';
  background?: 'transparent' | 'opaque';
  output_format?: 'png' | 'jpeg';
  quality?: 'low' | 'medium' | 'high';
  size?: string;
  error?: { message: string; code: string; type?: string };
}

// ── Stream event types ──

// Spec marks sequence_number required, but some Copilot upstreams omit it
// on the wire; the stream parser backfills a monotonic counter when missing.
export type ResponsesStreamEvent = ResponsesStreamEventVariant & { sequence_number?: number };

type ResponsesStreamEventVariant =
  | { type: 'response.created'; response: ResponsesResult }
  | { type: 'response.in_progress'; response: ResponsesResult }
  | {
    type: 'response.output_item.added';
    output_index: number;
    item: ResponsesOutputItem;
  }
  | {
    type: 'response.output_item.done';
    output_index: number;
    item: ResponsesOutputItem;
  }
  | {
    type: 'response.content_part.added';
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponsesOutputContentBlock;
  }
  | {
    type: 'response.content_part.done';
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponsesOutputContentBlock;
  }
  | {
    type: 'response.reasoning_summary_part.added';
    item_id: string;
    output_index: number;
    summary_index: number;
    part: { type: 'summary_text'; text: string };
  }
  | {
    type: 'response.reasoning_summary_part.done';
    item_id: string;
    output_index: number;
    summary_index: number;
    part: { type: 'summary_text'; text: string };
  }
  | {
    type: 'response.reasoning_summary_text.delta';
    item_id: string;
    output_index: number;
    summary_index: number;
    delta: string;
  }
  | {
    type: 'response.reasoning_summary_text.done';
    item_id: string;
    output_index: number;
    summary_index: number;
    text: string;
  }
  | {
    type: 'response.output_text.delta';
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
  }
  | {
    type: 'response.output_text.done';
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;
  }
  | {
    type: 'response.output_text.annotation.added';
    output_index: number;
    content_index: number;
    annotation_index: number;
    item_id: string;
    annotation:
      | {
        type: 'url_citation';
        url: string;
        title: string;
        start_index: number;
        end_index: number;
      };
  }
  | {
    type: 'response.web_search_call.in_progress';
    output_index: number;
    item_id: string;
  }
  // Intermediate progress event for hosted `web_search`. Native upstreams
  // emit it between `.in_progress` and `.completed`; gateway-synthesized
  // lifecycles do the same.
  | {
    type: 'response.web_search_call.searching';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.web_search_call.completed';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.image_generation_call.in_progress';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.image_generation_call.generating';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.image_generation_call.partial_image';
    output_index: number;
    item_id: string;
    partial_image_index: number;
    partial_image_b64: string;
    background?: 'transparent' | 'opaque';
    output_format?: 'png' | 'jpeg';
    quality?: 'low' | 'medium' | 'high';
    size?: string;
  }
  | {
    type: 'response.image_generation_call.completed';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.function_call_arguments.delta';
    item_id: string;
    output_index: number;
    delta: string;
  }
  | {
    type: 'response.function_call_arguments.done';
    item_id: string;
    output_index: number;
    arguments: string;
  }
  | {
    type: 'response.custom_tool_call_input.delta';
    item_id: string;
    output_index: number;
    delta: string;
  }
  | {
    type: 'response.custom_tool_call_input.done';
    item_id: string;
    output_index: number;
    input: string;
  }
  | { type: 'response.completed'; response: ResponsesResult }
  | { type: 'response.incomplete'; response: ResponsesResult }
  | { type: 'response.failed'; response: ResponsesResult }
  | {
    type: 'error';
    message: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    target_api?: string;
  }
  | { type: 'ping' };

// Either side of the Responses reasoning round trip: input echoes a prior
// turn's reasoning back in, output emits the current turn's reasoning. Shape
// is identical aside from the type tag's role.
export type ResponsesReasoningItem = ResponsesInputReasoning | ResponsesOutputReasoning;

export const isResponsesTerminalEvent = (event: Pick<ResponsesStreamEvent, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error';

// Typed accessor for the `response` payload carried on lifecycle envelopes
// (`response.created`, `response.in_progress`, `response.completed`,
// `response.incomplete`, `response.failed`). Returns null on every other
// event type so callers don't have to reproduce the variant check.
export const responsesResultFromStreamEvent = (event: ResponsesStreamEvent): ResponsesResult | null =>
  'response' in event ? event.response : null;

export { responsesResultToEvents } from './from-result.ts';
export { imageGenerationCallLifecycleEvents } from './image-generation-lifecycle.ts';
export { webSearchCallLifecycleEvents } from './web-search-lifecycle.ts';
export { parseResponsesStream, type ParseResponsesStreamOptions } from './stream.ts';

export { RESPONSES_MISSING_TERMINAL_MESSAGE, collectResponsesProtocolEventsToResult } from './to-result.ts';
export { reassembleResponsesEvents } from './reassemble.ts';
export { responsesProtocolFrameToSSEFrame } from './to-sse.ts';
