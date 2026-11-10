// Official SDK wire declarations.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts

import type * as Shared from './sdk-shared.ts';
import type * as ResponsesAPI from './sdk.ts';

export interface ApplyPatchTool {
  type: 'apply_patch';
  allowed_callers?: Array<'direct' | 'programmatic'> | null;
}

export type ComputerAction = ComputerAction.Click | ComputerAction.DoubleClick | ComputerAction.Drag | ComputerAction.Keypress | ComputerAction.Move | ComputerAction.Screenshot | ComputerAction.Scroll | ComputerAction.Type | ComputerAction.Wait;

export namespace ComputerAction {
  export interface Click {
    button: 'left' | 'right' | 'wheel' | 'back' | 'forward';
    type: 'click';
    x: number;
    y: number;
    keys?: Array<string> | null;
  }
  export interface DoubleClick {
    keys: Array<string> | null;
    type: 'double_click';
    x: number;
    y: number;
  }
  export interface Drag {
    path: Array<Drag.Path>;
    type: 'drag';
    keys?: Array<string> | null;
  }
  export namespace Drag {
    export interface Path {
      x: number;
      y: number;
    }
  }
  export interface Keypress {
    keys: Array<string>;
    type: 'keypress';
  }
  export interface Move {
    type: 'move';
    x: number;
    y: number;
    keys?: Array<string> | null;
  }
  export interface Screenshot {
    type: 'screenshot';
  }
  export interface Scroll {
    scroll_x: number;
    scroll_y: number;
    type: 'scroll';
    x: number;
    y: number;
    keys?: Array<string> | null;
  }
  export interface Type {
    text: string;
    type: 'type';
  }
  export interface Wait {
    type: 'wait';
  }
}

export type ComputerActionList = Array<ComputerAction>;

export interface ComputerTool {
  type: 'computer';
}

export interface ComputerUsePreviewTool {
  display_height: number;
  display_width: number;
  environment: 'windows' | 'mac' | 'linux' | 'ubuntu' | 'browser';
  type: 'computer_use_preview';
}

export interface ContainerAuto {
  type: 'container_auto';
  file_ids?: Array<string>;
  memory_limit?: '1g' | '4g' | '16g' | '64g' | null;
  network_policy?: ContainerNetworkPolicyDisabled | ContainerNetworkPolicyAllowlist;
  skills?: Array<SkillReference | InlineSkill>;
}

export interface ContainerNetworkPolicyAllowlist {
  allowed_domains: Array<string>;
  type: 'allowlist';
  domain_secrets?: Array<ContainerNetworkPolicyDomainSecret>;
}

export interface ContainerNetworkPolicyDisabled {
  type: 'disabled';
}

export interface ContainerNetworkPolicyDomainSecret {
  domain: string;
  name: string;
  value: string;
}

export interface ContainerReference {
  container_id: string;
  type: 'container_reference';
}

export interface CustomTool {
  name: string;
  type: 'custom';
  allowed_callers?: Array<'direct' | 'programmatic'> | null;
  async?: boolean;
  defer_loading?: boolean;
  description?: string;
  format?: Shared.CustomToolInputFormat;
}

export interface EasyInputMessage {
  content: string | ResponseInputMessageContentList;
  role: 'user' | 'assistant' | 'system' | 'developer';
  phase?: 'commentary' | 'final_answer' | null;
  type?: 'message';
}

export interface FileSearchTool {
  type: 'file_search';
  vector_store_ids: Array<string>;
  filters?: Shared.ComparisonFilter | Shared.CompoundFilter | null;
  max_num_results?: number;
  ranking_options?: FileSearchTool.RankingOptions;
}

export namespace FileSearchTool {
  export interface RankingOptions {
    hybrid_search?: RankingOptions.HybridSearch;
    ranker?: 'auto' | 'default-2024-11-15';
    score_threshold?: number;
  }
  export namespace RankingOptions {
    export interface HybridSearch {
      embedding_weight: number;
      text_weight: number;
    }
  }
}

export interface FunctionShellTool {
  type: 'shell';
  allowed_callers?: Array<'direct' | 'programmatic'> | null;
  environment?: ContainerAuto | LocalEnvironment | ContainerReference | null;
}

export interface FunctionTool {
  name: string;
  parameters: {
    [key: string]: unknown;
  } | null;
  strict: boolean | null;
  type: 'function';
  allowed_callers?: Array<'direct' | 'programmatic'> | null;
  async?: boolean;
  defer_loading?: boolean;
  description?: string | null;
  output_schema?: {
    [key: string]: unknown;
  } | null;
}

export type ImageDetail = 'low' | 'high' | 'auto' | 'original';

export interface InlineSkill {
  description: string;
  name: string;
  source: InlineSkillSource;
  type: 'inline';
}

export interface InlineSkillSource {
  data: string;
  media_type: 'application/zip';
  type: 'base64';
}

export interface LocalEnvironment {
  type: 'local';
  skills?: Array<LocalSkill>;
}

export interface LocalSkill {
  description: string;
  name: string;
  path: string;
}

export type McpToolCallError = McpToolCallError.McpProtocolError | McpToolCallError.McpToolExecutionError | McpToolCallError.HTTPError;

export namespace McpToolCallError {
  export interface McpProtocolError {
    code: number;
    message: string;
    type: 'mcp_protocol_error';
  }
  export interface McpToolExecutionError {
    content: unknown;
    type: 'mcp_tool_execution_error';
  }
  export interface HTTPError {
    code: number;
    message: string;
    type: 'http_error';
  }
}

export interface NamespaceTool {
  description: string;
  name: string;
  tools: Array<NamespaceTool.Function | CustomTool>;
  type: 'namespace';
}

export namespace NamespaceTool {
  export interface Function {
    name: string;
    type: 'function';
    allowed_callers?: Array<'direct' | 'programmatic'> | null;
    async?: boolean;
    defer_loading?: boolean;
    description?: string | null;
    output_schema?: {
      [key: string]: unknown;
    } | null;
    parameters?: unknown | null;
    strict?: boolean | null;
  }
}

