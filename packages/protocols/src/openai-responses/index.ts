// OpenAI Responses API type definitions
// Used for translating Anthropic Messages ↔ OpenAI Responses APIs

// ── Request types ──

// Supported for gpt-5.6+. Slots remain open-string so future modes and
// lifetimes reach the upstream unchanged.
// https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/responses/response_compact_params.py#L144-L184
export interface OpenAIResponsesPromptCacheOptions {
  mode?: 'implicit' | 'explicit' | (string & {});
  ttl?: '30m' | (string & {});
}

export type OpenAIResponsesPromptCacheRetention = 'in_memory' | '24h' | (string & {});

export interface OpenAIResponsesPayload {
  model: string;
  input: string | OpenAIResponsesInputItem[];
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
  tools?: OpenAIResponsesTool[] | null;
  tool_choice?: OpenAIResponsesToolChoice | null;
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
  // `text.verbosity` is a native GPT-5-family OpenAI Responses field that controls
  // response length; `text.format` carries structured-output schemas. Both
  // ride on the same `text` object.
  // Reference: https://platform.openai.com/docs/api-reference/responses/create
  text?: { format?: Record<string, unknown> | null; verbosity?: string | null } | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: OpenAIResponsesPromptCacheOptions | null;
  prompt_cache_retention?: OpenAIResponsesPromptCacheRetention | null;
  safety_identifier?: string | null;
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null;
  // Request knobs Floway itself never acts on. On an OpenAI-Responses-native target
  // they ride to the upstream in the forwarded body and come back echoed; no
  // translate pair carries them, so on a translated target the client-facing
  // echo can only come from the request. Declaring them keeps that echo honest
  // instead of hard-coding the spec default for a client that sent its own
  // value.
  // https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L35856-L35873
  truncation?: 'auto' | 'disabled' | (string & {}) | null;
  // https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L59062-L59068
  background?: boolean | null;
  // https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L44064-L44080
  top_logprobs?: number | null;
  // OpenAI Chat Completions sampling penalties. OpenAI's OpenAI Responses request schema
  // does not carry them, but the OpenResponses request and response schemas
  // both do, so a client may send them and expects them echoed.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723
  // https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L32766-L32771
  presence_penalty?: number | null;
  // https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L32752-L32757
  frequency_penalty?: number | null;
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesInputMessage
  | OpenAIResponsesFunctionToolCallItem
  | OpenAIResponsesFunctionCallOutputItem
  | OpenAIResponsesCustomToolCallItem
  | OpenAIResponsesCustomToolCallOutputItem
  | OpenAIResponsesInputReasoning
  | OpenAIResponsesItemReference
  | OpenAIResponsesInputWebSearchCall
  | OpenAIResponsesFileSearchCallItem
  | OpenAIResponsesComputerCallItem
  | OpenAIResponsesComputerCallOutputItem
  | OpenAIResponsesToolSearchCallItem
  | OpenAIResponsesToolSearchOutputItem
  | OpenAIResponsesInputAdditionalToolsItem
  | OpenAIResponsesProgramItem
  | OpenAIResponsesProgramOutputItem
  | OpenAIResponsesInputAgentMessageItem
  | OpenAIResponsesInputMultiAgentCallItem
  | OpenAIResponsesInputMultiAgentCallOutputItem
  | OpenAIResponsesContextCompactionItem
  | OpenAIResponsesCompactionItem
  | OpenAIResponsesCompactionTriggerItem
  | OpenAIResponsesInputImageGenerationCall
  | OpenAIResponsesCodeInterpreterCallItem
  | OpenAIResponsesLocalShellCallItem
  | OpenAIResponsesLocalShellCallOutputItem
  | OpenAIResponsesShellCallItem
  | OpenAIResponsesShellCallOutputItem
  | OpenAIResponsesApplyPatchCallItem
  | OpenAIResponsesApplyPatchCallOutputItem
  | OpenAIResponsesMcpCallItem
  | OpenAIResponsesMcpListToolsItem
  | OpenAIResponsesMcpApprovalRequestItem
  | OpenAIResponsesMcpApprovalResponseItem;

export type OpenAIResponsesMessagePhase = 'commentary' | 'final_answer' | (string & {}) | null;

export interface OpenAIResponsesInputMessage {
  type: 'message';
  id?: string;
  status?: string;
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | OpenAIResponsesInputContent[];
  phase?: OpenAIResponsesMessagePhase;
}

// The OpenAI Responses request schema's EasyInputMessage makes the constant
// `type: "message"` discriminator optional. Wire-facing payloads accept that
// shorthand; gateway and translator boundaries normalize it before internal
// item processing so the canonical union remains explicitly discriminated.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L697-L721
export interface OpenAIResponsesEasyInputMessage {
  content: string | OpenAIResponsesInputContent[];
  role: 'user' | 'assistant' | 'system' | 'developer';
  phase?: OpenAIResponsesMessagePhase;
  type?: 'message';
}

export type OpenAIResponsesRequestInputItem =
  | OpenAIResponsesEasyInputMessage
  | OpenAIResponsesInputItem;

export type OpenAIResponsesRequestPayload = Omit<OpenAIResponsesPayload, 'input'> & {
  input: string | OpenAIResponsesRequestInputItem[];
};

export type CanonicalOpenAIResponsesPayload = Omit<OpenAIResponsesPayload, 'input'> & {
  input: OpenAIResponsesInputItem[];
};

export type OpenAIResponsesInputContent = OpenAIResponsesInputText | OpenAIResponsesInputImage | OpenAIResponsesInputFile | OpenAIResponsesOutputRefusal;

// Explicit content breakpoints inherit their lifetime from
// `prompt_cache_options.ttl`. The mode stays open-string for forward
// compatibility.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L5009-L5038
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L3973-L3993
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L3864-L3884
export interface OpenAIResponsesPromptCacheBreakpoint {
  mode: 'explicit' | (string & {});
}

export interface OpenAIResponsesInputText {
  type: 'input_text' | 'output_text';
  text: string;
  prompt_cache_breakpoint?: OpenAIResponsesPromptCacheBreakpoint | null;
}

export interface OpenAIResponsesInputImage {
  // OpenAI splits this part in two: `ResponseInputImageContent` /
  // `InputImageContentParamAutoParam` is the request-side shape and leaves
  // `detail` optional and nullable, while `ResponseInputImage` /
  // `InputImageContent` requires it and is the response-side echo. This
  // interface types requests, so it follows the former. Omitting `detail`
  // means `auto` on both OpenAI Responses and OpenAI Chat Completions.
  // https://web.archive.org/web/20260730100926/https://developers.openai.com/api/docs/guides/images-vision.md
  // Request side:
  // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L4000-L4029
  // https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L67923-L67961
  // Response side:
  // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L3951-L3980
  // https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L65928-L65961
  type: 'input_image';
  image_url?: string | null;
  file_id?: string | null;
  detail?: 'auto' | 'low' | 'high' | 'original' | (string & {}) | null;
  prompt_cache_breakpoint?: OpenAIResponsesPromptCacheBreakpoint | null;
}

export type OpenAIResponsesToolOutputContent = OpenAIResponsesInputText | OpenAIResponsesInputImage | OpenAIResponsesInputFile;

export interface OpenAIResponsesInputFile {
  type: 'input_file';
  detail?: 'auto' | 'low' | 'high';
  file_data?: string;
  file_id?: string | null;
  file_url?: string;
  filename?: string;
  prompt_cache_breakpoint?: OpenAIResponsesPromptCacheBreakpoint | null;
  [key: string]: unknown;
}

export interface OpenAIResponsesInputReasoning {
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
export type OpenAIResponsesToolCaller =
  | { type: 'direct' }
  | { type: 'program'; caller_id: string };

export interface OpenAIResponsesFunctionToolCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
  status: 'completed' | 'in_progress' | 'incomplete';
  caller?: OpenAIResponsesToolCaller | null;
}

export interface OpenAIResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  id?: string;
  call_id: string;
  // Multimodal tool outputs carry an array of content parts (e.g. a screenshot
  // tool returning `input_image` parts) in addition to the plain-string form.
  output: string | OpenAIResponsesToolOutputContent[];
  status?: 'completed' | 'incomplete';
  caller?: OpenAIResponsesToolCaller | null;
}

