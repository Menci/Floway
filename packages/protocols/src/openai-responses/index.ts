import type * as OfficialBeta from './sdk-beta.ts';
import type * as Official from './sdk.ts';
import type { OpenWire } from '../common/open-wire.ts';

// OpenAI Responses API type definitions
// Used for translating Anthropic Messages ↔ OpenAI Responses APIs

// ── Request types ──

// Supported for gpt-5.6+. Slots remain open-string so future modes and
// lifetimes reach the upstream unchanged.
// https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/responses/response_compact_params.py#L144-L184
export interface OpenAIResponsesPromptCacheOptions {
  mode?: 'implicit' | 'explicit' | (string & {});
  ttl?: '30m' | (string & {});
  prewarm?: boolean;
  comparison_response_id?: string | null;
}

export type OpenAIResponsesPromptCacheRetention = 'in_memory' | '24h' | (string & {});

export type OpenAIResponsesPayload = Official.ResponseCreateParamsBase & {
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  // WebSocket response.create only: false warms request state without generation.
  // https://developers.openai.com/api/docs/guides/websocket-mode
  generate?: boolean | null;
};

// Floway accepts OpenResponses and documented provider request extensions at its boundary.
export interface OpenAIResponsesPayloadEx extends Omit<OpenAIResponsesPayload, 'model' | 'input' | 'access_programs' | 'context_management' | 'conversation' | 'moderation' | 'prompt' | 'stream_options' | 'user' | 'previous_response_id' | 'instructions' | 'temperature' | 'top_p' | 'max_output_tokens' | 'max_tool_calls' | 'tools' | 'tool_choice' | 'metadata' | 'stream' | 'store' | 'parallel_tool_calls' | 'reasoning' | 'include' | 'text' | 'prompt_cache_key' | 'prompt_cache_options' | 'prompt_cache_retention' | 'safety_identifier' | 'service_tier' | 'truncation' | 'background' | 'top_logprobs' | 'presence_penalty' | 'frequency_penalty'> {
  model: string;
  input: string | CanonicalOpenAIResponsesInputItem[];
  access_programs?: { cyber?: string };
  context_management?: { type: string; compact_threshold?: number | null }[] | null;
  conversation?: string | { id: string } | null;
  moderation?: { model: string; policy?: { input?: { mode: string } | null; output?: { mode: string } | null } | null } | null;
  prompt?: { id: string; version?: string | null; variables?: Record<string, string | OpenAIResponsesInputText | OpenAIResponsesInputImage | OpenAIResponsesInputFile> | null } | null;
  stream_options?: { include_obfuscation?: boolean } | null;
  user?: string;
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
  metadata?: Record<string, string> | null;
  stream?: boolean | null;
  store?: boolean | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: {
    effort?: string | null;
    summary?: 'detailed' | 'auto' | 'concise' | (string & {}) | null;
    generate_summary?: string | null;
    mode?: string | null;
    // Controls which reasoning items are rendered back to the model on later
    // turns; echoed on the response as the effective mode. Canonical values are
    // `auto` / `current_turn` / `all_turns`, but the slot stays open-string so
    // future upstream modes forward verbatim rather than being narrowed at this
    // boundary. Reference (openai-python shared Reasoning.context):
    // https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/shared/reasoning.py#L19-L25
    // Reference (openai-node Reasoning.context):
    // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/shared.ts#L262-L269
    context?: 'auto' | 'current_turn' | 'all_turns' | (string & {}) | null;
  } | null;
  include?: string[] | null;
  // `text.verbosity` is a native GPT-5-family OpenAI Responses field that controls
  // response length; `text.format` carries structured-output schemas. Both
  // ride on the same `text` object.
  // Reference: https://platform.openai.com/docs/api-reference/responses/create
  text?: { format?: Official.ResponseFormatTextConfig | null; verbosity?: string | null } | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: OpenAIResponsesPromptCacheOptions;
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
  // OpenResponses includes these standard request and response sampling controls.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723
  // https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L32766-L32771
  presence_penalty?: number | null;
  // https://github.com/openai/openai-openapi/blob/db14b6e1712aaf5265cf5a6871adff7a9c61d31c/openapi.yaml#L32752-L32757
  frequency_penalty?: number | null;
}

// Canonical inputs include documented provider extensions and normalized message discriminators.
export type CanonicalOpenAIResponsesInputItem =
  | OpenAIResponsesInputMessage
  | OpenAIResponsesFunctionToolCallItem
  | OpenAIResponsesFunctionCallOutputItem
  | OpenAIResponsesCustomToolCallItem
  | OpenAIResponsesCustomToolCallOutputItem
  | OpenAIResponsesInputReasoning
  | OpenAIResponsesConfigurationUpdate
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

// Codex attaches harness metadata to every history item it replays.
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/protocol/src/models.rs#L1140-L1426
interface CodexInternalChatMessageMetadata {
  internal_chat_message_metadata_passthrough?: Record<string, unknown>;
}

