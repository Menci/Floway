// Responses API type definitions
// Used for translating Messages ↔ Responses APIs

import type { USAGE_BILLING, UsageBillingMetadata } from '../common/usage.ts';

// ── Request types ──

// Supported for gpt-5.6+. Slots remain open-string so future modes and
// lifetimes reach the upstream unchanged.
// https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/responses/response_compact_params.py#L144-L184
export interface ResponsesPromptCacheOptions {
  mode?: 'implicit' | 'explicit' | (string & {});
  ttl?: '30m' | (string & {});
}

export type ResponsesPromptCacheRetention = 'in_memory' | '24h' | (string & {});

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
  tool_choice?: ResponsesToolChoice | null;
  metadata?: Record<string, unknown> | null;
  stream?: boolean | null;
  store?: boolean | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: {
    effort?: string;
    summary?: 'detailed' | 'auto' | 'concise' | (string & {});
    // Controls which reasoning items are rendered back to the model on later
    // turns; echoed on the response as the effective mode. Canonical values are
    // `auto` / `current_turn` / `all_turns`, but the slot stays open-string so
    // future upstream modes forward verbatim rather than being narrowed at this
    // boundary. Reference (openai-python shared Reasoning.context):
    // https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/shared/reasoning.py#L19-L25
    // Reference (openai-node Reasoning.context):
    // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/shared.ts#L262-L269
    context?: 'auto' | 'current_turn' | 'all_turns' | (string & {}) | null;
  };
  include?: string[];
  // `text.verbosity` is a native GPT-5-family Responses field that controls
  // response length; `text.format` carries structured-output schemas. Both
  // ride on the same `text` object.
  // Reference: https://platform.openai.com/docs/api-reference/responses/create
  text?: { format?: Record<string, unknown> | null; verbosity?: string | null } | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: ResponsesPromptCacheOptions | null;
  prompt_cache_retention?: ResponsesPromptCacheRetention | null;
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
  prompt_cache_options?: ResponsesPromptCacheOptions | null;
  prompt_cache_retention?: ResponsesPromptCacheRetention | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  // Gateway-only: controls whether the compact response's output items + the
  // committed snapshot persist. Forwarded NEITHER to upstream nor to the
  // provider call body.
  store?: boolean | null;
}

export type ResponsesCompactRequestPayload = Omit<ResponsesCompactPayload, 'input'> & {
  input: string | ResponsesRequestInputItem[];
};

export type CanonicalResponsesCompactPayload = Omit<ResponsesCompactPayload, 'input'> & {
  input: ResponsesInputItem[];
};