// Freeform custom tool invocation echoed back to the model in conversation
// history. The model's own emission of a custom tool call is identical in
// shape (it is also a `custom_tool_call` item).
export interface OpenAIResponsesCustomToolCallItem {
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  input: string;
  id?: string;
  namespace?: string;
  status?: string;
  caller?: OpenAIResponsesToolCaller | null;
}

export interface OpenAIResponsesCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id: string;
  output: string | OpenAIResponsesToolOutputContent[];
  id?: string;
  status?: string;
  caller?: OpenAIResponsesToolCaller | null;
}

export interface OpenAIResponsesItemReference {
  type: 'item_reference';
  id: string;
}

// Tolerant input mirror of OpenAIResponsesOutputWebSearchCall: clients may
// echo previously emitted web_search_call items back. Every field is
// optional so the wire shape accepts whatever the client carries.
export interface OpenAIResponsesInputWebSearchCall {
  type: 'web_search_call';
  id?: string;
  status?: 'completed' | 'in_progress' | 'searching' | 'failed';
  action?: OpenAIResponsesWebSearchAction;
  results?: OpenAIResponsesWebSearchResult[];
}

export interface OpenAIResponsesPermissiveItem<TType extends string> {
  type: TType;
  id?: string;
  call_id?: string;
  status?: string;
  output?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

export interface OpenAIResponsesFileSearchResult {
  attributes?: Record<string, string | number | boolean> | null;
  file_id?: string;
  filename?: string;
  score?: number;
  text?: string;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L2909-L2980
export interface OpenAIResponsesFileSearchCallItem {
  type: 'file_search_call';
  id: string;
  queries: string[];
  status: string;
  results?: OpenAIResponsesFileSearchResult[] | null;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L298-L535
export type OpenAIResponsesComputerAction =
  | { type: 'click'; button: 'left' | 'right' | 'wheel' | 'back' | 'forward'; x: number; y: number; keys?: string[] | null }
  | { type: 'double_click'; keys: string[] | null; x: number; y: number }
  | { type: 'drag'; path: Array<{ x: number; y: number }>; keys?: string[] | null }
  | { type: 'keypress'; keys: string[] }
  | { type: 'move'; x: number; y: number; keys?: string[] | null }
  | { type: 'screenshot' }
  | { type: 'scroll'; scroll_x: number; scroll_y: number; x: number; y: number; keys?: string[] | null }
  | { type: 'type'; text: string }
  | { type: 'wait' };

export interface OpenAIResponsesComputerSafetyCheck {
  id: string;
  code?: string | null;
  message?: string | null;
}

// Modern `computer` emits `actions` and rejects even an empty
// `pending_safety_checks`; the legacy `computer_use_preview` shape uses the
// singular `action` plus safety checks. Keep both wire generations explicit.
// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1990-L2035
// https://github.com/Menci/Floway/pull/246#issuecomment-5028154071
interface OpenAIResponsesComputerCallItemBase {
  type: 'computer_call';
  id: string;
  call_id: string;
  status: string;
}

export type OpenAIResponsesComputerCallItem = OpenAIResponsesComputerCallItemBase & (
  | {
    actions: OpenAIResponsesComputerAction[];
    action?: never;
    pending_safety_checks?: never;
  }
  | {
    action: OpenAIResponsesComputerAction;
    actions?: never;
    pending_safety_checks: OpenAIResponsesComputerSafetyCheck[];
  }
);

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L2280-L2359
export interface OpenAIResponsesComputerCallOutputItem {
  type: 'computer_call_output';
  id?: string | null;
  call_id: string;
  output: {
    type: 'computer_screenshot';
    file_id?: string;
    image_url?: string;
  };
  acknowledged_safety_checks?: OpenAIResponsesComputerSafetyCheck[] | null;
  status?: string | null;
  created_by?: string;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L7119-L7223
export interface OpenAIResponsesToolSearchCallItem {
  type: 'tool_search_call';
  arguments: unknown;
  id?: string | null;
  call_id?: string | null;
  execution?: 'server' | 'client';
  status?: string | null;
  created_by?: string;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

export interface OpenAIResponsesToolSearchOutputItem {
  type: 'tool_search_output';
  tools: OpenAIResponsesTool[];
  id?: string | null;
  call_id?: string | null;
  execution?: 'server' | 'client';
  status?: string | null;
  created_by?: string;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L4265-L4285
export interface OpenAIResponsesInputAdditionalToolsItem {
  type: 'additional_tools';
  role: 'developer';
  tools: OpenAIResponsesTool[];
  id?: string | null;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L4919-L4971
export interface OpenAIResponsesProgramItem {
  type: 'program';
  id: string;
  call_id: string;
  code: string;
  fingerprint: string;
}

export interface OpenAIResponsesProgramOutputItem {
  type: 'program_output';
  id: string;
  call_id: string;
  result: string;
  status: 'completed' | 'incomplete';
}

// OpenAI beta OpenAI Responses multi-agent item shapes.
// https://github.com/openai/openai-node/blob/228c224393ef4bf3bda2a9d7eb40f387499299b5/src/resources/beta/responses/responses.ts#L6549-L6805
export type OpenAIResponsesAgentMessageContent =
  | OpenAIResponsesInputText
  | OpenAIResponsesInputImage
  | OpenAIResponsesInputFile
  | { type: 'text' | 'summary_text' | 'reasoning_text'; text: string }
  | { type: 'refusal'; refusal: string }
  | { type: 'computer_screenshot'; image_url: string | null; file_id: string | null; detail?: 'auto' | 'low' | 'high' | 'original' | (string & {}) | null }
  | { type: 'encrypted_content'; encrypted_content: string }
  | (Record<string, unknown> & { type: string });

export interface OpenAIResponsesInputAgentMessageItem {
  type: 'agent_message';
  author: string;
  recipient: string;
  content: OpenAIResponsesAgentMessageContent[];
  id?: string | null;
  agent?: { agent_name: string } | null;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

export type OpenAIResponsesMultiAgentAction =
  | 'spawn_agent'
  | 'interrupt_agent'
  | 'list_agents'
  | 'send_message'
  | 'followup_task'
  | 'wait_agent';

export interface OpenAIResponsesInputMultiAgentCallItem {
  type: 'multi_agent_call';
  action: OpenAIResponsesMultiAgentAction;
  arguments: string;
  call_id: string;
  id?: string | null;
  agent?: { agent_name: string } | null;
}

export interface OpenAIResponsesInputMultiAgentCallOutputItem {
  type: 'multi_agent_call_output';
  action: OpenAIResponsesMultiAgentAction;
  call_id: string;
  output: Array<Record<string, unknown> & { type: 'output_text'; text: string }>;
  id?: string | null;
  agent?: { agent_name: string } | null;
}

// Legacy RemoteCompactionV2 history shape. Current OpenAI Responses uses
// `compaction_trigger` input and `compaction` output; Codex still deserializes
// this form when replaying older rollouts.
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/protocol/src/models.rs#L1135-L1148
export interface OpenAIResponsesContextCompactionItem extends OpenAIResponsesPermissiveItem<'context_compaction'> {
  encrypted_content?: string;
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1918-L1963
export interface OpenAIResponsesCompactionItem {
  type: 'compaction';
  id?: string | null;
  encrypted_content: string;
  created_by?: string;
}

// Payload-free trailing input item for a RemoteCompactionV2 round trip.
// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L4894-L4902
export interface OpenAIResponsesCompactionTriggerItem {
  type: 'compaction_trigger';
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1852-L1915
export interface OpenAIResponsesCodeInterpreterCallItem {
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
export interface OpenAIResponsesLocalShellCallItem {
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

export interface OpenAIResponsesLocalShellCallOutputItem {
  type: 'local_shell_call_output';
  id?: string | null;
  call_id: string;
  output: string;
  status?: string | null;
}

export type OpenAIResponsesShellEnvironment =
  | { type: 'local' }
  | { type: 'container_reference'; container_id: string };

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L3154-L3344
export interface OpenAIResponsesShellCallItem {
  type: 'shell_call';
  id?: string | null;
  call_id: string;
  action: {
    commands: string[];
    max_output_length?: number | null;
    timeout_ms?: number | null;
  };
  environment?: OpenAIResponsesShellEnvironment | null;
  status?: string | null;
  caller?: OpenAIResponsesToolCaller | null;
  created_by?: string;
}

export interface OpenAIResponsesShellCallOutputItem {
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
  caller?: OpenAIResponsesToolCaller | null;
  created_by?: string;
}

export type OpenAIResponsesApplyPatchOperation =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'delete_file'; path: string }
  | { type: 'update_file'; path: string; diff: string };

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1472-L1643
export interface OpenAIResponsesApplyPatchCallItem {
  type: 'apply_patch_call';
  id?: string | null;
  call_id: string;
  operation: OpenAIResponsesApplyPatchOperation;
  status: 'in_progress' | 'completed';
  caller?: OpenAIResponsesToolCaller | null;
  created_by?: string;
}

export interface OpenAIResponsesApplyPatchCallOutputItem {
  type: 'apply_patch_call_output';
  id?: string | null;
  call_id: string;
  status: 'completed' | 'failed';
  output?: string | null;
  caller?: OpenAIResponsesToolCaller | null;
  created_by?: string;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L4727-L4892
export interface OpenAIResponsesMcpCallItem {
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

export interface OpenAIResponsesMcpListToolsItem {
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

export interface OpenAIResponsesMcpApprovalRequestItem {
  type: 'mcp_approval_request';
  id: string;
  arguments: string;
  name: string;
  server_label: string;
}

export interface OpenAIResponsesMcpApprovalResponseItem {
  type: 'mcp_approval_response';
  id?: string | null;
  approval_request_id: string;
  approve: boolean;
  reason?: string | null;
}

export interface OpenAIResponsesInputImageGenerationCall {
  type: 'image_generation_call';
  id?: string;
  status?: 'completed' | 'in_progress' | 'generating' | 'failed';
  result?: string;
  revised_prompt?: string;
  output_format?: 'png' | 'jpeg';
  error?: { message: string; code: string; type?: string };
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L822-L851
export type OpenAIResponsesToolAllowedCaller = 'direct' | 'programmatic';

export interface OpenAIResponsesFunctionTool {
  type: 'function';
  name: string;
  // One interface serves both wire directions, and they disagree on
  // `description`, `parameters` and `strict`: a request may omit all three,
  // while the echoed response tool marks all three required with an explicit
  // `null` alternative. The union of the two is optional-and-nullable, so a
  // translator must handle absent and `null` alike.
  // Request: https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L808-L847
  // Response: https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2141-L2192
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
  allowed_callers?: OpenAIResponsesToolAllowedCaller[] | null;
  defer_loading?: boolean;
  output_schema?: Record<string, unknown> | null;
}

// Codex and other OpenAI Responses clients ship hosted server tools (web_search,
// image_generation, tool_search), namespace containers for function/custom
// tools, and Freeform `custom` tools alongside ordinary function tools. Native
// OpenAI Responses targets pass `custom` through; translated targets wrap each
// `custom` as a single-string-parameter function tool and unwrap matching
// function calls back into `custom_tool_call` outputs. The wire-level tools
// array is still a heterogeneous union and translators must narrow on
// `type === "function"` (or `"custom"`) before reading `name` / `parameters`.
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

export type OpenAIResponsesHostedToolType =
  | typeof WEB_SEARCH_HOSTED_TYPE_NAMES[number]
  | 'image_generation'
  | 'tool_search';

export interface OpenAIResponsesHostedTool {
  type: OpenAIResponsesHostedToolType;
  // web_search-specific fields per the OpenAI Responses guide. Typed
  // explicitly to avoid unsafe index-signature casts at the call site.
  filters?: {
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
  user_location?: {
    type?: 'approximate';
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
  search_context_size?: 'low' | 'medium' | 'high';
  // Settings forwarded when the hosted tool is executed through Codex's
  // standalone `/alpha/search` API.
  // https://github.com/openai/codex/blob/2f19a57704fb7b1db032bc38cf995034254eaebb/codex-rs/codex-api/src/search.rs#L215-L295
  external_web_access?: boolean | 'cached' | 'indexed' | 'live';
  image_settings?: {
    max_results?: number;
    caption?: boolean;
  };
  allowed_callers?: Array<'direct' | 'shell' | 'code_interpreter'>;
  search_content_types?: string[];
  return_token_budget?: 'default' | 'unlimited';
  name?: string;
  // Forward-compat catch-all for other hosted-tool fields the gateway
  // doesn't currently inspect.
  [key: string]: unknown;
}

export interface OpenAIResponsesCustomTool {
  type: 'custom';
  name: string;
  description?: string;
  format?: Record<string, unknown>;
  allowed_callers?: OpenAIResponsesToolAllowedCaller[] | null;
  defer_loading?: boolean;
}

// Namespace descriptions remain required, but OpenAI deliberately permits an
// empty string. Provider adapters whose upstreams still enforce the former
// minLength constraint must own that compatibility rewrite rather than
// narrowing this canonical contract.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
export interface OpenAIResponsesNamespaceTool {
  type: 'namespace';
  name: string;
  description: string;
  tools: Array<OpenAIResponsesFunctionTool | OpenAIResponsesCustomTool>;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L8110-L8115
export interface OpenAIResponsesProgrammaticTool {
  type: 'programmatic_tool_calling';
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L7871-L8080
export interface OpenAIResponsesMcpTool {
  type: 'mcp';
  server_label: string;
  allowed_callers?: OpenAIResponsesToolAllowedCaller[] | null;
  defer_loading?: boolean;
  [key: string]: unknown;
}

export interface OpenAIResponsesCodeInterpreterTool {
  type: 'code_interpreter';
  container: string | Record<string, unknown>;
  allowed_callers?: OpenAIResponsesToolAllowedCaller[] | null;
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L541-L577
export interface OpenAIResponsesComputerTool {
  type: 'computer';
}

export interface OpenAIResponsesComputerUsePreviewTool {
  type: 'computer_use_preview';
  display_height: number;
  display_width: number;
  environment: 'windows' | 'mac' | 'linux' | 'ubuntu' | 'browser';
}

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L729-L806
export interface OpenAIResponsesFileSearchTool {
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
export interface OpenAIResponsesLocalShellTool {
  type: 'local_shell';
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L803-L815
export interface OpenAIResponsesShellTool {
  type: 'shell';
  allowed_callers?: OpenAIResponsesToolAllowedCaller[] | null;
  environment?: unknown;
}

// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L245-L264
export interface OpenAIResponsesApplyPatchTool {
  type: 'apply_patch';
  allowed_callers?: OpenAIResponsesToolAllowedCaller[] | null;
}

export type OpenAIResponsesTool =
  | OpenAIResponsesFunctionTool
  | OpenAIResponsesHostedTool
  | OpenAIResponsesCustomTool
  | OpenAIResponsesNamespaceTool
  | OpenAIResponsesProgrammaticTool
  | OpenAIResponsesMcpTool
  | OpenAIResponsesCodeInterpreterTool
  | OpenAIResponsesComputerTool
  | OpenAIResponsesComputerUsePreviewTool
  | OpenAIResponsesFileSearchTool
  | OpenAIResponsesLocalShellTool
  | OpenAIResponsesShellTool
  | OpenAIResponsesApplyPatchTool;

export const mapOpenAIResponsesTools = (
  payload: CanonicalOpenAIResponsesPayload,
  transform: (tool: OpenAIResponsesTool) => OpenAIResponsesTool,
): CanonicalOpenAIResponsesPayload => {
  const mapTools = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => tools.map(transform);
  const input = payload.input.map(item => {
    switch (item.type) {
    case 'additional_tools':
    case 'tool_search_output':
      return { ...item, tools: mapTools(item.tools) };
    default:
      return item;
    }
  });
  return {
    ...payload,
    input,
    ...(Array.isArray(payload.tools) ? { tools: mapTools(payload.tools) } : {}),
  };
};

// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L8250-L8400
export type OpenAIResponsesToolChoice =
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
      | OpenAIResponsesHostedToolType
      | 'file_search'
      | 'computer'
      | 'computer_use_preview'
      | 'computer_use'
      | 'code_interpreter'
      | 'mcp';
  };

// ── Response types ──

export interface OpenAIResponsesResult {
  id: string;
  object: string;
  model: string;
  output: OpenAIResponsesOutputItem[];
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
  tools?: OpenAIResponsesTool[];
  tool_choice?: OpenAIResponsesToolChoice | null;
  // The response resource requires `usage` and gives it an explicit `null`
  // alternative, so `null` is what an upstream sends for a response that
  // reported no token counts. The key stays optional because a partially built
  // envelope carries no usage until the terminal event accounts for the turn.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2613-L2629
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723
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
  } | null;
  // ── Further fields the response resource declares required ──
  //
  // Every key below is listed in `ResponseResource.required` — as are `tools`,
  // `tool_choice`, `usage` and `service_tier` above — so a spec-conforming
  // client-facing body must carry all of them:
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723
  // They stay optional here because this interface also models what an
  // arbitrary upstream sends and what a translator assembles mid-stream.
  // Presence on the client-facing body is carried by `ClientResponseResource`
  // in `./client-resource.ts`, which derives from this interface rather than
  // restating it.
  //
  // Unix seconds, not milliseconds.
  created_at?: number;
  // Null until the response reaches a terminal status.
  completed_at?: number | null;
  previous_response_id?: string | null;
  instructions?: string | null;
  truncation?: 'auto' | 'disabled' | (string & {}) | null;
  parallel_tool_calls?: boolean;
  text?: { format?: Record<string, unknown> | null; verbosity?: string | null } | null;
  top_p?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  top_logprobs?: number | null;
  temperature?: number | null;
  // `effort` and `summary` are themselves required whenever `reasoning` is an
  // object; other keys upstreams add (`context`, `mode`) ride along untouched.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2320-L2359
  reasoning?: {
    effort?: string | null;
    summary?: 'detailed' | 'auto' | 'concise' | (string & {}) | null;
    context?: 'auto' | 'current_turn' | 'all_turns' | (string & {}) | null;
    [key: string]: unknown;
  } | null;
  max_output_tokens?: number | null;
  max_tool_calls?: number | null;
  // Whether the response was stored so it can be retrieved later — the wording
  // of the schema's own description, which is why the gateway answers it from
  // its store rather than from the request's `store` flag.
  store?: boolean;
  background?: boolean;
  metadata?: Record<string, unknown> | null;
  safety_identifier?: string | null;
  prompt_cache_key?: string | null;
}

// Stored/output additional-tools roles are wider than the input-only
// `developer` role.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L5116-L5136
export type OpenAIResponsesAdditionalToolsRole =
  | 'unknown'
  | 'user'
  | 'assistant'
  | 'system'
  | 'critic'
  | 'discriminator'
  | 'developer'
  | 'tool';

export interface OpenAIResponsesOutputAdditionalToolsItem {
  type: 'additional_tools';
  id: string;
  role: OpenAIResponsesAdditionalToolsRole;
  tools: OpenAIResponsesTool[];
}

export type OpenAIResponsesOutputAgentMessageItem = Omit<OpenAIResponsesInputAgentMessageItem, 'id' | 'agent'> & {
  id: string;
  agent?: { agent_name: string };
};

export type OpenAIResponsesOutputMultiAgentCallItem = Omit<OpenAIResponsesInputMultiAgentCallItem, 'id' | 'agent'> & {
  id: string;
  agent?: { agent_name: string };
};

export type OpenAIResponsesOutputMultiAgentCallOutputItem = Omit<OpenAIResponsesInputMultiAgentCallOutputItem, 'id' | 'agent'> & {
  id: string;
  agent?: { agent_name: string };
};

export type OpenAIResponsesOutputItem =
  | OpenAIResponsesOutputMessage
  | OpenAIResponsesOutputFunctionCall
  | OpenAIResponsesFunctionCallOutputItem
  | OpenAIResponsesOutputCustomToolCall
  | OpenAIResponsesCustomToolCallOutputItem
  | OpenAIResponsesOutputReasoning
  | OpenAIResponsesOutputWebSearchCall
  | OpenAIResponsesFileSearchCallItem
  | OpenAIResponsesComputerCallItem
  | OpenAIResponsesComputerCallOutputItem
  | OpenAIResponsesToolSearchCallItem
  | OpenAIResponsesToolSearchOutputItem
  | OpenAIResponsesOutputAdditionalToolsItem
  | OpenAIResponsesProgramItem
  | OpenAIResponsesProgramOutputItem
  | OpenAIResponsesOutputAgentMessageItem
  | OpenAIResponsesOutputMultiAgentCallItem
  | OpenAIResponsesOutputMultiAgentCallOutputItem
  | OpenAIResponsesContextCompactionItem
  | OpenAIResponsesCompactionItem
  | OpenAIResponsesCodeInterpreterCallItem
  | OpenAIResponsesLocalShellCallItem
  | OpenAIResponsesLocalShellCallOutputItem
  | OpenAIResponsesShellCallItem
  | OpenAIResponsesShellCallOutputItem
  | OpenAIResponsesApplyPatchCallItem
  | OpenAIResponsesApplyPatchCallOutputItem
  | OpenAIResponsesMcpCallItem
  | OpenAIResponsesMcpListToolsItem
  | OpenAIResponsesMcpApprovalRequestItem
  | OpenAIResponsesMcpApprovalResponseItem
  | OpenAIResponsesOutputImageGenerationCall;

// The OpenAI Responses item schema requires `status` on an output message and
// `annotations` on every `output_text` part, even when the text carries no
// citations, so both are modeled as required and the compiler forces every
// producer to state them:
// https://github.com/openai/openai-openapi/blob/d2f04809d7961f01e94031e1f31617394599dbdd/openapi.yaml#L44868-L44873
// https://github.com/openai/openai-openapi/blob/d2f04809d7961f01e94031e1f31617394599dbdd/openapi.yaml#L66303-L66307
// `id` is schema-required too but stays optional: an upstream item that omits
// it is surfaced by `requireItemId` rather than given an invented value.
export interface OpenAIResponsesOutputMessage {
  type: 'message';
  id?: string;
  status: string;
  role: 'assistant';
  content: OpenAIResponsesOutputContentBlock[];
  phase?: OpenAIResponsesMessagePhase;
}

export type OpenAIResponsesOutputContentBlock = OpenAIResponsesOutputText | OpenAIResponsesOutputRefusal;

export interface OpenAIResponsesAnnotation {
  type: 'url_citation';
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}

export interface OpenAIResponsesOutputText {
  type: 'output_text';
  text: string;
  annotations: OpenAIResponsesAnnotation[];
}

export interface OpenAIResponsesOutputRefusal {
  type: 'refusal';
  refusal: string;
}

export interface OpenAIResponsesOutputFunctionCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
  status: string;
  caller?: OpenAIResponsesToolCaller | null;
}

export type OpenAIResponsesOutputCustomToolCall = OpenAIResponsesCustomToolCallItem;

export interface OpenAIResponsesOutputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
  // See `OpenAIResponsesInputReasoning.encrypted_content`.
  encrypted_content?: string;
}

// Web-search call types. `results` is opt-in on the wire (native gates
// it on `include: ["web_search_call.results"]`); consumers must
// tolerate its absence.

export type OpenAIResponsesWebSearchAction =
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

export interface OpenAIResponsesWebSearchResult {
  type: 'text_result';
  url: string;
  title: string;
  snippet: string;
}

export interface OpenAIResponsesOutputWebSearchCall {
  type: 'web_search_call';
  id: string;
  status: 'in_progress' | 'searching' | 'completed' | 'failed';
  // Optional because upstream omits `action` on the in-flight
  // `output_item.added` and only populates it on `.done` once the
  // action shape (search vs open_page vs find_in_page) is known.
  action?: OpenAIResponsesWebSearchAction;
  results?: OpenAIResponsesWebSearchResult[];
}

export interface OpenAIResponsesOutputImageGenerationCall {
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
export type OpenAIResponsesStreamEvent = OpenAIResponsesStreamEventVariant & { sequence_number?: number };

type OpenAIResponsesStreamEventVariant =
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L6456-L6471
  | { type: 'response.queued'; response: OpenAIResponsesResult }
  | { type: 'response.created'; response: OpenAIResponsesResult }
  | { type: 'response.in_progress'; response: OpenAIResponsesResult }
  | {
    type: 'response.output_item.added';
    output_index: number;
    item: OpenAIResponsesOutputItem;
  }
  | {
    type: 'response.output_item.done';
    output_index: number;
    item: OpenAIResponsesOutputItem;
  }
  | {
    type: 'response.content_part.added';
    item_id: string;
    output_index: number;
    content_index: number;
    part: OpenAIResponsesOutputContentBlock;
  }
  | {
    type: 'response.content_part.done';
    item_id: string;
    output_index: number;
    content_index: number;
    part: OpenAIResponsesOutputContentBlock;
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
    type: 'response.refusal.delta';
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
  }
  | {
    type: 'response.refusal.done';
    item_id: string;
    output_index: number;
    content_index: number;
    refusal: string;
  }
  | {
    type: 'response.output_text.annotation.added';
    output_index: number;
    content_index: number;
    annotation_index: number;
    item_id: string;
    annotation: OpenAIResponsesAnnotation;
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
  | { type: 'response.completed'; response: OpenAIResponsesResult }
  | { type: 'response.incomplete'; response: OpenAIResponsesResult }
  | { type: 'response.failed'; response: OpenAIResponsesResult }
  | {
    type: 'error';
    message: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    target_api?: string;
  };

// Either side of the OpenAI Responses reasoning round trip: input echoes a prior
// turn's reasoning back in, output emits the current turn's reasoning. Shape
// is identical aside from the type tag's role.
export type OpenAIResponsesReasoningItem = OpenAIResponsesInputReasoning | OpenAIResponsesOutputReasoning;

export const isOpenAIResponsesTerminalEvent = (event: Pick<OpenAIResponsesStreamEvent, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error';

// Typed accessor for the `response` payload carried on lifecycle envelopes
// (`response.queued`, `response.created`, `response.in_progress`, `response.completed`,
// `response.incomplete`, `response.failed`). Returns null on every other
// event type so callers don't have to reproduce the variant check.
export const openaiResponsesResultFromStreamEvent = (event: OpenAIResponsesStreamEvent): OpenAIResponsesResult | null =>
  'response' in event ? event.response : null;

export {
  type CanonicalOpenAIResponsesCompactPayload,
  type OpenAIResponsesCompactionResult,
  type OpenAIResponsesCompactPayload,
  toCompactPayloadShape,
} from './compact.ts';
export { openaiResponsesResultToEvents } from './from-result.ts';
export { imageGenerationCallLifecycleEvents } from './image-generation-lifecycle.ts';
export { webSearchCallLifecycleEvents } from './web-search-lifecycle.ts';
export { parseOpenAIResponsesStream, type ParseOpenAIResponsesStreamOptions } from './stream.ts';

export type {
  ClientResponseResource,
  ClientOpenAIResponsesCompaction,
  ClientOpenAIResponsesReasoning,
  ClientOpenAIResponsesStreamEvent,
  ClientOpenAIResponsesTextField,
  ClientOpenAIResponsesTool,
  ClientOpenAIResponsesUsage,
} from './client-resource.ts';
export { OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, collectOpenAIResponsesProtocolEventsToResult } from './to-result.ts';
export { createRandomOpenAIResponsesItemId, type GeneratedOpenAIResponsesItemType } from './item-id.ts';
export { reassembleOpenAIResponsesEvents } from './reassemble.ts';
export { openaiResponsesProtocolFrameToSSEFrame } from './to-sse.ts';