export type OpenAIResponsesMessagePhase = OpenWire<NonNullable<Official.EasyInputMessage['phase']>> | null;

// An input message is either the explicitly typed request message or an echoed
// assistant output message. Codex replays both with optional item IDs and the
// output phase on every role.
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/protocol/src/models.rs#L1147-L1158
interface OpenAIResponsesInputMessageFields extends CodexInternalChatMessageMetadata {
  type: 'message';
  id?: string;
  status?: OpenWire<NonNullable<Official.ResponseInputItem.Message['status']>>;
  phase?: OpenAIResponsesMessagePhase;
}

export type OpenAIResponsesInputMessage = OpenAIResponsesInputMessageFields & (
  | { role: 'user' | 'system' | 'developer'; content: string | OpenAIResponsesInputContent[] }
  | { role: 'assistant'; content: string | OpenAIResponsesAssistantInputContent[] }
);

// The request schema's EasyInputMessage makes the constant `type: "message"`
// discriminator optional. Wire-facing payloads accept that shorthand; gateway
// and translator boundaries normalize it before internal item processing so the
// canonical union remains explicitly discriminated.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L697-L721
export type OpenAIResponsesEasyInputMessage = Omit<OpenWire<Official.EasyInputMessage>, 'content'> & CodexInternalChatMessageMetadata & {
  content: string | OpenAIResponsesInputContent[];
};

export type OpenAIResponsesRequestInputItem =
  | OpenAIResponsesEasyInputMessage
  | CanonicalOpenAIResponsesInputItem;

export type OpenAIResponsesRequestPayloadEx = Omit<OpenAIResponsesPayloadEx, 'model' | 'input'> & {
  model?: string;
  input?: string | OpenAIResponsesRequestInputItem[];
};

export type CanonicalOpenAIResponsesPayload = Omit<OpenAIResponsesPayloadEx, 'input'> & {
  input: CanonicalOpenAIResponsesInputItem[];
};

// Replayed history carries assistant output text inside input messages; Codex
// sends it on every role.
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/protocol/src/models.rs#L954-L984
export type OpenAIResponsesInputText = Omit<OpenWire<Official.ResponseInputTextContent>, 'type'> & { type: 'input_text' | 'output_text' };
// OpenAI splits this part in two: `ResponseInputImageContent` is the
// request-side shape and leaves `detail` optional and nullable, while
// `ResponseInputImage` requires it and is the response-side echo. Omitting
// `detail` means `auto` on both OpenAI Responses and OpenAI Chat Completions.
// https://web.archive.org/web/20260730100926/https://developers.openai.com/api/docs/guides/images-vision.md
export type OpenAIResponsesInputImage = OpenWire<Official.ResponseInputImageContent>;
export type OpenAIResponsesInputFile = OpenWire<Official.ResponseInputFileContent>;

// Codex permits an audio reference beside the OpenAI SDK's text/image/file parts.
// https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/protocol/src/models.rs#L922-L985
export type OpenAIResponsesInputAudio = {
  type: 'input_audio';
  prompt_cache_breakpoint?: OpenWire<Official.ResponseInputFileContent['prompt_cache_breakpoint']>;
} & ({ audio_url: string; file_id?: never } | { file_id: string; audio_url?: never });

export type OpenAIResponsesInputContent = OpenAIResponsesInputText | OpenAIResponsesInputImage | OpenAIResponsesInputFile | OpenAIResponsesInputAudio;

export type OpenAIResponsesAssistantInputContent = OpenAIResponsesInputContent | OpenAIResponsesOutputRefusal;

export type OpenAIResponsesToolOutputContent = OpenAIResponsesInputContent;

export type OpenAIResponsesConfigurationUpdate = OpenWire<Official.ResponseConfigurationUpdateItemParam>;

export type OpenAIResponsesReasoningText = OpenWire<Official.ResponseReasoningItem.Content>;

// Reasoning input permits an omitted or null ID. `encrypted_content` is the
// opaque blob the upstream signs against `(account, id)`. It is never
// requested through `include: ['reasoning.encrypted_content']` (forcing it
// breaks non-OpenAI reasoning models); it is present only when the upstream
// volunteers it, and round-trips verbatim so the next-turn signature check
// passes.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#/components/schemas/ReasoningItemParam
export type OpenAIResponsesInputReasoning = Omit<OpenWire<Official.ResponseReasoningItem>, 'id'> & CodexInternalChatMessageMetadata & {
  id?: string | null;
};

export type OpenAIResponsesToolCaller = OpenWire<Official.ResponseFunctionToolCall.Direct | Official.ResponseFunctionToolCall.Program>;

// Codex marks a plaintext collaboration call with an empty
// `encrypted_function_args` list.
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/protocol/src/models.rs#L1180-L1193
// https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/tools/router.rs#L31-L55
type OpenAIResponsesFunctionCall = OpenWire<Official.ResponseFunctionToolCall> & CodexInternalChatMessageMetadata & {
  encrypted_function_args?: string[] | null;
};