// Project a (possibly-wider) ResponsesPayload-shaped object into the strict
// compact wire shape. Every native-compact provider terminal calls this
// before dispatching to its upstream's `/responses/compact` endpoint, so a
// post-chain action pivot that arrived carrying generate-only fields
// (tools/temperature/reasoning/...) cannot leak them onto the compact wire.
// `model` and `store` are caller-supplied at the dispatch site (model is
// the resolved upstream id; store is gateway-only).
export const toCompactPayloadShape = (payload: Omit<CanonicalResponsesPayload, 'model'>): Omit<CanonicalResponsesCompactPayload, 'model' | 'store'> => ({
  input: payload.input,
  ...(payload.instructions !== undefined && { instructions: payload.instructions }),
  ...(payload.previous_response_id !== undefined && { previous_response_id: payload.previous_response_id }),
  ...(payload.prompt_cache_key !== undefined && { prompt_cache_key: payload.prompt_cache_key }),
  ...(payload.prompt_cache_options !== undefined && { prompt_cache_options: payload.prompt_cache_options }),
  ...(payload.prompt_cache_retention !== undefined && { prompt_cache_retention: payload.prompt_cache_retention }),
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
  | ResponsesInputAdditionalToolsItem
  | ResponsesProgramItem
  | ResponsesProgramOutputItem
  | ResponsesInputAgentMessageItem
  | ResponsesInputMultiAgentCallItem
  | ResponsesInputMultiAgentCallOutputItem
  | ResponsesContextCompactionItem
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

export type ResponsesMessagePhase = 'commentary' | 'final_answer' | (string & {}) | null;

export interface ResponsesInputMessage {
  type: 'message';
  id?: string;
  status?: string;
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesInputContent[];
  phase?: ResponsesMessagePhase;
}

// The Responses request schema's EasyInputMessage makes the constant
// `type: "message"` discriminator optional. Wire-facing payloads accept that
// shorthand; gateway and translator boundaries normalize it before internal
// item processing so the canonical union remains explicitly discriminated.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L697-L721
export interface ResponsesEasyInputMessage {
  content: string | ResponsesInputContent[];
  role: 'user' | 'assistant' | 'system' | 'developer';
  phase?: ResponsesMessagePhase;
  type?: 'message';
}

export type ResponsesRequestInputItem =
  | ResponsesEasyInputMessage
  | ResponsesInputItem;

export type ResponsesRequestPayload = Omit<ResponsesPayload, 'input'> & {
  input: string | ResponsesRequestInputItem[];
};

export type CanonicalResponsesPayload = Omit<ResponsesPayload, 'input'> & {
  input: ResponsesInputItem[];
};

export type ResponsesInputContent = ResponsesInputText | ResponsesInputImage | ResponsesInputFile;

// Explicit content breakpoints inherit their lifetime from
// `prompt_cache_options.ttl`. The mode stays open-string for forward
// compatibility.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L5009-L5038
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L3973-L3993
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L3864-L3884
export interface ResponsesPromptCacheBreakpoint {
  mode: 'explicit' | (string & {});
}

export interface ResponsesInputText {
  type: 'input_text' | 'output_text';
  text: string;
  prompt_cache_breakpoint?: ResponsesPromptCacheBreakpoint | null;
}

export interface ResponsesInputImage {
  // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L3947-L3979
  type: 'input_image';
  image_url?: string | null;
  file_id?: string | null;
  detail: 'auto' | 'low' | 'high' | 'original' | (string & {});
  prompt_cache_breakpoint?: ResponsesPromptCacheBreakpoint | null;
}

export type ResponsesToolOutputContent = ResponsesInputText | ResponsesInputImage | ResponsesInputFile;

export interface ResponsesInputFile {
  type: 'input_file';
  detail?: 'auto' | 'low' | 'high';
  file_data?: string;
  file_id?: string | null;
  file_url?: string;
  filename?: string;
  prompt_cache_breakpoint?: ResponsesPromptCacheBreakpoint | null;
  [key: string]: unknown;
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

// OpenAI Responses Programmatic Tool Calling caller shape.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L3394-L3407
export type ResponsesToolCaller =
  | { type: 'direct' }
  | { type: 'program'; caller_id: string };

export interface ResponsesFunctionToolCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed' | 'in_progress' | 'incomplete';
  caller?: ResponsesToolCaller | null;
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  id?: string;
  call_id: string;
  // Multimodal tool outputs carry an array of content parts (e.g. a screenshot
  // tool returning `input_image` parts) in addition to the plain-string form.
  output: string | ResponsesInputContent[];
  status?: 'completed' | 'incomplete';
  caller?: ResponsesToolCaller | null;
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
  caller?: ResponsesToolCaller | null;
}

export interface ResponsesCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id: string;
  output: string | ResponsesToolOutputContent[];
  id?: string;
  status?: string;
  caller?: ResponsesToolCaller | null;
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

export interface ResponsesFileSearchResult {
  attributes?: Record<string, string | number | boolean> | null;
  file_id?: string;
  filename?: string;
  score?: number;
  text?: string;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L2909-L2980
export interface ResponsesFileSearchCallItem {
  type: 'file_search_call';
  id: string;
  queries: string[];
  status: string;
  results?: ResponsesFileSearchResult[] | null;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L298-L535
export type ResponsesComputerAction =
  | { type: 'click'; button: 'left' | 'right' | 'wheel' | 'back' | 'forward'; x: number; y: number; keys?: string[] | null }
  | { type: 'double_click'; keys: string[] | null; x: number; y: number }
  | { type: 'drag'; path: Array<{ x: number; y: number }>; keys?: string[] | null }
  | { type: 'keypress'; keys: string[] }
  | { type: 'move'; x: number; y: number; keys?: string[] | null }
  | { type: 'screenshot' }
  | { type: 'scroll'; scroll_x: number; scroll_y: number; x: number; y: number; keys?: string[] | null }
  | { type: 'type'; text: string }
  | { type: 'wait' };

export interface ResponsesComputerSafetyCheck {
  id: string;
  code?: string | null;
  message?: string | null;
}

// Modern `computer` emits `actions` and rejects even an empty
// `pending_safety_checks`; the legacy `computer_use_preview` shape uses the
// singular `action` plus safety checks. Keep both wire generations explicit.
// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1990-L2035
// https://github.com/Menci/Floway/pull/246#issuecomment-5028154071
interface ResponsesComputerCallItemBase {
  type: 'computer_call';
  id: string;
  call_id: string;
  status: string;
}

export type ResponsesComputerCallItem = ResponsesComputerCallItemBase & (
  | {
    actions: ResponsesComputerAction[];
    action?: never;
    pending_safety_checks?: never;
  }
  | {
    action: ResponsesComputerAction;
    actions?: never;
    pending_safety_checks: ResponsesComputerSafetyCheck[];
  }
);

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L2280-L2359
export interface ResponsesComputerCallOutputItem {
  type: 'computer_call_output';
  id?: string | null;
  call_id: string;
  output: {
    type: 'computer_screenshot';
    file_id?: string;
    image_url?: string;
  };
  acknowledged_safety_checks?: ResponsesComputerSafetyCheck[] | null;
  status?: string | null;
  created_by?: string;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L7119-L7223
export interface ResponsesToolSearchCallItem {
  type: 'tool_search_call';
  arguments: unknown;
  id?: string | null;
  call_id?: string | null;
  execution?: 'server' | 'client';
  status?: string | null;
  created_by?: string;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

export interface ResponsesToolSearchOutputItem {
  type: 'tool_search_output';
  tools: ResponsesTool[];
  id?: string | null;
  call_id?: string | null;
  execution?: 'server' | 'client';
  status?: string | null;
  created_by?: string;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L4265-L4285
export interface ResponsesInputAdditionalToolsItem {
  type: 'additional_tools';
  role: 'developer';
  tools: ResponsesTool[];
  id?: string | null;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L4919-L4971
export interface ResponsesProgramItem {
  type: 'program';
  id: string;
  call_id: string;
  code: string;
  fingerprint: string;
}

export interface ResponsesProgramOutputItem {
  type: 'program_output';
  id: string;
  call_id: string;
  result: string;
  status: 'completed' | 'incomplete';
}

export type ResponsesAgentMessageContent =
  | { type: 'input_text'; text: string }
  | { type: 'encrypted_content'; encrypted_content: string }
  | (Record<string, unknown> & { type: string });

export interface ResponsesInputAgentMessageItem {
  type: 'agent_message';
  author: string;
  recipient: string;
  content: ResponsesAgentMessageContent[];
  id?: string | null;
  agent?: { agent_name: string } | null;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

export type ResponsesMultiAgentAction =
  | 'spawn_agent'
  | 'interrupt_agent'
  | 'list_agents'
  | 'send_message'
  | 'followup_task'
  | 'wait_agent';

export interface ResponsesInputMultiAgentCallItem {
  type: 'multi_agent_call';
  action: ResponsesMultiAgentAction;
  arguments: string;
  call_id: string;
  id?: string | null;
  agent?: { agent_name: string } | null;
}

export interface ResponsesInputMultiAgentCallOutputItem {
  type: 'multi_agent_call_output';
  action: ResponsesMultiAgentAction;
  call_id: string;
  output: Array<Record<string, unknown> & { type: 'output_text'; text: string }>;
  id?: string | null;
  agent?: { agent_name: string } | null;
}

// Legacy RemoteCompactionV2 history shape. Current OpenAI Responses uses
// `compaction_trigger` input and `compaction` output; Codex still deserializes
// this form when replaying older rollouts.
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/protocol/src/models.rs#L1135-L1148
export interface ResponsesContextCompactionItem extends ResponsesPermissiveItem<'context_compaction'> {
  encrypted_content?: string;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1918-L1963
export interface ResponsesCompactionItem {
  type: 'compaction';
  id?: string | null;
  encrypted_content: string;
  created_by?: string;
}

// Payload-free trailing input item for a RemoteCompactionV2 round trip.
// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L4894-L4902
export interface ResponsesCompactionTriggerItem {
  type: 'compaction_trigger';
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1852-L1915
export interface ResponsesCodeInterpreterCallItem {
  type: 'code_interpreter_call';
  id: string;
  code: string | null;
  container_id: string;
  outputs: Array<
    | { type: 'logs'; logs: string }
    | { type: 'image'; url: string }
  > | null;
  status: string;
}

// Legacy local-shell output is opaque text correlated by `call_id`; modern
// shell output uses structured stdout/stderr/outcome chunks below.
// https://github.com/openai/openai-agents-python/blob/2fa463571e76dae8ff267622f1018eaf06ffeb9f/tests/test_local_shell_tool.py#L46-L92
export interface ResponsesLocalShellCallItem {
  type: 'local_shell_call';
  id: string;
  call_id: string;
  action: {
    type: 'exec';
    command: string[];
    env: Record<string, string>;
    timeout_ms?: number | null;
    user?: string | null;
    working_directory?: string | null;
  };
  status: string;
}

export interface ResponsesLocalShellCallOutputItem {
  type: 'local_shell_call_output';
  id?: string | null;
  call_id: string;
  output: string;
  status?: string | null;
}

export type ResponsesShellEnvironment =
  | { type: 'local' }
  | { type: 'container_reference'; container_id: string };

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L3154-L3344
export interface ResponsesShellCallItem {
  type: 'shell_call';
  id?: string | null;
  call_id: string;
  action: {
    commands: string[];
    max_output_length?: number | null;
    timeout_ms?: number | null;
  };
  environment?: ResponsesShellEnvironment | null;
  status?: string | null;
  caller?: ResponsesToolCaller | null;
  created_by?: string;
}

export interface ResponsesShellCallOutputItem {
  type: 'shell_call_output';
  id?: string | null;
  call_id: string;
  max_output_length?: number | null;
  output: Array<{
    stdout: string;
    stderr: string;
    outcome: { type: 'timeout' } | { type: 'exit'; exit_code: number };
    created_by?: string;
  }>;
  status?: string | null;
  caller?: ResponsesToolCaller | null;
  created_by?: string;
}

export type ResponsesApplyPatchOperation =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'delete_file'; path: string }
  | { type: 'update_file'; path: string; diff: string };

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1472-L1643
export interface ResponsesApplyPatchCallItem {
  type: 'apply_patch_call';
  id?: string | null;
  call_id: string;
  operation: ResponsesApplyPatchOperation;
  status: 'in_progress' | 'completed';
  caller?: ResponsesToolCaller | null;
  created_by?: string;
}

export interface ResponsesApplyPatchCallOutputItem {
  type: 'apply_patch_call_output';
  id?: string | null;
  call_id: string;
  status: 'completed' | 'failed';
  output?: string | null;
  caller?: ResponsesToolCaller | null;
  created_by?: string;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L4727-L4892
export interface ResponsesMcpCallItem {
  type: 'mcp_call';
  id: string;
  arguments: string;
  name: string;
  server_label: string;
  approval_request_id?: string | null;
  error?: string | null;
  output?: string | null;
  status?: string;
}

export interface ResponsesMcpListToolsItem {
  type: 'mcp_list_tools';
  id: string;
  server_label: string;
  tools: Array<{
    input_schema: unknown;
    name: string;
    annotations?: unknown | null;
    description?: string | null;
  }>;
  error?: string | null;
}

export interface ResponsesMcpApprovalRequestItem {
  type: 'mcp_approval_request';
  id: string;
  arguments: string;
  name: string;
  server_label: string;
}

export interface ResponsesMcpApprovalResponseItem {
  type: 'mcp_approval_response';
  id?: string | null;
  approval_request_id: string;
  approve: boolean;
  reason?: string | null;
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

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L822-L851
export type ResponsesToolAllowedCaller = 'direct' | 'programmatic';

export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  description?: string;
  allowed_callers?: ResponsesToolAllowedCaller[] | null;
  defer_loading?: boolean;
  output_schema?: Record<string, unknown> | null;
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
  allowed_callers?: ResponsesToolAllowedCaller[] | null;
  defer_loading?: boolean;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L8110-L8115
export interface ResponsesProgrammaticTool {
  type: 'programmatic_tool_calling';
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L7871-L8080
export interface ResponsesMcpTool {
  type: 'mcp';
  server_label: string;
  allowed_callers?: ResponsesToolAllowedCaller[] | null;
  defer_loading?: boolean;
  [key: string]: unknown;
}

export interface ResponsesCodeInterpreterTool {
  type: 'code_interpreter';
  container: string | Record<string, unknown>;
  allowed_callers?: ResponsesToolAllowedCaller[] | null;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L541-L577
export interface ResponsesComputerTool {
  type: 'computer';
}

export interface ResponsesComputerUsePreviewTool {
  type: 'computer_use_preview';
  display_height: number;
  display_width: number;
  environment: 'windows' | 'mac' | 'linux' | 'ubuntu' | 'browser';
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L729-L806
export interface ResponsesFileSearchTool {
  type: 'file_search';
  vector_store_ids: string[];
  filters?: Record<string, unknown> | null;
  max_num_results?: number;
  ranking_options?: {
    hybrid_search?: { embedding_weight: number; text_weight: number };
    ranker?: 'auto' | 'default-2024-11-15';
    score_threshold?: number;
  };
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L8239-L8247
export interface ResponsesLocalShellTool {
  type: 'local_shell';
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L803-L815
export interface ResponsesShellTool {
  type: 'shell';
  allowed_callers?: ResponsesToolAllowedCaller[] | null;
  environment?: unknown;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L245-L264
export interface ResponsesApplyPatchTool {
  type: 'apply_patch';
  allowed_callers?: ResponsesToolAllowedCaller[] | null;
}

export type ResponsesTool =
  | ResponsesFunctionTool
  | ResponsesHostedTool
  | ResponsesCustomTool
  | ResponsesProgrammaticTool
  | ResponsesMcpTool
  | ResponsesCodeInterpreterTool
  | ResponsesComputerTool
  | ResponsesComputerUsePreviewTool
  | ResponsesFileSearchTool
  | ResponsesLocalShellTool
  | ResponsesShellTool
  | ResponsesApplyPatchTool;

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L8250-L8400
export type ResponsesToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }
  | { type: 'custom'; name: string }
  | { type: 'mcp'; server_label: string; name?: string | null }
  | { type: 'allowed_tools'; mode: 'auto' | 'required'; tools: Array<Record<string, unknown>> }
  | { type: 'shell' }
  | { type: 'apply_patch' }
  | { type: 'programmatic_tool_calling' }
  | {
    type:
      | ResponsesHostedToolType
      | 'file_search'
      | 'computer'
      | 'computer_use_preview'
      | 'computer_use'
      | 'code_interpreter'
      | 'mcp';
  };

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
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L6866-L6870
  status: 'queued' | 'completed' | 'incomplete' | 'failed' | 'in_progress' | 'cancelled';
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
  tool_choice?: ResponsesToolChoice | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    // Both fields are disjoint subsets of input_tokens. Older compatible
    // upstreams may omit cache_write_tokens even when they provide details.
    // https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/responses/response_usage.py
    // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L7259-L7269
    input_tokens_details?: { cached_tokens: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens: number };
    [USAGE_BILLING]?: UsageBillingMetadata;
  };
}

// Stored/output additional-tools roles are wider than the input-only
// `developer` role.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L5116-L5136
export type ResponsesAdditionalToolsRole =
  | 'unknown'
  | 'user'
  | 'assistant'
  | 'system'
  | 'critic'
  | 'discriminator'
  | 'developer'
  | 'tool';

export interface ResponsesOutputAdditionalToolsItem {
  type: 'additional_tools';
  id: string;
  role: ResponsesAdditionalToolsRole;
  tools: ResponsesTool[];
}

export type ResponsesOutputAgentMessageItem = Omit<ResponsesInputAgentMessageItem, 'id' | 'agent'> & {
  id: string;
  agent?: { agent_name: string };
};

export type ResponsesOutputMultiAgentCallItem = Omit<ResponsesInputMultiAgentCallItem, 'id' | 'agent'> & {
  id: string;
  agent?: { agent_name: string };
};

export type ResponsesOutputMultiAgentCallOutputItem = Omit<ResponsesInputMultiAgentCallOutputItem, 'id' | 'agent'> & {
  id: string;
  agent?: { agent_name: string };
};

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
  | ResponsesOutputAdditionalToolsItem
  | ResponsesProgramItem
  | ResponsesProgramOutputItem
  | ResponsesOutputAgentMessageItem
  | ResponsesOutputMultiAgentCallItem
  | ResponsesOutputMultiAgentCallOutputItem
  | ResponsesContextCompactionItem
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
  phase?: ResponsesMessagePhase;
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
  caller?: ResponsesToolCaller | null;
}

export type ResponsesOutputCustomToolCall = ResponsesCustomToolCallItem;

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
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L6456-L6471
  | { type: 'response.queued'; response: ResponsesResult }
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
  // https://github.com/openai/openai-python/blob/d4dceb221b9a92c55c232d5b330ae89beb539415/src/openai/types/responses/response_reasoning_text_delta_event.py#L9-L31
  // https://github.com/openai/openai-python/blob/d4dceb221b9a92c55c232d5b330ae89beb539415/src/openai/types/responses/response_reasoning_text_done_event.py#L9-L34
  | {
    type: 'response.reasoning_text.delta';
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
  }
  | {
    type: 'response.reasoning_text.done';
    item_id: string;
    output_index: number;
    content_index: number;
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
  // https://github.com/vercel/ai/blob/6b6a8bbe9247e0ed70c8a7f6e850a1ab16096528/packages/openai/src/responses/__fixtures__/openai-shell-tool.1.chunks.txt#L4-L10
  | {
    type: 'response.shell_call_command.added';
    output_index: number;
    command_index: number;
    command: string;
  }
  | {
    type: 'response.shell_call_command.delta';
    output_index: number;
    command_index: number;
    delta: string;
    obfuscation?: string;
  }
  | {
    type: 'response.shell_call_command.done';
    output_index: number;
    command_index: number;
    command: string;
  }
  // https://github.com/vercel/ai/blob/6b6a8bbe9247e0ed70c8a7f6e850a1ab16096528/packages/openai/src/responses/__fixtures__/openai-apply-patch-tool.1.chunks.txt#L4-L36
  | {
    type: 'response.apply_patch_call_operation_diff.delta';
    item_id: string;
    output_index: number;
    delta: string;
    obfuscation?: string;
  }
  | {
    type: 'response.apply_patch_call_operation_diff.done';
    item_id: string;
    output_index: number;
    diff: string;
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
// (`response.queued`, `response.created`, `response.in_progress`, `response.completed`,
// `response.incomplete`, `response.failed`). Returns null on every other
// event type so callers don't have to reproduce the variant check.
export const responsesResultFromStreamEvent = (event: ResponsesStreamEvent): ResponsesResult | null =>
  'response' in event ? event.response : null;

export { responsesResultToEvents } from './from-result.ts';
export { imageGenerationCallLifecycleEvents } from './image-generation-lifecycle.ts';
export { webSearchCallLifecycleEvents } from './web-search-lifecycle.ts';
export { parseResponsesStream, type ParseResponsesStreamOptions } from './stream.ts';

export { RESPONSES_MISSING_TERMINAL_MESSAGE, collectResponsesProtocolEventsToResult } from './to-result.ts';
export { createRandomResponsesItemId, type GeneratedResponsesItemType } from './item-id.ts';
export { reassembleResponsesEvents } from './reassemble.ts';
export { responsesProtocolFrameToSSEFrame } from './to-sse.ts';