export interface Response {
  id: string;
  access_programs: Response.AccessPrograms | null;
  created_at: number;
  error: ResponseError | null;
  incomplete_details: Response.IncompleteDetails | null;
  instructions: string | Array<ResponseInputItem> | null;
  metadata: Shared.Metadata | null;
  model: Shared.ResponsesModel;
  object: 'response';
  output: Array<ResponseOutputItem>;
  parallel_tool_calls: boolean;
  temperature: number | null;
  tool_choice: ToolChoiceOptions | ToolChoiceAllowed | ToolChoiceTypes | ToolChoiceFunction | ToolChoiceMcp | ToolChoiceCustom | Response.SpecificProgrammaticToolCallingParam | ToolChoiceApplyPatch | ToolChoiceShell;
  tools: Array<Tool>;
  top_p: number | null;
  background?: boolean | null;
  completed_at?: number | null;
  conversation?: Response.Conversation | null;
  max_output_tokens?: number | null;
  moderation?: Response.Moderation | null;
  previous_response_id?: string | null;
  prompt?: ResponsePrompt | null;
  prompt_cache_diagnostics?: Response.CacheMiss | Response.CacheHit | Response.ComparisonResponseNotFound | Response.Unavailable;
  prompt_cache_key?: string | null;
  prompt_cache_options?: Response.PromptCacheOptions;
  prompt_cache_retention?: 'in_memory' | '24h' | null;
  reasoning?: Shared.Reasoning | null;
  safety_identifier?: string | null;
  service_tier?: ServiceTier | null;
  status?: ResponseStatus;
  text?: ResponseTextConfig;
  top_logprobs?: number | null;
  truncation?: 'auto' | 'disabled' | null;
  usage?: ResponseUsage;
  user?: string;
}

export namespace Response {
  export interface AccessPrograms {
    cyber: 'standard' | 'daybreak_blue' | 'daybreak_red';
  }
  export interface IncompleteDetails {
    reason?: 'max_output_tokens' | 'max_messages' | 'content_filter' | 'steered';
  }
  export interface SpecificProgrammaticToolCallingParam {
    type: 'programmatic_tool_calling';
  }
  export interface Conversation {
    id: string;
  }
  export interface Moderation {
    input: Moderation.ModerationResult | Moderation.Error;
    output: Moderation.ModerationResult | Moderation.Error;
  }
  export namespace Moderation {
    export interface ModerationResult {
      categories: {
        [key: string]: boolean;
      };
      category_applied_input_types: {
        [key: string]: Array<'text' | 'image'>;
      };
      category_scores: {
        [key: string]: number;
      };
      flagged: boolean;
      model: string;
      type: 'moderation_result';
    }
    export interface Error {
      code: string;
      message: string;
      type: 'error';
    }
    export interface ModerationResult {
      categories: {
        [key: string]: boolean;
      };
      category_applied_input_types: {
        [key: string]: Array<'text' | 'image'>;
      };
      category_scores: {
        [key: string]: number;
      };
      flagged: boolean;
      model: string;
      type: 'moderation_result';
    }
    export interface Error {
      code: string;
      message: string;
      type: 'error';
    }
  }
  export interface CacheMiss {
    cache_missed_tokens: number;
    reason: 'model_changed' | 'prompt_cache_key_changed' | 'tools_changed' | 'text_format_changed' | 'reasoning_effort_changed' | 'verbosity_changed' | 'context_compacted' | 'input_changed' | 'service_tier_changed';
    type: 'cache_miss';
    comparison_reusable_tokens?: number;
  }
  export interface CacheHit {
    type: 'cache_hit';
  }
  export interface ComparisonResponseNotFound {
    type: 'comparison_response_not_found';
  }
  export interface Unavailable {
    type: 'unavailable';
  }
  export interface PromptCacheOptions {
    mode: 'implicit' | 'explicit';
    ttl: '30m';
    comparison_response_id?: string | null;
  }
}

export interface ResponseApplyPatchToolCall {
  id: string;
  call_id: string;
  operation: ResponseApplyPatchToolCall.CreateFile | ResponseApplyPatchToolCall.DeleteFile | ResponseApplyPatchToolCall.UpdateFile;
  status: 'in_progress' | 'completed';
  type: 'apply_patch_call';
  caller?: ResponseApplyPatchToolCall.Direct | ResponseApplyPatchToolCall.Program | null;
  created_by?: string;
}