// Replayed input can explicitly mark an unresolved namespace with null.
export type OpenAIResponsesFunctionToolCallItem = Omit<OpenAIResponsesFunctionCall, 'namespace'> & {
  namespace?: string | null;
};

// An output without `call_id` is standalone: it answers no function call and
// instead names the tool that produced it.
export type OpenAIResponsesFunctionCallOutputItem = Omit<OpenWire<Official.ResponseInputItem.FunctionCallOutput>, 'output'> & CodexInternalChatMessageMetadata & {
  output: string | OpenAIResponsesToolOutputContent[];
};

// Codex replays custom tool calls with the item status it observed.
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/protocol/src/models.rs#L1289-L1303
export type OpenAIResponsesCustomToolCallItem = OpenWire<Official.ResponseCustomToolCall> & CodexInternalChatMessageMetadata & {
  status?: OpenWire<Official.ResponseCustomToolCallOutputItem['status']>;
};

// History replays the output item's status, which the input declaration omits.
// https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/lib/responses/ResponseInputItems.ts#L115-L160
export type OpenAIResponsesCustomToolCallOutputItem = Omit<OpenWire<Official.ResponseCustomToolCallOutput>, 'output'> & CodexInternalChatMessageMetadata & {
  output: string | OpenAIResponsesToolOutputContent[];
  status?: OpenWire<Official.ResponseCustomToolCallOutputItem['status']>;
};

// The canonical union keeps every item explicitly discriminated; a reference
// without `type` is a wire shorthand.
export type OpenAIResponsesItemReference = OpenWire<Official.ResponseInputItem.ItemReference> & { type: 'item_reference' };

export interface OpenAIResponsesWebSearchTextResult {
  // Codex's official wire tests preserve future fields alongside this shape.
  // https://github.com/openai/codex/blob/081f205f423eb2a4db54318e7ded3b074aeb5532/codex-rs/codex-api/src/endpoint/search.rs#L138-L150
  type: 'text_result';
  url: string;
  title: string;
  snippet: string;
  ref_id?: string;
  [field: string]: unknown;
}

export interface OpenAIResponsesWebSearchImageResult {
  // https://developers.openai.com/api/docs/guides/tools-web-search#image-search-results
  type: 'image_result';
  image_url: string;
  source_website_url: string;
  thumbnail_url?: string | null;
  caption?: string | null;
  [field: string]: unknown;
}

export type OpenAIResponsesWebSearchResult =
  | OpenAIResponsesWebSearchTextResult
  | OpenAIResponsesWebSearchImageResult;

export type OpenAIResponsesWebSearchAction = OpenWire<Official.ResponseFunctionWebSearch['action']>;

// `results` is returned on `include: ["web_search_call.results"]`.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts
type OpenAIResponsesWebSearchCallFields = Omit<OpenWire<Official.ResponseFunctionWebSearch>, 'action' | 'results'> & CodexInternalChatMessageMetadata & {
  results?: OpenAIResponsesWebSearchResult[];
};

// An upstream omits `action` on `output_item.added`; clients echo the item back
// in that shape too.
export type OpenAIResponsesOutputWebSearchCall = OpenAIResponsesWebSearchCallFields & {
  action?: OpenAIResponsesWebSearchAction;
};

export type OpenAIResponsesInputWebSearchCall = Omit<OpenAIResponsesOutputWebSearchCall, 'id' | 'status' | 'results'> & {
  id?: string;
  status?: OpenAIResponsesOutputWebSearchCall['status'];
};

export type OpenAIResponsesFileSearchCallItem = OpenWire<Official.ResponseFileSearchToolCall>;

export type OpenAIResponsesComputerAction = OpenWire<Official.ComputerAction>;

// Modern `computer` emits `actions` and rejects even an empty
// `pending_safety_checks`; the legacy `computer_use_preview` shape uses the
// singular `action` plus safety checks. Keep both wire generations explicit.
// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L1990-L2035
// https://github.com/Menci/Floway/pull/246#issuecomment-5028154071
type OpenAIResponsesComputerCallFields = Omit<OpenWire<Official.ResponseComputerToolCall>, 'action' | 'actions' | 'pending_safety_checks'>;

export type OpenAIResponsesComputerCallItem = OpenAIResponsesComputerCallFields & (
  | {
    actions: OpenAIResponsesComputerAction[];
    action?: never;
    pending_safety_checks?: never;
  }
  | {
    action: OpenAIResponsesComputerAction;
    actions?: never;
    pending_safety_checks: OpenWire<Official.ResponseComputerToolCall.PendingSafetyCheck>[];
  }
);

// History replays the output item's `created_by`.
// https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/lib/responses/ResponseInputItems.ts#L41-L67
export type OpenAIResponsesComputerCallOutputItem = OpenWire<Official.ResponseInputItem.ComputerCallOutput> & Pick<OpenWire<Official.ResponseComputerToolCallOutputItem>, 'created_by'>;

export type OpenAIResponsesToolSearchCallItem = OpenWire<Official.ResponseInputItem.ToolSearchCall> & Pick<OpenWire<Official.ResponseToolSearchCall>, 'created_by'> & CodexInternalChatMessageMetadata;

export type OpenAIResponsesToolSearchOutputItem = Omit<OpenWire<Official.ResponseToolSearchOutputItemParam>, 'tools'> & Pick<OpenWire<Official.ResponseToolSearchOutputItem>, 'created_by'> & CodexInternalChatMessageMetadata & {
  tools: OpenAIResponsesTool[];
};

export type OpenAIResponsesInputAdditionalToolsItem = Omit<OpenWire<Official.ResponseInputItem.AdditionalTools>, 'tools'> & {
  tools: OpenAIResponsesTool[];
};

export type OpenAIResponsesProgramItem = OpenWire<Official.ResponseInputItem.Program>;
export type OpenAIResponsesProgramOutputItem = OpenWire<Official.ResponseInputItem.ProgramOutput>;

// Multi-agent items are official beta contracts. History replays an output agent
// message as input, so input content admits both directions' parts. Codex also
// carries audio and may omit screenshot detail.
type OpenAIResponsesOfficialAgentMessageContent = OpenWire<
  | OfficialBeta.BetaResponseInputItem.AgentMessage['content'][number]
  | OfficialBeta.BetaResponseOutputItem.AgentMessage['content'][number]
>;
type OpenAIResponsesOfficialAgentMessageScreenshot = Extract<OpenAIResponsesOfficialAgentMessageContent, { type: 'computer_screenshot' }>;
export type OpenAIResponsesAgentMessageContent =
  | Exclude<OpenAIResponsesOfficialAgentMessageContent, { type: 'computer_screenshot' }>
  | (Omit<OpenAIResponsesOfficialAgentMessageScreenshot, 'detail'> & { detail?: OpenAIResponsesOfficialAgentMessageScreenshot['detail'] })
  | OpenAIResponsesInputAudio;

export type OpenAIResponsesInputAgentMessageItem = Omit<OpenWire<OfficialBeta.BetaResponseInputItem.AgentMessage>, 'content'> & CodexInternalChatMessageMetadata & {
  content: OpenAIResponsesAgentMessageContent[];
};
export type OpenAIResponsesInputMultiAgentCallItem = OpenWire<OfficialBeta.BetaResponseInputItem.MultiAgentCall>;
export type OpenAIResponsesInputMultiAgentCallOutputItem = OpenWire<OfficialBeta.BetaResponseInputItem.MultiAgentCallOutput>;

// Codex also sends the compaction state under its alias and as a
// context-compaction item whose encrypted content may be absent.
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/protocol/src/models.rs#L1396-L1424
export type OpenAIResponsesCompactionItem = Omit<OpenWire<Official.ResponseCompactionItemParam>, 'type' | 'encrypted_content'> & Pick<OpenWire<Official.ResponseCompactionItem>, 'created_by'> & CodexInternalChatMessageMetadata & {
  type: 'compaction' | 'compaction_summary' | 'context_compaction';
  encrypted_content?: string | null;
};

// Floway's native compaction capture forwards per-turn metadata the upstream
// attaches to the item.
export interface OpenAIResponsesCompactionItemEx extends OpenAIResponsesCompactionItem {
  metadata?: Record<string, unknown>;
}

export type OpenAIResponsesCompactionTriggerItem = OpenWire<Official.ResponseInputItem.CompactionTrigger>;

export type OpenAIResponsesInputImageGenerationCall = OpenWire<Official.ResponseInputItem.ImageGenerationCall> & CodexInternalChatMessageMetadata;

export type OpenAIResponsesCodeInterpreterCallItem = OpenWire<Official.ResponseCodeInterpreterToolCall>;

export type OpenAIResponsesLocalShellCallItem = OpenWire<Official.ResponseInputItem.LocalShellCall> & CodexInternalChatMessageMetadata;

// Legacy local-shell output is opaque text correlated by `call_id`; modern
// shell output uses structured stdout/stderr/outcome chunks below.
// https://github.com/openai/openai-agents-python/blob/2fa463571e76dae8ff267622f1018eaf06ffeb9f/tests/test_local_shell_tool.py#L46-L92
export type OpenAIResponsesLocalShellCallOutputItem = Omit<OpenWire<Official.ResponseInputItem.LocalShellCallOutput>, 'id'> & {
  id?: string | null;
  call_id: string;
};

// History replays the output item's `created_by` on the call and on each
// output chunk.
// https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/lib/responses/ResponseInputItems.ts#L41-L67
export type OpenAIResponsesShellCallItem = OpenWire<Official.ResponseInputItem.ShellCall> & Pick<OpenWire<Official.ResponseFunctionShellToolCall>, 'created_by'>;