export namespace ResponseApplyPatchToolCall {
  export interface CreateFile {
    diff: string;
    path: string;
    type: 'create_file';
  }
  export interface DeleteFile {
    path: string;
    type: 'delete_file';
  }
  export interface UpdateFile {
    diff: string;
    path: string;
    type: 'update_file';
  }
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseApplyPatchToolCallOutput {
  id: string;
  call_id: string;
  status: 'completed' | 'failed';
  type: 'apply_patch_call_output';
  caller?: ResponseApplyPatchToolCallOutput.Direct | ResponseApplyPatchToolCallOutput.Program | null;
  created_by?: string;
  output?: string | null;
}

export namespace ResponseApplyPatchToolCallOutput {
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseCodeInterpreterToolCall {
  id: string;
  code: string | null;
  container_id: string;
  outputs: Array<ResponseCodeInterpreterToolCall.Logs | ResponseCodeInterpreterToolCall.Image> | null;
  status: 'in_progress' | 'completed' | 'incomplete' | 'interpreting' | 'failed';
  type: 'code_interpreter_call';
}

export namespace ResponseCodeInterpreterToolCall {
  export interface Logs {
    logs: string;
    type: 'logs';
  }
  export interface Image {
    type: 'image';
    url: string;
  }
}

export interface ResponseCompactionItem {
  id: string;
  encrypted_content: string;
  type: 'compaction';
  created_by?: string;
}

export interface ResponseCompactionItemParam {
  encrypted_content: string;
  type: 'compaction';
  id?: string | null;
}

export interface ResponseComputerToolCall {
  id: string;
  call_id: string;
  pending_safety_checks: Array<ResponseComputerToolCall.PendingSafetyCheck>;
  status: 'in_progress' | 'completed' | 'incomplete';
  type: 'computer_call';
  action?: ResponseComputerToolCall.Click | ResponseComputerToolCall.DoubleClick | ResponseComputerToolCall.Drag | ResponseComputerToolCall.Keypress | ResponseComputerToolCall.Move | ResponseComputerToolCall.Screenshot | ResponseComputerToolCall.Scroll | ResponseComputerToolCall.Type | ResponseComputerToolCall.Wait;
  actions?: ComputerActionList;
}

export namespace ResponseComputerToolCall {
  export interface PendingSafetyCheck {
    id: string;
    code?: string | null;
    message?: string | null;
  }
  export interface Click {
    button: 'left' | 'right' | 'wheel' | 'back' | 'forward';
    type: 'click';
    x: number;
    y: number;
    keys?: Array<string> | null;
  }
  export interface DoubleClick {
    keys: Array<string> | null;
    type: 'double_click';
    x: number;
    y: number;
  }
  export interface Drag {
    path: Array<Drag.Path>;
    type: 'drag';
    keys?: Array<string> | null;
  }
  export namespace Drag {
    export interface Path {
      x: number;
      y: number;
    }
  }
  export interface Keypress {
    keys: Array<string>;
    type: 'keypress';
  }
  export interface Move {
    type: 'move';
    x: number;
    y: number;
    keys?: Array<string> | null;
  }
  export interface Screenshot {
    type: 'screenshot';
  }
  export interface Scroll {
    scroll_x: number;
    scroll_y: number;
    type: 'scroll';
    x: number;
    y: number;
    keys?: Array<string> | null;
  }
  export interface Type {
    text: string;
    type: 'type';
  }
  export interface Wait {
    type: 'wait';
  }
}

export interface ResponseComputerToolCallOutputItem {
  id: string;
  call_id: string;
  output: ResponseComputerToolCallOutputScreenshot;
  status: 'completed' | 'incomplete' | 'failed' | 'in_progress';
  type: 'computer_call_output';
  acknowledged_safety_checks?: Array<ResponseComputerToolCallOutputItem.AcknowledgedSafetyCheck>;
  created_by?: string;
}

export namespace ResponseComputerToolCallOutputItem {
  export interface AcknowledgedSafetyCheck {
    id: string;
    code?: string | null;
    message?: string | null;
  }
}

export interface ResponseComputerToolCallOutputScreenshot {
  type: 'computer_screenshot';
  file_id?: string;
  image_url?: string;
}

export interface ResponseConfigurationUpdateItemParam {
  type: 'configuration_update';
  id?: string | null;
  reasoning?: ResponseConfigurationUpdateItemParam.Reasoning;
}

export namespace ResponseConfigurationUpdateItemParam {
  export interface Reasoning {
    effort?: Shared.ReasoningEffort | null;
  }
}

export interface ResponseContainerReference {
  container_id: string;
  type: 'container_reference';
}

export namespace ResponseContentPartAddedEvent {
}

export namespace ResponseContentPartDoneEvent {
}

export interface ResponseConversationParam {
  id: string;
}

export interface ResponseCustomToolCall {
  call_id: string;
  input: string;
  name: string;
  type: 'custom_tool_call';
  id?: string;
  async?: boolean;
  caller?: ResponseCustomToolCall.Direct | ResponseCustomToolCall.Program | null;
  namespace?: string;
}

export namespace ResponseCustomToolCall {
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseCustomToolCallOutput {
  call_id: string;
  output: string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;
  type: 'custom_tool_call_output';
  id?: string;
  caller?: ResponseCustomToolCallOutput.Direct | ResponseCustomToolCallOutput.Program | null;
}

export namespace ResponseCustomToolCallOutput {
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseCustomToolCallOutputItem extends ResponseCustomToolCallOutput {
  id: string;
  status: 'in_progress' | 'completed' | 'incomplete';
  created_by?: string;
}

export interface ResponseError {
  code: 'server_error' | 'rate_limit_exceeded' | 'invalid_prompt' | 'data_residency_mismatch' | 'bio_policy' | 'misalignment_policy_violation' | 'vector_store_timeout' | 'invalid_image' | 'invalid_image_format' | 'invalid_base64_image' | 'invalid_image_url' | 'image_too_large' | 'image_too_small' | 'image_parse_error' | 'image_content_policy_violation' | 'invalid_image_mode' | 'image_file_too_large' | 'unsupported_image_media_type' | 'empty_image_file' | 'failed_to_download_image' | 'image_file_not_found';
  message: string;
  misalignment?: ResponseError.Misalignment;
}

export namespace ResponseError {
  export interface Misalignment {
    detailed_explanation?: string;
    error_type?: (string & {}) | 'potentially_unintended_data_transfer' | 'potentially_unintended_data_access' | 'potentially_unintended_destructive_activity' | 'other';
    steer?: Misalignment.Steer;
  }
  export namespace Misalignment {
    export interface Steer {
      message: string;
    }
  }
}

export interface ResponseFileSearchToolCall {
  id: string;
  queries: Array<string>;
  status: 'in_progress' | 'searching' | 'completed' | 'incomplete' | 'failed';
  type: 'file_search_call';
  results?: Array<ResponseFileSearchToolCall.Result> | null;
}

export namespace ResponseFileSearchToolCall {
  export interface Result {
    attributes?: {
      [key: string]: string | number | boolean;
    } | null;
    file_id?: string;
    filename?: string;
    score?: number;
    text?: string;
  }
}

export type ResponseFormatTextConfig = Shared.ResponseFormatText | ResponseFormatTextJSONSchemaConfig | Shared.ResponseFormatJSONObject;

export interface ResponseFormatTextJSONSchemaConfig {
  name: string;
  schema: {
    [key: string]: unknown;
  };
  type: 'json_schema';
  description?: string;
  strict?: boolean | null;
}

export type ResponseFunctionCallOutputItem = ResponseInputTextContent | ResponseInputImageContent | ResponseInputFileContent;

export type ResponseFunctionCallOutputItemList = Array<ResponseFunctionCallOutputItem>;

export interface ResponseFunctionShellCallOutputContent {
  outcome: ResponseFunctionShellCallOutputContent.Timeout | ResponseFunctionShellCallOutputContent.Exit;
  stderr: string;
  stdout: string;
}

export namespace ResponseFunctionShellCallOutputContent {
  export interface Timeout {
    type: 'timeout';
  }
  export interface Exit {
    exit_code: number;
    type: 'exit';
  }
}

export interface ResponseFunctionShellToolCall {
  id: string;
  action: ResponseFunctionShellToolCall.Action;
  call_id: string;
  environment: ResponseLocalEnvironment | ResponseContainerReference | null;
  status: 'in_progress' | 'completed' | 'incomplete';
  type: 'shell_call';
  caller?: ResponseFunctionShellToolCall.Direct | ResponseFunctionShellToolCall.Program | null;
  created_by?: string;
}

export namespace ResponseFunctionShellToolCall {
  export interface Action {
    commands: Array<string>;
    max_output_length: number | null;
    timeout_ms: number | null;
  }
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseFunctionShellToolCallOutput {
  id: string;
  call_id: string;
  max_output_length: number | null;
  output: Array<ResponseFunctionShellToolCallOutput.Output>;
  status: 'in_progress' | 'completed' | 'incomplete';
  type: 'shell_call_output';
  caller?: ResponseFunctionShellToolCallOutput.Direct | ResponseFunctionShellToolCallOutput.Program | null;
  created_by?: string;
}

export namespace ResponseFunctionShellToolCallOutput {
  export interface Output {
    outcome: Output.Timeout | Output.Exit;
    stderr: string;
    stdout: string;
    created_by?: string;
  }
  export namespace Output {
    export interface Timeout {
      type: 'timeout';
    }
    export interface Exit {
      exit_code: number;
      type: 'exit';
    }
  }
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseFunctionToolCall {
  arguments: string;
  call_id: string;
  name: string;
  type: 'function_call';
  id?: string;
  async?: boolean;
  caller?: ResponseFunctionToolCall.Direct | ResponseFunctionToolCall.Program | null;
  namespace?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
}

export namespace ResponseFunctionToolCall {
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseFunctionToolCallOutputItem {
  id: string;
  output: string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;
  status: 'in_progress' | 'completed' | 'incomplete';
  type: 'function_call_output';
  call_id?: string;
  caller?: ResponseFunctionToolCallOutputItem.Direct | ResponseFunctionToolCallOutputItem.Program | null;
  created_by?: string;
  name?: string;
  namespace?: string;
}

export namespace ResponseFunctionToolCallOutputItem {
  export interface Direct {
    type: 'direct';
  }
  export interface Program {
    caller_id: string;
    type: 'program';
  }
}

export interface ResponseFunctionWebSearch {
  id: string;
  action: ResponseFunctionWebSearch.Search | ResponseFunctionWebSearch.OpenPage | ResponseFunctionWebSearch.Find;
  status: 'in_progress' | 'searching' | 'completed' | 'failed' | 'incomplete';
  type: 'web_search_call';
}

export namespace ResponseFunctionWebSearch {
  export interface Search {
    type: 'search';
    queries?: Array<string>;
    query?: string;
    sources?: Array<Search.Source>;
  }
  export namespace Search {
    export interface Source {
      type: 'url';
      url: string;
    }
  }
  export interface OpenPage {
    type: 'open_page';
    url?: string | null;
  }
  export interface Find {
    pattern: string;
    type: 'find_in_page';
    url: string;
  }
}

export type ResponseIncludable = 'file_search_call.results' | 'web_search_call.results' | 'web_search_call.action.sources' | 'message.input_image.image_url' | 'computer_call_output.output.image_url' | 'code_interpreter_call.outputs' | 'reasoning.encrypted_content' | 'message.output_text.logprobs';

export type ResponseInput = Array<ResponseInputItem>;

export type ResponseInputContent = ResponseInputText | ResponseInputImage | ResponseInputFile;

export interface ResponseInputFile {
  type: 'input_file';
  detail?: 'auto' | 'low' | 'high';
  file_data?: string;
  file_id?: string | null;
  file_url?: string;
  filename?: string;
  prompt_cache_breakpoint?: ResponseInputFile.PromptCacheBreakpoint;
}

export namespace ResponseInputFile {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ResponseInputFileContent {
  type: 'input_file';
  detail?: 'auto' | 'low' | 'high';
  file_data?: string | null;
  file_id?: string | null;
  file_url?: string | null;
  filename?: string | null;
  prompt_cache_breakpoint?: ResponseInputFileContent.PromptCacheBreakpoint | null;
}

export namespace ResponseInputFileContent {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ResponseInputImage {
  detail: ImageDetail;
  type: 'input_image';
  file_id?: string | null;
  image_url?: string | null;
  prompt_cache_breakpoint?: ResponseInputImage.PromptCacheBreakpoint;
}

export namespace ResponseInputImage {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ResponseInputImageContent {
  type: 'input_image';
  detail?: ImageDetail | null;
  file_id?: string | null;
  image_url?: string | null;
  prompt_cache_breakpoint?: ResponseInputImageContent.PromptCacheBreakpoint | null;
}

export namespace ResponseInputImageContent {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export type ResponseInputItem = EasyInputMessage | ResponseInputItem.Message | ResponseOutputMessage | ResponseFileSearchToolCall | ResponseComputerToolCall | ResponseInputItem.ComputerCallOutput | ResponseFunctionWebSearch | ResponseFunctionToolCall | ResponseInputItem.FunctionCallOutput | ResponseInputItem.ToolSearchCall | ResponseToolSearchOutputItemParam | ResponseInputItem.AdditionalTools | ResponseConfigurationUpdateItemParam | ResponseReasoningItem | ResponseCompactionItemParam | ResponseInputItem.ImageGenerationCall | ResponseCodeInterpreterToolCall | ResponseInputItem.LocalShellCall | ResponseInputItem.LocalShellCallOutput | ResponseInputItem.ShellCall | ResponseInputItem.ShellCallOutput | ResponseInputItem.ApplyPatchCall | ResponseInputItem.ApplyPatchCallOutput | ResponseInputItem.McpListTools | ResponseInputItem.McpApprovalRequest | ResponseInputItem.McpApprovalResponse | ResponseInputItem.McpCall | ResponseCustomToolCallOutput | ResponseCustomToolCall | ResponseInputItem.CompactionTrigger | ResponseInputItem.ItemReference | ResponseInputItem.Program | ResponseInputItem.ProgramOutput;

export namespace ResponseInputItem {
  export interface Message {
    content: ResponsesAPI.ResponseInputMessageContentList;
    role: 'user' | 'system' | 'developer';
    status?: 'in_progress' | 'completed' | 'incomplete';
    type?: 'message';
  }
  export interface ComputerCallOutput {
    call_id: string;
    output: ResponsesAPI.ResponseComputerToolCallOutputScreenshot;
    type: 'computer_call_output';
    id?: string | null;
    acknowledged_safety_checks?: Array<ComputerCallOutput.AcknowledgedSafetyCheck> | null;
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
  }
  export namespace ComputerCallOutput {
    export interface AcknowledgedSafetyCheck {
      id: string;
      code?: string | null;
      message?: string | null;
    }
  }
  export interface FunctionCallOutput {
    output: string | ResponsesAPI.ResponseFunctionCallOutputItemList;
    type: 'function_call_output';
    id?: string | null;
    call_id?: string | null;
    caller?: FunctionCallOutput.Direct | FunctionCallOutput.Program | null;
    name?: string | null;
    namespace?: string | null;
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
  }
  export namespace FunctionCallOutput {
    export interface Direct {
      type: 'direct';
    }
    export interface Program {
      caller_id: string;
      type: 'program';
    }
  }
  export interface ToolSearchCall {
    arguments: unknown;
    type: 'tool_search_call';
    id?: string | null;
    call_id?: string | null;
    execution?: 'server' | 'client';
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
  }
  export interface AdditionalTools {
    role: 'developer';
    tools: Array<ResponsesAPI.Tool>;
    type: 'additional_tools';
    id?: string | null;
  }
  export interface ImageGenerationCall {
    id: string;
    result: string | null;
    status: 'in_progress' | 'completed' | 'generating' | 'failed';
    type: 'image_generation_call';
    action?: 'generate' | 'edit' | 'auto' | null;
    background?: 'transparent' | 'opaque' | 'auto' | null;
    output_format?: 'png' | 'webp' | 'jpeg' | null;
    quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto' | null;
    revised_prompt?: string | null;
    size?: (string & {}) | '1024x1024' | '1024x1536' | '1536x1024' | null;
  }
  export interface LocalShellCall {
    id: string;
    action: LocalShellCall.Action;
    call_id: string;
    status: 'in_progress' | 'completed' | 'incomplete';
    type: 'local_shell_call';
  }
  export namespace LocalShellCall {
    export interface Action {
      command: Array<string>;
      env: {
        [key: string]: string;
      };
      type: 'exec';
      timeout_ms?: number | null;
      user?: string | null;
      working_directory?: string | null;
    }
  }
  export interface LocalShellCallOutput {
    id: string;
    output: string;
    type: 'local_shell_call_output';
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
  }
  export interface ShellCall {
    action: ShellCall.Action;
    call_id: string;
    type: 'shell_call';
    id?: string | null;
    caller?: ShellCall.Direct | ShellCall.Program | null;
    environment?: ResponsesAPI.LocalEnvironment | ResponsesAPI.ContainerReference | null;
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
  }
  export namespace ShellCall {
    export interface Action {
      commands: Array<string>;
      max_output_length?: number | null;
      timeout_ms?: number | null;
    }
    export interface Direct {
      type: 'direct';
    }
    export interface Program {
      caller_id: string;
      type: 'program';
    }
  }
  export interface ShellCallOutput {
    call_id: string;
    output: Array<ResponsesAPI.ResponseFunctionShellCallOutputContent>;
    type: 'shell_call_output';
    id?: string | null;
    caller?: ShellCallOutput.Direct | ShellCallOutput.Program | null;
    max_output_length?: number | null;
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
  }
  export namespace ShellCallOutput {
    export interface Direct {
      type: 'direct';
    }
    export interface Program {
      caller_id: string;
      type: 'program';
    }
  }
  export interface ApplyPatchCall {
    call_id: string;
    operation: ApplyPatchCall.CreateFile | ApplyPatchCall.DeleteFile | ApplyPatchCall.UpdateFile;
    status: 'in_progress' | 'completed';
    type: 'apply_patch_call';
    id?: string | null;
    caller?: ApplyPatchCall.Direct | ApplyPatchCall.Program | null;
  }
  export namespace ApplyPatchCall {
    export interface CreateFile {
      diff: string;
      path: string;
      type: 'create_file';
    }
    export interface DeleteFile {
      path: string;
      type: 'delete_file';
    }
    export interface UpdateFile {
      diff: string;
      path: string;
      type: 'update_file';
    }
    export interface Direct {
      type: 'direct';
    }
    export interface Program {
      caller_id: string;
      type: 'program';
    }
  }
  export interface ApplyPatchCallOutput {
    call_id: string;
    status: 'completed' | 'failed';
    type: 'apply_patch_call_output';
    id?: string | null;
    caller?: ApplyPatchCallOutput.Direct | ApplyPatchCallOutput.Program | null;
    output?: string | null;
  }
  export namespace ApplyPatchCallOutput {
    export interface Direct {
      type: 'direct';
    }
    export interface Program {
      caller_id: string;
      type: 'program';
    }
  }
  export interface McpListTools {
    id: string;
    server_label: string;
    tools: Array<McpListTools.Tool>;
    type: 'mcp_list_tools';
    error?: string | null;
  }
  export namespace McpListTools {
    export interface Tool {
      input_schema: unknown;
      name: string;
      annotations?: unknown | null;
      description?: string | null;
    }
  }
  export interface McpApprovalRequest {
    id: string;
    arguments: string;
    name: string;
    server_label: string;
    type: 'mcp_approval_request';
  }
  export interface McpApprovalResponse {
    approval_request_id: string;
    approve: boolean;
    type: 'mcp_approval_response';
    id?: string | null;
    reason?: string | null;
  }
  export interface McpCall {
    id: string;
    arguments: string;
    name: string;
    server_label: string;
    type: 'mcp_call';
    approval_request_id?: string | null;
    error?: ResponsesAPI.McpToolCallError | null;
    output?: string | null;
    status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
  }
  export interface CompactionTrigger {
    type: 'compaction_trigger';
  }
  export interface ItemReference {
    id: string;
    type?: 'item_reference' | null;
  }
  export interface Program {
    id: string;
    call_id: string;
    code: string;
    fingerprint: string;
    type: 'program';
  }
  export interface ProgramOutput {
    id: string;
    call_id: string;
    result: string;
    status: 'completed' | 'incomplete';
    type: 'program_output';
  }
}

export type ResponseInputMessageContentList = Array<ResponseInputContent>;

export interface ResponseInputText {
  text: string;
  type: 'input_text';
  prompt_cache_breakpoint?: ResponseInputText.PromptCacheBreakpoint;
}

export namespace ResponseInputText {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ResponseInputTextContent {
  text: string;
  type: 'input_text';
  prompt_cache_breakpoint?: ResponseInputTextContent.PromptCacheBreakpoint | null;
}

export namespace ResponseInputTextContent {
  export interface PromptCacheBreakpoint {
    mode: 'explicit';
  }
}

export interface ResponseLocalEnvironment {
  type: 'local';
}

export type ResponseOutputItem = ResponseOutputMessage | ResponseFileSearchToolCall | ResponseFunctionToolCall | ResponseFunctionToolCallOutputItem | ResponseFunctionWebSearch | ResponseComputerToolCall | ResponseComputerToolCallOutputItem | ResponseReasoningItem | ResponseOutputItem.Program | ResponseOutputItem.ProgramOutput | ResponseToolSearchCall | ResponseToolSearchOutputItem | ResponseOutputItem.AdditionalTools | ResponseCompactionItem | ResponseOutputItem.ImageGenerationCall | ResponseCodeInterpreterToolCall | ResponseOutputItem.LocalShellCall | ResponseOutputItem.LocalShellCallOutput | ResponseFunctionShellToolCall | ResponseFunctionShellToolCallOutput | ResponseApplyPatchToolCall | ResponseApplyPatchToolCallOutput | ResponseOutputItem.McpCall | ResponseOutputItem.McpListTools | ResponseOutputItem.McpApprovalRequest | ResponseOutputItem.McpApprovalResponse | ResponseCustomToolCall | ResponseCustomToolCallOutputItem;

export namespace ResponseOutputItem {
  export interface Program {
    id: string;
    call_id: string;
    code: string;
    fingerprint: string;
    type: 'program';
  }
  export interface ProgramOutput {
    id: string;
    call_id: string;
    result: string;
    status: 'completed' | 'incomplete';
    type: 'program_output';
  }
  export interface AdditionalTools {
    id: string;
    role: 'unknown' | 'user' | 'assistant' | 'system' | 'critic' | 'discriminator' | 'developer' | 'tool';
    tools: Array<ResponsesAPI.Tool>;
    type: 'additional_tools';
  }
  export interface ImageGenerationCall {
    id: string;
    result: string | null;
    status: 'in_progress' | 'completed' | 'generating' | 'failed';
    type: 'image_generation_call';
    action?: 'generate' | 'edit' | 'auto' | null;
    background?: 'transparent' | 'opaque' | 'auto' | null;
    output_format?: 'png' | 'webp' | 'jpeg' | null;
    quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto' | null;
    revised_prompt?: string | null;
    size?: (string & {}) | '1024x1024' | '1024x1536' | '1536x1024' | null;
  }
  export interface LocalShellCall {
    id: string;
    action: LocalShellCall.Action;
    call_id: string;
    status: 'in_progress' | 'completed' | 'incomplete';
    type: 'local_shell_call';
  }
  export namespace LocalShellCall {
    export interface Action {
      command: Array<string>;
      env: {
        [key: string]: string;
      };
      type: 'exec';
      timeout_ms?: number | null;
      user?: string | null;
      working_directory?: string | null;
    }
  }
  export interface LocalShellCallOutput {
    id: string;
    output: string;
    type: 'local_shell_call_output';
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
  }
  export interface McpCall {
    id: string;
    arguments: string;
    name: string;
    server_label: string;
    type: 'mcp_call';
    approval_request_id?: string | null;
    error?: ResponsesAPI.McpToolCallError | null;
    output?: string | null;
    status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
  }
  export interface McpListTools {
    id: string;
    server_label: string;
    tools: Array<McpListTools.Tool>;
    type: 'mcp_list_tools';
    error?: string | null;
  }
  export namespace McpListTools {
    export interface Tool {
      input_schema: unknown;
      name: string;
      annotations?: unknown | null;
      description?: string | null;
    }
  }
  export interface McpApprovalRequest {
    id: string;
    arguments: string;
    name: string;
    server_label: string;
    type: 'mcp_approval_request';
  }
  export interface McpApprovalResponse {
    id: string;
    approval_request_id: string;
    approve: boolean;
    type: 'mcp_approval_response';
    reason?: string | null;
  }
}

export interface ResponseOutputMessage {
  id: string;
  content: Array<ResponseOutputText | ResponseOutputRefusal>;
  role: 'assistant';
  status: 'in_progress' | 'completed' | 'incomplete';
  type: 'message';
  phase?: 'commentary' | 'final_answer' | null;
}

export interface ResponseOutputRefusal {
  refusal: string;
  type: 'refusal';
}

export interface ResponseOutputText {
  annotations: Array<ResponseOutputText.FileCitation | ResponseOutputText.URLCitation | ResponseOutputText.ContainerFileCitation | ResponseOutputText.FilePath>;
  text: string;
  type: 'output_text';
  logprobs?: Array<ResponseOutputText.Logprob>;
}

export namespace ResponseOutputText {
  export interface FileCitation {
    file_id: string;
    filename: string;
    index: number;
    type: 'file_citation';
  }
  export interface URLCitation {
    end_index: number;
    start_index: number;
    title: string;
    type: 'url_citation';
    url: string;
  }
  export interface ContainerFileCitation {
    container_id: string;
    end_index: number;
    file_id: string;
    filename: string;
    start_index: number;
    type: 'container_file_citation';
  }
  export interface FilePath {
    file_id: string;
    index: number;
    type: 'file_path';
  }
  export interface Logprob {
    token: string;
    bytes: Array<number>;
    logprob: number;
    top_logprobs: Array<Logprob.TopLogprob>;
  }
  export namespace Logprob {
    export interface TopLogprob {
      token: string;
      bytes: Array<number>;
      logprob: number;
    }
  }
}

export namespace ResponseOutputTextAnnotationAddedEvent {
}

export interface ResponsePrompt {
  id: string;
  variables?: {
    [key: string]: string | ResponseInputText | ResponseInputImage | ResponseInputFile;
  } | null;
  version?: string | null;
}

export interface ResponseReasoningItem {
  id: string;
  summary: Array<ResponseReasoningItem.Summary>;
  type: 'reasoning';
  content?: Array<ResponseReasoningItem.Content>;
  encrypted_content?: string | null;
  status?: 'in_progress' | 'completed' | 'incomplete';
}

export namespace ResponseReasoningItem {
  export interface Summary {
    text: string;
    type: 'summary_text';
  }
  export interface Content {
    text: string;
    type: 'reasoning_text';
  }
}

export namespace ResponseReasoningSummaryPartAddedEvent {
}

export namespace ResponseReasoningSummaryPartDoneEvent {
}

export namespace ResponseShellCallOutputContentDeltaEvent {
}

export namespace ResponseShellCallOutputContentDoneEvent {
  export namespace Output {
  }
}

export type ResponseStatus = 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';

export interface ResponseTextConfig {
  format?: ResponseFormatTextConfig;
  verbosity?: 'low' | 'medium' | 'high' | null;
}

export namespace ResponseTextDeltaEvent {
  export namespace Logprob {
  }
}

export namespace ResponseTextDoneEvent {
  export namespace Logprob {
  }
}

export interface ResponseToolSearchCall {
  id: string;
  arguments: unknown;
  call_id: string | null;
  execution: 'server' | 'client';
  status: 'in_progress' | 'completed' | 'incomplete';
  type: 'tool_search_call';
  created_by?: string;
}

export interface ResponseToolSearchOutputItem {
  id: string;
  call_id: string | null;
  execution: 'server' | 'client';
  status: 'in_progress' | 'completed' | 'incomplete';
  tools: Array<Tool>;
  type: 'tool_search_output';
  created_by?: string;
}

export interface ResponseToolSearchOutputItemParam {
  tools: Array<Tool>;
  type: 'tool_search_output';
  id?: string | null;
  call_id?: string | null;
  execution?: 'server' | 'client';
  status?: 'in_progress' | 'completed' | 'incomplete' | null;
}

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: ResponseUsage.InputTokensDetails;
  output_tokens: number;
  output_tokens_details: ResponseUsage.OutputTokensDetails;
  total_tokens: number;
}

export namespace ResponseUsage {
  export interface InputTokensDetails {
    cache_write_tokens: number;
    cached_tokens: number;
  }
  export interface OutputTokensDetails {
    reasoning_tokens: number;
  }
}

export type ServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' | 'ultrafast' | null;

export interface SkillReference {
  skill_id: string;
  type: 'skill_reference';
  version?: string;
}

export type Tool = FunctionTool | FileSearchTool | ComputerTool | ComputerUsePreviewTool | WebSearchTool | Tool.Mcp | Tool.CodeInterpreter | Tool.ProgrammaticToolCalling | Tool.ImageGeneration | Tool.LocalShell | FunctionShellTool | CustomTool | NamespaceTool | ToolSearchTool | WebSearchPreviewTool | ApplyPatchTool;

export namespace Tool {
  export interface Mcp {
    server_label: string;
    type: 'mcp';
    allowed_callers?: Array<'direct' | 'programmatic'> | null;
    allowed_tools?: Array<string> | Mcp.McpToolFilter | null;
    authorization?: string;
    connector_id?: 'connector_dropbox' | 'connector_gmail' | 'connector_googlecalendar' | 'connector_googledrive' | 'connector_microsoftteams' | 'connector_outlookcalendar' | 'connector_outlookemail' | 'connector_sharepoint';
    defer_loading?: boolean;
    headers?: {
      [key: string]: string;
    } | null;
    require_approval?: Mcp.McpToolApprovalFilter | 'always' | 'never' | null;
    server_description?: string;
    server_url?: string;
    tunnel_id?: string;
  }
  export namespace Mcp {
    export interface McpToolFilter {
      read_only?: boolean;
      tool_names?: Array<string>;
    }
    export interface McpToolApprovalFilter {
      always?: McpToolApprovalFilter.Always;
      never?: McpToolApprovalFilter.Never;
    }
    export namespace McpToolApprovalFilter {
      export interface Always {
        read_only?: boolean;
        tool_names?: Array<string>;
      }
      export interface Never {
        read_only?: boolean;
        tool_names?: Array<string>;
      }
    }
  }
  export interface CodeInterpreter {
    container: string | CodeInterpreter.CodeInterpreterToolAuto;
    type: 'code_interpreter';
    allowed_callers?: Array<'direct' | 'programmatic'> | null;
  }
  export namespace CodeInterpreter {
    export interface CodeInterpreterToolAuto {
      type: 'auto';
      file_ids?: Array<string>;
      memory_limit?: '1g' | '4g' | '16g' | '64g' | null;
      network_policy?: ResponsesAPI.ContainerNetworkPolicyDisabled | ResponsesAPI.ContainerNetworkPolicyAllowlist;
    }
  }
  export interface ProgrammaticToolCalling {
    type: 'programmatic_tool_calling';
  }
  export interface ImageGeneration {
    type: 'image_generation';
    action?: 'generate' | 'edit' | 'auto';
    background?: 'transparent' | 'opaque' | 'auto';
    input_fidelity?: 'high' | 'low' | null;
    input_image_mask?: ImageGeneration.InputImageMask;
    model?: (string & {}) | 'gpt-image-1' | 'gpt-image-1-mini' | 'gpt-image-2' | 'gpt-image-2-2026-04-21' | 'gpt-image-2.5-sunburst' | 'gpt-image-2.5-sunburst-2026-09-08' | 'gpt-image-2.5-flare' | 'gpt-image-2.5-flare-2026-09-08' | 'gpt-image-1.5' | 'chatgpt-image-latest';
    moderation?: 'auto' | 'low';
    output_compression?: number;
    output_format?: 'png' | 'webp' | 'jpeg';
    partial_images?: number;
    quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
    size?: (string & {}) | '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
  }
  export namespace ImageGeneration {
    export interface InputImageMask {
      file_id?: string;
      image_url?: string;
    }
  }
  export interface LocalShell {
    type: 'local_shell';
  }
}

export interface ToolChoiceAllowed {
  mode: 'auto' | 'required';
  tools: Array<{
    [key: string]: unknown;
  }>;
  type: 'allowed_tools';
}

export interface ToolChoiceApplyPatch {
  type: 'apply_patch';
}

export interface ToolChoiceCustom {
  name: string;
  type: 'custom';
}

export interface ToolChoiceFunction {
  name: string;
  type: 'function';
}

export interface ToolChoiceMcp {
  server_label: string;
  type: 'mcp';
  name?: string | null;
}

export type ToolChoiceOptions = 'none' | 'auto' | 'required';

export interface ToolChoiceShell {
  type: 'shell';
}

export interface ToolChoiceTypes {
  type: 'file_search' | 'web_search_preview' | 'computer' | 'computer_use_preview' | 'computer_use' | 'web_search_preview_2025_03_11' | 'image_generation' | 'code_interpreter' | 'mcp';
}

export interface ToolSearchTool {
  type: 'tool_search';
  description?: string | null;
  execution?: 'server' | 'client';
  parameters?: unknown | null;
}

export interface WebSearchPreviewTool {
  type: 'web_search_preview' | 'web_search_preview_2025_03_11';
  search_content_types?: Array<'text' | 'image'>;
  search_context_size?: 'low' | 'medium' | 'high';
  user_location?: WebSearchPreviewTool.UserLocation | null;
}

export namespace WebSearchPreviewTool {
  export interface UserLocation {
    type: 'approximate';
    city?: string | null;
    country?: string | null;
    region?: string | null;
    timezone?: string | null;
  }
}

export interface WebSearchTool {
  type: 'web_search' | 'web_search_2025_08_26';
  external_web_access?: boolean;
  filters?: WebSearchTool.Filters | null;
  search_context_size?: 'low' | 'medium' | 'high';
  user_location?: WebSearchTool.UserLocation | null;
}

export namespace WebSearchTool {
  export interface Filters {
    allowed_domains?: Array<string> | null;
  }
  export interface UserLocation {
    city?: string | null;
    country?: string | null;
    region?: string | null;
    timezone?: string | null;
    type?: 'approximate';
  }
}

export type ResponseCreateParams = ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming;

export interface ResponseCreateParamsBase {
  access_programs?: ResponseCreateParams.AccessPrograms;
  background?: boolean | null;
  context_management?: Array<ResponseCreateParams.ContextManagement> | null;
  conversation?: string | ResponseConversationParam | null;
  include?: Array<ResponseIncludable> | null;
  input?: string | ResponseInput;
  instructions?: string | null;
  max_output_tokens?: number | null;
  metadata?: Shared.Metadata | null;
  model?: Shared.ResponsesModel;
  moderation?: ResponseCreateParams.Moderation | null;
  parallel_tool_calls?: boolean | null;
  previous_response_id?: string | null;
  prompt?: ResponsePrompt | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: ResponseCreateParams.PromptCacheOptions;
  prompt_cache_retention?: 'in_memory' | '24h' | null;
  reasoning?: Shared.Reasoning | null;
  safety_identifier?: string | null;
  service_tier?: ServiceTier | null;
  store?: boolean | null;
  stream?: boolean | null;
  stream_options?: ResponseCreateParams.StreamOptions | null;
  temperature?: number | null;
  text?: ResponseTextConfig;
  tool_choice?: ToolChoiceOptions | ToolChoiceAllowed | ToolChoiceTypes | ToolChoiceFunction | ToolChoiceMcp | ToolChoiceCustom | ResponseCreateParams.SpecificProgrammaticToolCallingParam | ToolChoiceApplyPatch | ToolChoiceShell;
  tools?: Array<Tool>;
  top_logprobs?: number | null;
  top_p?: number | null;
  truncation?: 'auto' | 'disabled' | null;
  user?: string;
}

export namespace ResponseCreateParams {
  export interface AccessPrograms {
    cyber?: 'standard' | 'daybreak_blue' | 'daybreak_red';
  }
  export interface ContextManagement {
    type: string;
    compact_threshold?: number | null;
  }
  export interface Moderation {
    model: string;
    policy?: Moderation.Policy | null;
  }
  export namespace Moderation {
    export interface Policy {
      input?: Policy.Input | null;
      output?: Policy.Output | null;
    }
    export namespace Policy {
      export interface Input {
        mode: 'score' | 'block';
      }
      export interface Output {
        mode: 'score' | 'block';
      }
    }
  }
  export interface PromptCacheOptions {
    comparison_response_id?: string | null;
    mode?: 'implicit' | 'explicit';
    prewarm?: boolean;
    ttl?: '30m';
  }
  export interface StreamOptions {
    include_obfuscation?: boolean;
  }
  export interface SpecificProgrammaticToolCallingParam {
    type: 'programmatic_tool_calling';
  }
}

export interface ResponseCreateParamsNonStreaming extends ResponseCreateParamsBase {
  stream?: false | null;
}

export interface ResponseCreateParamsStreaming extends ResponseCreateParamsBase {
  stream: true;
}

export namespace ResponseCompactParams {
}