export type OpenAIResponsesShellCallOutputItem = Omit<OpenWire<Official.ResponseInputItem.ShellCallOutput>, 'output'> & Pick<OpenWire<Official.ResponseFunctionShellToolCallOutput>, 'created_by'> & {
  output: OpenWire<Official.ResponseFunctionShellToolCallOutput.Output>[];
};

export type OpenAIResponsesApplyPatchCallItem = OpenWire<Official.ResponseInputItem.ApplyPatchCall> & Pick<OpenWire<Official.ResponseApplyPatchToolCall>, 'created_by'>;

export type OpenAIResponsesApplyPatchCallOutputItem = OpenWire<Official.ResponseInputItem.ApplyPatchCallOutput> & Pick<OpenWire<Official.ResponseApplyPatchToolCallOutput>, 'created_by'>;

// Earlier SDK revisions declared the MCP call error as a plain string.
// https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L4876-L4880
export type OpenAIResponsesMcpCallItem = Omit<OpenWire<Official.ResponseInputItem.McpCall>, 'error'> & {
  error?: OpenWire<Official.McpToolCallError> | string | null;
};

export type OpenAIResponsesMcpListToolsItem = OpenWire<Official.ResponseInputItem.McpListTools>;
export type OpenAIResponsesMcpApprovalRequestItem = OpenWire<Official.ResponseInputItem.McpApprovalRequest>;
export type OpenAIResponsesMcpApprovalResponseItem = OpenWire<Official.ResponseInputItem.McpApprovalResponse>;

export type OpenAIResponsesToolAllowedCaller = OpenWire<NonNullable<Official.FunctionTool['allowed_callers']>[number]>;

// One declaration serves both wire directions, and they disagree on
// `parameters` and `strict`: a request may omit both, while the echoed
// response tool marks both required with an explicit `null` alternative. The
// union of the two is optional-and-nullable, so a translator must handle absent
// and `null` alike.
// Request: https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L808-L847
// Response: https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2141-L2192
export type OpenAIResponsesFunctionTool = Omit<OpenWire<Official.FunctionTool>, 'parameters' | 'strict'> & Partial<Pick<OpenWire<Official.FunctionTool>, 'parameters' | 'strict'>>;

export type OpenAIResponsesCustomTool = OpenWire<Official.CustomTool>;

// Namespace descriptions remain required, but OpenAI deliberately permits an
// empty string. Provider adapters whose upstreams still enforce the former
// minLength constraint must own that compatibility rewrite rather than
// narrowing this canonical contract.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
export type OpenAIResponsesNamespaceTool = Omit<OpenWire<Official.NamespaceTool>, 'tools'> & {
  tools: Array<OpenAIResponsesFunctionTool | OpenAIResponsesCustomTool>;
};

// The web-search guide documents controls the pinned SDK declaration has not
// caught up with; Codex sends the same tool with its live-access settings.
// https://web.archive.org/web/20261116202850/https://developers.openai.com/api/docs/guides/tools-web-search
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/tools/src/tool_spec.rs#L33-L53
// https://github.com/openai/codex/blob/24e236514bebcef874c2d38ce5df26164aa50ca4/codex-rs/codex-api/src/search.rs#L218-L248
export type OpenAIResponsesWebSearchTool = Omit<OpenWire<Official.WebSearchTool | Official.WebSearchPreviewTool>, 'filters' | 'external_web_access'> & {
  filters?: OpenWire<Official.WebSearchTool.Filters> & { blocked_domains?: string[] | null } | null;
  external_web_access?: boolean | OpenWire<'cached' | 'indexed' | 'live'>;
  indexed_web_access?: boolean;
  search_content_types?: OpenWire<'text' | 'image'>[];
  image_settings?: { max_results?: number; caption?: boolean };
  return_token_budget?: OpenWire<'default' | 'unlimited'>;
  allowed_callers?: OpenWire<'direct' | 'shell' | 'code_interpreter'>[];
};

export type OpenAIResponsesImageGenerationTool = OpenWire<Official.Tool.ImageGeneration>;

export type OpenAIResponsesToolSearchTool = OpenWire<Official.ToolSearchTool>;

// Hosted tools the gateway can execute through server-tool shims.
export type OpenAIResponsesHostedTool = OpenAIResponsesWebSearchTool | OpenAIResponsesImageGenerationTool | OpenAIResponsesToolSearchTool;

export type OpenAIResponsesHostedToolType = OpenAIResponsesHostedTool['type'];

export type OpenAIResponsesProgrammaticTool = OpenWire<Official.Tool.ProgrammaticToolCalling>;
export type OpenAIResponsesMcpTool = OpenWire<Official.Tool.Mcp>;
export type OpenAIResponsesCodeInterpreterTool = OpenWire<Official.Tool.CodeInterpreter>;
export type OpenAIResponsesComputerTool = OpenWire<Official.ComputerTool>;
export type OpenAIResponsesComputerUsePreviewTool = OpenWire<Official.ComputerUsePreviewTool>;
export type OpenAIResponsesFileSearchTool = OpenWire<Official.FileSearchTool>;
export type OpenAIResponsesLocalShellTool = OpenWire<Official.Tool.LocalShell>;
export type OpenAIResponsesShellTool = OpenWire<Official.FunctionShellTool>;
export type OpenAIResponsesApplyPatchTool = OpenWire<Official.ApplyPatchTool>;

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

// The hosted-tool guides force their tools by type.
// https://developers.openai.com/api/docs/guides/tools-image-generation
type OpenAIResponsesHostedToolChoice = { type: OpenAIResponsesHostedToolType };

export type OpenAIResponsesToolChoice =
  | OpenWire<Official.ToolChoiceOptions>
  | OpenWire<Official.ToolChoiceAllowed>
  | OpenWire<Official.ToolChoiceTypes>
  | OpenWire<Official.ToolChoiceFunction>
  | OpenWire<Official.ToolChoiceMcp>
  | OpenWire<Official.ToolChoiceCustom>
  | OpenWire<Official.ResponseCreateParams.SpecificProgrammaticToolCallingParam>
  | OpenWire<Official.ToolChoiceApplyPatch>
  | OpenWire<Official.ToolChoiceShell>
  | OpenAIResponsesHostedToolChoice;

// ── Response types ──

export type OpenAIResponsesResult = Official.Response & { presence_penalty?: number; frequency_penalty?: number };
export interface OpenAIResponsesErrorPayload { type: string; code: string | null; message: string; param: string | null; headers?: Record<string, string> }

export interface OpenAIResponsesErrorEx extends Omit<Official.ResponseError, 'code'> {
  code: string;
  // CLIProxyAPI includes this classification on synthetic failed resources.
  // https://github.com/router-for-me/CLIProxyAPI/blob/0f96f568e4dbf6f84ad7399a74b78344c5eac7e6/internal/translator/common/apply_patch_events.go#L53-L60
  type?: string;
  // LiteLLM-inspired namespace for Floway diagnostics in error events and failed resources.
  // https://github.com/BerriAI/litellm/blob/cad87a900fbe8b99eba258e6ebb23f58225a8002/litellm/proxy/common_request_processing.py#L943-L975
  provider_specific_fields?: Record<string, unknown>;
}

// Sparse native responses and translator snapshots precede complete client resources.
export interface OpenAIResponsesResultEx extends Omit<Partial<OpenAIResponsesResult>, 'id' | 'object' | 'model' | 'output' | 'status' | 'incomplete_details' | 'error' | 'service_tier' | 'tools' | 'tool_choice' | 'usage' | 'created_at' | 'completed_at' | 'previous_response_id' | 'instructions' | 'truncation' | 'parallel_tool_calls' | 'text' | 'top_p' | 'presence_penalty' | 'frequency_penalty' | 'top_logprobs' | 'temperature' | 'reasoning' | 'max_output_tokens' | 'max_tool_calls' | 'store' | 'background' | 'metadata' | 'safety_identifier' | 'prompt_cache_key'> {
  id: string;
  object: string;
  model: string;
  output: OpenAIResponsesOutputItemEx[];
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L6866-L6870
  status: 'queued' | 'completed' | 'incomplete' | 'failed' | 'in_progress' | 'cancelled';
  // ResponseResource requires error and incomplete_details; both permit null.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2520-L2555
  incomplete_details: { reason?: string } | null;
  error: OpenAIResponsesErrorEx | null;
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
  instructions?: string | CanonicalOpenAIResponsesInputItem[] | null;
  truncation?: 'auto' | 'disabled' | (string & {}) | null;
  parallel_tool_calls?: boolean;
  text?: { format?: Official.ResponseFormatTextConfig | null; verbosity?: string | null } | null;
  top_p?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  top_logprobs?: number | null;
  temperature?: number | null;
  reasoning?: OpenAIResponsesPayloadEx['reasoning'];
  max_output_tokens?: number | null;
  max_tool_calls?: number | null;
  // Whether the response was stored so it can be retrieved later — the wording
  // of the schema's own description, which is why the gateway answers it from
  // its store rather than from the request's `store` flag.
  store?: boolean;
  background?: boolean;
  metadata?: Record<string, string> | null;
  safety_identifier?: string | null;
  prompt_cache_key?: string | null;
}

// Stored/output additional-tools roles are wider than the input-only
// `developer` role.
export type OpenAIResponsesOutputAdditionalToolsItem = Omit<OpenWire<Official.ResponseOutputItem.AdditionalTools>, 'tools'> & {
  tools: OpenAIResponsesTool[];
};

export type OpenAIResponsesOutputAgentMessageItem = OpenWire<OfficialBeta.BetaResponseOutputItem.AgentMessage> & CodexInternalChatMessageMetadata;
export type OpenAIResponsesOutputMultiAgentCallItem = OpenWire<OfficialBeta.BetaResponseOutputItem.MultiAgentCall>;
export type OpenAIResponsesOutputMultiAgentCallOutputItem = OpenWire<OfficialBeta.BetaResponseOutputItem.MultiAgentCallOutput>;

export type OpenAIResponsesOutputItemEx =
  | OpenAIResponsesOutputMessageEx
  | OpenAIResponsesOutputFunctionCallEx
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

export type OpenAIResponsesOutputText = Omit<OpenWire<Official.ResponseOutputText>, 'logprobs'> & {
  logprobs?: OpenAIResponsesOutputLogprobEx[];
};

export type OpenAIResponsesOutputRefusal = OpenWire<Official.ResponseOutputRefusal>;

export type OpenAIResponsesOutputContentBlock = OpenAIResponsesOutputText | OpenAIResponsesOutputRefusal;

export type OpenAIResponsesAnnotation = OpenAIResponsesOutputText['annotations'][number];

// The item schema requires `id` on every output message, so producers must
// preserve the upstream value rather than synthesize a replacement.
export type OpenAIResponsesOutputMessageEx = Omit<OpenWire<Official.ResponseOutputMessage>, 'content'> & {
  content: OpenAIResponsesOutputContentBlock[];
};

export type OpenAIResponsesOutputFunctionCallEx = OpenAIResponsesFunctionCall & {
  status: NonNullable<OpenAIResponsesFunctionCall['status']>;
};

export type OpenAIResponsesOutputCustomToolCall = OpenAIResponsesCustomToolCallItem;

export type OpenAIResponsesOutputReasoning = OpenWire<Official.ResponseReasoningItem> & CodexInternalChatMessageMetadata;

export type OpenAIResponsesOutputImageGenerationCall = OpenWire<Official.ResponseOutputItem.ImageGenerationCall> & CodexInternalChatMessageMetadata;

export type OpenAIResponsesLogprob = OpenWire<Official.ResponseOutputText.Logprob>;

// SSE logprobs are a separate standard shape from ResponseOutputText.Logprob.
// https://github.com/openai/openai-node/blob/7665932e2b7965a5e0a3123fe3de4dbdb4131933/src/resources/responses/responses.ts#L8756-L8791
export interface OpenAIResponsesStreamLogprob {
  token: string;
  logprob: number;
  top_logprobs?: { token?: string; logprob?: number }[];
}

// Preserve source byte metadata during translation: ChatCompletions allows null
// bytes, while Responses SSE does not require any byte metadata. This is our
// lossless cross-protocol extension, not the standard Responses SSE contract.
// https://github.com/openai/openai-node/blob/7665932e2b7965a5e0a3123fe3de4dbdb4131933/src/resources/chat/completions/completions.ts#L2187-L2248
export interface OpenAIResponsesStreamLogprobEx extends Omit<OpenAIResponsesStreamLogprob, 'top_logprobs'> {
  bytes?: readonly number[] | null;
  top_logprobs?: readonly (NonNullable<OpenAIResponsesStreamLogprob['top_logprobs']>[number] & { bytes?: readonly number[] | null })[];
}

// Terminal snapshots retain the source metadata available on the stream; the
// output standard's required bytes and alternatives cannot be invented.
// https://github.com/openai/openai-node/blob/7665932e2b7965a5e0a3123fe3de4dbdb4131933/src/resources/responses/responses.ts#L7219-L7261
export type OpenAIResponsesOutputLogprobEx = Omit<OpenAIResponsesLogprob, 'bytes' | 'top_logprobs'>
  & Pick<OpenAIResponsesStreamLogprobEx, 'bytes' | 'top_logprobs'>;

// ── Stream event types ──

// Spec marks sequence_number required, but some Copilot upstreams omit it
// on the wire; the stream parser backfills a monotonic counter when missing.
export type OpenAIResponsesStreamEventEx = OpenAIResponsesStreamEventVariant & { sequence_number?: number };

type OpenAIResponsesStreamEventVariant =
  | { type: 'response.audio.delta' | 'response.audio.transcript.delta'; delta: string }
  | { type: 'response.audio.done' | 'response.audio.transcript.done' }
  | { type: 'response.code_interpreter_call_code.delta' | 'response.mcp_call_arguments.delta'; delta: string; item_id: string; output_index: number }
  | { type: 'response.code_interpreter_call_code.done'; code: string; item_id: string; output_index: number }
  | { type: 'response.mcp_call_arguments.done'; arguments: string; item_id: string; output_index: number }
  | { type: 'response.code_interpreter_call.in_progress' | 'response.code_interpreter_call.interpreting' | 'response.code_interpreter_call.completed' | 'response.file_search_call.in_progress' | 'response.file_search_call.searching' | 'response.file_search_call.completed' | 'response.mcp_call.in_progress' | 'response.mcp_call.completed' | 'response.mcp_call.failed' | 'response.mcp_list_tools.in_progress' | 'response.mcp_list_tools.completed' | 'response.mcp_list_tools.failed'; item_id: string; output_index: number }
  | { type: 'response.shell_call_output_content.delta'; command_index: number; delta: { stdout?: string; stderr?: string }; item_id: string; output_index: number }
  | { type: 'response.shell_call_output_content.done'; command_index: number; output: { stdout: string; stderr: string; outcome: { type: 'exit'; exit_code: number } | { type: 'timeout' } }[]; item_id: string; output_index: number }
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L6456-L6471
  | { type: 'response.queued'; response: OpenAIResponsesResultEx }
  | { type: 'response.created'; response: OpenAIResponsesResultEx }
  | { type: 'response.in_progress'; response: OpenAIResponsesResultEx }
  | {
    type: 'response.output_item.added';
    output_index: number;
    item: OpenAIResponsesOutputItemEx;
  }
  | {
    type: 'response.output_item.done';
    output_index: number;
    item: OpenAIResponsesOutputItemEx;
  }
  | {
    type: 'response.content_part.added';
    item_id: string;
    output_index: number;
    content_index: number;
    part: OpenAIResponsesOutputContentBlock | OpenAIResponsesReasoningText;
  }
  | {
    type: 'response.content_part.done';
    item_id: string;
    output_index: number;
    content_index: number;
    part: OpenAIResponsesOutputContentBlock | OpenAIResponsesReasoningText;
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
    status?: string;
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
  // Open Responses spells incremental reasoning differently from OpenAI.
  // https://github.com/openresponses/openresponses/blob/7078a8f1aecd3d1cd41c9891e21c307fcda7f4af/schema/events.tsp#L271-L315
  | {
    type: 'response.reasoning.delta';
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
    obfuscation?: string;
  }
  | {
    type: 'response.reasoning.done';
    item_id: string;
    output_index: number;
    content_index: number;
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
  // Both text events carry the token log probabilities of their span.
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L6966-L6995
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L7044-L7075
  | {
    type: 'response.output_text.delta';
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
    logprobs?: OpenAIResponsesStreamLogprobEx[];
  }
  | {
    type: 'response.output_text.done';
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;
    logprobs?: OpenAIResponsesStreamLogprobEx[];
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
    annotation: OpenAIResponsesAnnotation | null;
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
  // The done event names the function that was called.
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L3062-L3089
  | {
    type: 'response.function_call_arguments.done';
    item_id: string;
    output_index: number;
    arguments: string;
    name?: string;
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
  // Native compaction progress carries no summary; the final encrypted item
  // arrives in output_item.done.
  // https://github.com/openai/openai-node/blob/02f4ef94e8b3b02b43af6516c71a74c3c7a80b5d/src/resources/responses/responses.ts#L2311-L2335
  | {
    type: 'response.compaction.compacting';
    item_id: string;
    output_index: number;
  }
  // Codex Responses WebSocket interrupt discards an output item that reached
  // `response.output_item.added` without reaching `.done`.
  // https://github.com/openai/codex/blob/12de0e395d3313bc564190d983cb4f5acf0be713/codex-rs/core/tests/suite/pending_input.rs#L1157-L1164
  | {
    type: 'response.output_item.interrupted';
    response_id: string;
    item_id: string;
    output_index: number;
  }
  | { type: 'response.completed'; response: OpenAIResponsesResultEx }
  | { type: 'response.incomplete'; response: OpenAIResponsesResultEx }
  | { type: 'response.failed'; response: OpenAIResponsesResultEx }
  | {
    type: 'error';
    message: string;
    code?: string | null;
    param?: string | null;
    provider_specific_fields?: OpenAIResponsesErrorEx['provider_specific_fields'];
  }
  | { type: 'error'; error: Partial<OpenAIResponsesErrorPayload> & { message: string; provider_specific_fields?: OpenAIResponsesErrorEx['provider_specific_fields'] } };

// Either side of the OpenAI Responses reasoning round trip: input echoes a prior
// turn's reasoning back in, output emits the current turn's reasoning. Shape
// is identical aside from the type tag's role.
export type OpenAIResponsesReasoningItem = OpenAIResponsesInputReasoning | OpenAIResponsesOutputReasoning;

export { isOpenAIResponsesTerminalEvent, isOpenAIResponsesErrorEvent, openaiResponsesResultFromStreamEvent } from './terminal-event.ts';
export { isOpenAIResponsesAssistantInputItem } from './assistant-items.ts';
export { WEB_SEARCH_HOSTED_TYPE_NAMES, collectOpenAIResponsesToolEntries, collectOpenAIResponsesTools, mapOpenAIResponsesTools } from './tools.ts';

export { type CanonicalOpenAIResponsesCompactPayload, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesStoredItem, type OpenAIResponsesCompactPayloadEx, toCompactPayloadShape, isOpenAIResponsesCompactionItem } from './compact.ts';
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

export { canonicalizeOpenAIResponsesPayload, isCodexAudioReference } from './canonicalize-payload.ts';
export { toOpenAIResponsesInputItem, toOpenAIResponsesInputItems } from './history.ts';
