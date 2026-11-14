// Official SDK wire declarations.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/beta/messages/messages.ts

import type * as MessagesAPI from './sdk-stable.ts';

export interface BetaAdvisorMessageIterationUsage {
  cache_creation: BetaCacheCreation | null;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  model: MessagesAPI.Model;
  output_tokens: number;
  type: 'advisor_message';
}

export interface BetaAdvisorRedactedResultBlock {
  encrypted_content: string;
  stop_reason: string | null;
  type: 'advisor_redacted_result';
}

export interface BetaAdvisorRedactedResultBlockParam {
  encrypted_content: string;
  type: 'advisor_redacted_result';
  stop_reason?: string | null;
}

export interface BetaAdvisorResultBlock {
  stop_reason: string | null;
  text: string;
  type: 'advisor_result';
}

export interface BetaAdvisorResultBlockParam {
  text: string;
  type: 'advisor_result';
  stop_reason?: string | null;
}

export interface BetaAdvisorTool20260301 {
  model: MessagesAPI.Model;
  name: 'advisor';
  type: 'advisor_20260301';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  caching?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  max_tokens?: number | null;
  max_uses?: number | null;
  strict?: boolean;
}

export interface BetaAdvisorToolResultBlock {
  content: BetaAdvisorToolResultError | BetaAdvisorResultBlock | BetaAdvisorRedactedResultBlock;
  tool_use_id: string;
  type: 'advisor_tool_result';
}

export interface BetaAdvisorToolResultBlockParam {
  content: BetaAdvisorToolResultErrorParam | BetaAdvisorResultBlockParam | BetaAdvisorRedactedResultBlockParam;
  tool_use_id: string;
  type: 'advisor_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaAdvisorToolResultError {
  error_code: 'max_uses_exceeded' | 'prompt_too_long' | 'too_many_requests' | 'overloaded' | 'unavailable' | 'execution_time_exceeded' | 'model_not_found';
  type: 'advisor_tool_result_error';
}

export interface BetaAdvisorToolResultErrorParam {
  error_code: 'max_uses_exceeded' | 'prompt_too_long' | 'too_many_requests' | 'overloaded' | 'unavailable' | 'execution_time_exceeded' | 'model_not_found';
  type: 'advisor_tool_result_error';
}

export interface BetaAllThinkingTurns {
  type: 'all';
}

export interface BetaBase64ImageSource {
  data: string;
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  type: 'base64';
}

export interface BetaBase64PDFSource {
  data: string;
  media_type: 'application/pdf';
  type: 'base64';
}

export interface BetaBashCodeExecutionOutputBlock {
  file_id: string;
  type: 'bash_code_execution_output';
}

export interface BetaBashCodeExecutionOutputBlockParam {
  file_id: string;
  type: 'bash_code_execution_output';
}

export interface BetaBashCodeExecutionResultBlock {
  content: Array<BetaBashCodeExecutionOutputBlock>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'bash_code_execution_result';
}

export interface BetaBashCodeExecutionResultBlockParam {
  content: Array<BetaBashCodeExecutionOutputBlockParam>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'bash_code_execution_result';
}

export interface BetaBashCodeExecutionToolResultBlock {
  content: BetaBashCodeExecutionToolResultError | BetaBashCodeExecutionResultBlock;
  tool_use_id: string;
  type: 'bash_code_execution_tool_result';
}

export interface BetaBashCodeExecutionToolResultBlockParam {
  content: BetaBashCodeExecutionToolResultErrorParam | BetaBashCodeExecutionResultBlockParam;
  tool_use_id: string;
  type: 'bash_code_execution_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaBashCodeExecutionToolResultError {
  error_code: 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded' | 'output_file_too_large';
  type: 'bash_code_execution_tool_result_error';
}

export interface BetaBashCodeExecutionToolResultErrorParam {
  error_code: 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded' | 'output_file_too_large';
  type: 'bash_code_execution_tool_result_error';
}

export interface BetaBrowserCloseTabConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserDoubleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserFileUploadConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserFindConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserFormInputConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserGetPageTextConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserHoldKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserHoverConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserJavascriptExecConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserLeftClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserLeftClickDragConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserLeftMouseDownConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserLeftMouseUpConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserListTabsConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserMiddleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserMouseMoveConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserNavigateConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserNewTabConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserReadConsoleConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserReadNetworkConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserReadPageConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserRightClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserScreenshotConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserScrollConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserScrollToConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserStateBlockParam {
  tabs: Array<BetaBrowserStateTabEntry>;
  type: 'browser_state';
  cache_control?: BetaCacheControlEphemeral | null;
  state_changes?: Array<BetaBrowserStateChange> | null;
}

export type BetaBrowserStateChange = BetaBrowserStateChangeTabOpened | BetaBrowserStateChangeDownloadStarted | BetaBrowserStateChangeDownloadCompleted | BetaBrowserStateChangeDownloadFailed;

export interface BetaBrowserStateChangeDownloadCompleted {
  download_id: string;
  type: 'download_completed';
  url: string;
  path?: string | null;
  size_bytes?: number | null;
}

export interface BetaBrowserStateChangeDownloadFailed {
  download_id: string;
  type: 'download_failed';
  url: string;
  error?: string | null;
}

export interface BetaBrowserStateChangeDownloadStarted {
  download_id: string;
  type: 'download_started';
  url: string;
}

export interface BetaBrowserStateChangeTabOpened {
  tab_id: string;
  type: 'tab_opened';
}

export interface BetaBrowserStateTabEntry {
  tab_id: string;
  title: string;
  url: string;
  active?: boolean;
}

export interface BetaBrowserSwitchTabConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserToolset20260801 {
  type: 'browser_toolset_20260801';
  cache_control?: BetaCacheControlEphemeral | null;
  configs?: BetaBrowserToolsetConfigs | null;
}

export interface BetaBrowserToolsetConfigs {
  close_tab?: BetaBrowserCloseTabConfig | null;
  double_click?: BetaBrowserDoubleClickConfig | null;
  file_upload?: BetaBrowserFileUploadConfig | null;
  find?: BetaBrowserFindConfig | null;
  form_input?: BetaBrowserFormInputConfig | null;
  get_page_text?: BetaBrowserGetPageTextConfig | null;
  hold_key?: BetaBrowserHoldKeyConfig | null;
  hover?: BetaBrowserHoverConfig | null;
  javascript_exec?: BetaBrowserJavascriptExecConfig | null;
  key?: BetaBrowserKeyConfig | null;
  left_click?: BetaBrowserLeftClickConfig | null;
  left_click_drag?: BetaBrowserLeftClickDragConfig | null;
  left_mouse_down?: BetaBrowserLeftMouseDownConfig | null;
  left_mouse_up?: BetaBrowserLeftMouseUpConfig | null;
  list_tabs?: BetaBrowserListTabsConfig | null;
  middle_click?: BetaBrowserMiddleClickConfig | null;
  mouse_move?: BetaBrowserMouseMoveConfig | null;
  navigate?: BetaBrowserNavigateConfig | null;
  new_tab?: BetaBrowserNewTabConfig | null;
  read_console?: BetaBrowserReadConsoleConfig | null;
  read_network?: BetaBrowserReadNetworkConfig | null;
  read_page?: BetaBrowserReadPageConfig | null;
  right_click?: BetaBrowserRightClickConfig | null;
  screenshot?: BetaBrowserScreenshotConfig | null;
  scroll?: BetaBrowserScrollConfig | null;
  scroll_to?: BetaBrowserScrollToConfig | null;
  switch_tab?: BetaBrowserSwitchTabConfig | null;
  triple_click?: BetaBrowserTripleClickConfig | null;
  type?: BetaBrowserTypeConfig | null;
  wait?: BetaBrowserWaitConfig | null;
  zoom?: BetaBrowserZoomConfig | null;
}

export interface BetaBrowserTripleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserTypeConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserWaitConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaBrowserZoomConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaCacheControlEphemeral {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface BetaCacheCreation {
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
}

export interface BetaCacheMissMessagesChanged {
  cache_missed_input_tokens: number;
  type: 'messages_changed';
}

export interface BetaCacheMissModelChanged {
  cache_missed_input_tokens: number;
  type: 'model_changed';
}

export interface BetaCacheMissPreviousMessageNotFound {
  type: 'previous_message_not_found';
}

export type BetaCacheMissReason = BetaCacheMissModelChanged | BetaCacheMissSystemChanged | BetaCacheMissToolsChanged | BetaCacheMissMessagesChanged | BetaCacheMissPreviousMessageNotFound | BetaCacheMissUnavailable;

export interface BetaCacheMissSystemChanged {
  cache_missed_input_tokens: number;
  type: 'system_changed';
}

export interface BetaCacheMissToolsChanged {
  cache_missed_input_tokens: number;
  type: 'tools_changed';
}

export interface BetaCacheMissUnavailable {
  type: 'unavailable';
}

export interface BetaCitationCharLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_char_index: number;
  file_id: string | null;
  start_char_index: number;
  type: 'char_location';
}

export interface BetaCitationCharLocationParam {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_char_index: number;
  start_char_index: number;
  type: 'char_location';
}

export interface BetaCitationConfig {
  enabled: boolean;
}

export interface BetaCitationContentBlockLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_block_index: number;
  file_id: string | null;
  start_block_index: number;
  type: 'content_block_location';
}

export interface BetaCitationContentBlockLocationParam {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_block_index: number;
  start_block_index: number;
  type: 'content_block_location';
}

export interface BetaCitationPageLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_page_number: number;
  file_id: string | null;
  start_page_number: number;
  type: 'page_location';
}

export interface BetaCitationPageLocationParam {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_page_number: number;
  start_page_number: number;
  type: 'page_location';
}

export interface BetaCitationSearchResultLocation {
  cited_text: string;
  end_block_index: number;
  search_result_index: number;
  source: string;
  start_block_index: number;
  title: string | null;
  type: 'search_result_location';
}

export interface BetaCitationSearchResultLocationParam {
  cited_text: string;
  end_block_index: number;
  search_result_index: number;
  source: string;
  start_block_index: number;
  title: string | null;
  type: 'search_result_location';
}

export interface BetaCitationWebSearchResultLocationParam {
  cited_text: string;
  encrypted_index: string;
  title: string | null;
  type: 'web_search_result_location';
  url: string;
}

export interface BetaCitationsConfigParam {
  enabled?: boolean;
}

export interface BetaCitationsWebSearchResultLocation {
  cited_text: string;
  encrypted_index: string;
  title: string | null;
  type: 'web_search_result_location';
  url: string;
}

export interface BetaClearThinking20251015Edit {
  type: 'clear_thinking_20251015';
  keep?: BetaThinkingTurns | BetaAllThinkingTurns | 'all';
}

export interface BetaClearThinking20251015EditResponse {
  cleared_input_tokens: number;
  cleared_thinking_turns: number;
  type: 'clear_thinking_20251015';
}

export interface BetaClearToolUses20250919Edit {
  type: 'clear_tool_uses_20250919';
  clear_at_least?: BetaInputTokensClearAtLeast | null;
  clear_tool_inputs?: boolean | Array<string> | null;
  exclude_tools?: Array<string> | null;
  keep?: BetaToolUsesKeep;
  trigger?: BetaInputTokensTrigger | BetaToolUsesTrigger;
}

export interface BetaClearToolUses20250919EditResponse {
  cleared_input_tokens: number;
  cleared_tool_uses: number;
  type: 'clear_tool_uses_20250919';
}

export interface BetaCodeExecutionOutputBlock {
  file_id: string;
  type: 'code_execution_output';
}

export interface BetaCodeExecutionOutputBlockParam {
  file_id: string;
  type: 'code_execution_output';
}

export interface BetaCodeExecutionResultBlock {
  content: Array<BetaCodeExecutionOutputBlock>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'code_execution_result';
}

export interface BetaCodeExecutionResultBlockParam {
  content: Array<BetaCodeExecutionOutputBlockParam>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'code_execution_result';
}

export interface BetaCodeExecutionTool20250522 {
  name: 'code_execution';
  type: 'code_execution_20250522';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface BetaCodeExecutionTool20250825 {
  name: 'code_execution';
  type: 'code_execution_20250825';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface BetaCodeExecutionTool20260120 {
  name: 'code_execution';
  type: 'code_execution_20260120';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface BetaCodeExecutionTool20260521 {
  name: 'code_execution';
  type: 'code_execution_20260521';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface BetaCodeExecutionToolResultBlock {
  content: BetaCodeExecutionToolResultBlockContent;
  tool_use_id: string;
  type: 'code_execution_tool_result';
}

export type BetaCodeExecutionToolResultBlockContent = BetaCodeExecutionToolResultError | BetaCodeExecutionResultBlock | BetaEncryptedCodeExecutionResultBlock;

export interface BetaCodeExecutionToolResultBlockParam {
  content: BetaCodeExecutionToolResultBlockParamContent;
  tool_use_id: string;
  type: 'code_execution_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
}

export type BetaCodeExecutionToolResultBlockParamContent = BetaCodeExecutionToolResultErrorParam | BetaCodeExecutionResultBlockParam | BetaEncryptedCodeExecutionResultBlockParam;

export interface BetaCodeExecutionToolResultError {
  error_code: BetaCodeExecutionToolResultErrorCode;
  type: 'code_execution_tool_result_error';
}

export type BetaCodeExecutionToolResultErrorCode = 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded';

export interface BetaCodeExecutionToolResultErrorParam {
  error_code: BetaCodeExecutionToolResultErrorCode;
  type: 'code_execution_tool_result_error';
}

export interface BetaCompact20260112Edit {
  type: 'compact_20260112';
  instructions?: string | null;
  pause_after_compaction?: boolean;
  trigger?: BetaInputTokensTrigger | null;
}

export interface BetaCompactionBlock {
  content: string | null;
  encrypted_content: string | null;
  type: 'compaction';
  signature?: string | null;
  tool_changes?: Array<BetaResponseToolAdditionBlock | BetaResponseToolRemovalBlock> | null;
}

export interface BetaCompactionBlockParam {
  type: 'compaction';
  cache_control?: BetaCacheControlEphemeral | null;
  content?: string | null;
  encrypted_content?: string | null;
  signature?: string | null;
  tool_changes?: Array<BetaRequestToolAdditionBlock | BetaRequestToolRemovalBlock> | null;
}

export interface BetaCompactionConfig {
  type: 'summarize';
  instructions?: string | null;
}

export interface BetaCompactionIterationUsage {
  cache_creation: BetaCacheCreation | null;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  type: 'compaction';
}

export interface BetaComputerCursorPositionConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerDoubleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerHoldKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerLeftClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerLeftClickDragConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerLeftMouseDownConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerLeftMouseUpConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerMiddleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerMouseMoveConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerRightClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerScreenshotConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerScrollConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerToolset20260801 {
  type: 'computer_toolset_20260801';
  cache_control?: BetaCacheControlEphemeral | null;
  configs?: BetaComputerToolsetConfigs | null;
}

export interface BetaComputerToolsetConfigs {
  cursor_position?: BetaComputerCursorPositionConfig | null;
  double_click?: BetaComputerDoubleClickConfig | null;
  hold_key?: BetaComputerHoldKeyConfig | null;
  key?: BetaComputerKeyConfig | null;
  left_click?: BetaComputerLeftClickConfig | null;
  left_click_drag?: BetaComputerLeftClickDragConfig | null;
  left_mouse_down?: BetaComputerLeftMouseDownConfig | null;
  left_mouse_up?: BetaComputerLeftMouseUpConfig | null;
  middle_click?: BetaComputerMiddleClickConfig | null;
  mouse_move?: BetaComputerMouseMoveConfig | null;
  right_click?: BetaComputerRightClickConfig | null;
  screenshot?: BetaComputerScreenshotConfig | null;
  scroll?: BetaComputerScrollConfig | null;
  triple_click?: BetaComputerTripleClickConfig | null;
  type?: BetaComputerTypeConfig | null;
  wait?: BetaComputerWaitConfig | null;
  zoom?: BetaComputerZoomConfig | null;
}

export interface BetaComputerTripleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerTypeConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerWaitConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaComputerZoomConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BetaContainer {
  id: string;
  expires_at: string;
  skills: Array<BetaContainerSkill> | null;
}

export interface BetaContainerParams {
  id?: string | null;
  skills?: Array<BetaSkillParams> | null;
}

export interface BetaContainerSkill {
  skill_id: string;
  type: 'anthropic' | 'custom';
  version: string;
}

export interface BetaContainerUploadBlock {
  file_id: string;
  type: 'container_upload';
}

export interface BetaContainerUploadBlockParam {
  file_id: string;
  type: 'container_upload';
  cache_control?: BetaCacheControlEphemeral | null;
}

export type BetaContentBlock = BetaTextBlock | BetaThinkingBlock | BetaRedactedThinkingBlock | BetaToolUseBlock | BetaServerToolUseBlock | BetaWebSearchToolResultBlock | BetaWebFetchToolResultBlock | BetaAdvisorToolResultBlock | BetaCodeExecutionToolResultBlock | BetaBashCodeExecutionToolResultBlock | BetaTextEditorCodeExecutionToolResultBlock | BetaToolSearchToolResultBlock | BetaMCPToolUseBlock | BetaMCPToolResultBlock | BetaContainerUploadBlock | BetaCompactionBlock | BetaFallbackBlock | BetaMCPToolListingBlock;

export type BetaContentBlockParam = BetaTextBlockParam | BetaImageBlockParam | BetaRequestDocumentBlock | BetaSearchResultBlockParam | BetaThinkingBlockParam | BetaRedactedThinkingBlockParam | BetaToolUseBlockParam | BetaToolResultBlockParam | BetaServerToolUseBlockParam | BetaWebSearchToolResultBlockParam | BetaWebFetchToolResultBlockParam | BetaAdvisorToolResultBlockParam | BetaCodeExecutionToolResultBlockParam | BetaBashCodeExecutionToolResultBlockParam | BetaTextEditorCodeExecutionToolResultBlockParam | BetaToolSearchToolResultBlockParam | BetaMCPToolUseBlockParam | BetaRequestMCPToolResultBlockParam | BetaContainerUploadBlockParam | BetaCompactionBlockParam | BetaRequestToolAdditionBlock | BetaRequestToolRemovalBlock | BetaMCPToolListingBlockParam | BetaFallbackBlockParam;

export interface BetaContentBlockSource {
  content: string | Array<BetaContentBlockSourceContent>;
  type: 'content';
}

export type BetaContentBlockSourceContent = BetaTextBlockParam | BetaImageBlockParam;

export interface BetaContextManagementConfig {
  edits?: Array<BetaClearToolUses20250919Edit | BetaClearThinking20251015Edit | BetaCompact20260112Edit>;
}

export interface BetaContextManagementResponse {
  applied_edits: Array<BetaClearToolUses20250919EditResponse | BetaClearThinking20251015EditResponse>;
}

export interface BetaDiagnostics {
  cache_miss_reason: BetaCacheMissReason | null;
}

export interface BetaDiagnosticsParam {
  previous_message_id?: string | null;
}

export interface BetaDirectCaller {
  type: 'direct';
}

export interface BetaDocumentBlock {
  citations: BetaCitationConfig | null;
  source: BetaBase64PDFSource | BetaPlainTextSource;
  title: string | null;
  type: 'document';
}

export interface BetaEncryptedCodeExecutionResultBlock {
  content: Array<BetaCodeExecutionOutputBlock>;
  encrypted_stdout: string;
  return_code: number;
  stderr: string;
  type: 'encrypted_code_execution_result';
}

export interface BetaEncryptedCodeExecutionResultBlockParam {
  content: Array<BetaCodeExecutionOutputBlockParam>;
  encrypted_stdout: string;
  return_code: number;
  stderr: string;
  type: 'encrypted_code_execution_result';
}

export interface BetaFallbackBlock {
  from: BetaFallbackInfo;
  to: BetaFallbackInfo;
  trigger: BetaFallbackRefusalTrigger;
  type: 'fallback';
}

export interface BetaFallbackBlockParam {
  from: BetaFallbackInfoParam;
  to: BetaFallbackInfoParam;
  type: 'fallback';
  trigger?: unknown;
}

export interface BetaFallbackCreditNotApplied {
  reason: 'body_mismatch' | 'continuation_excluded' | 'continuation_only' | 'expired' | 'invalid_target_model' | 'not_enabled' | 'reprice_unavailable' | 'temporarily_unavailable' | 'variant_fields_present' | 'wrong_organization' | 'wrong_platform' | 'wrong_workspace';
  type: 'not_applied';
  remove_to_redeem?: Array<string> | null;
}

export interface BetaFallbackCreditRedeemed {
  type: 'redeemed';
}

export interface BetaFallbackCreditTokenParam {
  token: string;
  mode?: 'strict' | 'best_effort';
}

export interface BetaFallbackCreditUsage {
  status: BetaFallbackCreditRedeemed | BetaFallbackCreditNotApplied;
}

export interface BetaFallbackInfo {
  model: MessagesAPI.Model;
}

export interface BetaFallbackInfoParam {
  model: MessagesAPI.Model;
}

export interface BetaFallbackMessageIterationUsage {
  cache_creation: BetaCacheCreation | null;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  model: MessagesAPI.Model;
  output_tokens: number;
  type: 'fallback_message';
}

export interface BetaFallbackParam {
  model: MessagesAPI.Model;
  max_tokens?: number | null;
  output_config?: BetaOutputConfig | null;
  speed?: 'standard' | 'fast' | null;
  thinking?: BetaThinkingConfigEnabled | BetaThinkingConfigDisabled | BetaThinkingConfigBetweenTools | BetaThinkingConfigAdaptive | null;
  [k: string]: unknown;
}

export interface BetaFallbackRefusalTrigger {
  category: 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null;
  type: 'refusal';
}

export type BetaFallbacksParam = Array<BetaFallbackParam> | 'default';

export interface BetaFileDocumentSource {
  file_id: string;
  type: 'file';
}

export interface BetaFileImageSource {
  file_id: string;
  type: 'file';
}

export interface BetaImageBlockParam {
  source: BetaBase64ImageSource | BetaURLImageSource | BetaFileImageSource;
  type: 'image';
  cache_control?: BetaCacheControlEphemeral | null;
  transformations?: BetaImageTransformationsParam | null;
}

export interface BetaImageTransformationsParam {
  oversized_image?: 'downsize' | 'error';
}

export interface BetaInputTokensClearAtLeast {
  type: 'input_tokens';
  value: number;
}

export interface BetaInputTokensTrigger {
  type: 'input_tokens';
  value: number;
}

export type BetaInputTransformation = BetaThinkingDroppedInputTransformation | BetaThinkingMismatchAllowedInputTransformation;

export type BetaIterationsUsage = Array<BetaMessageIterationUsage | BetaCompactionIterationUsage | BetaAdvisorMessageIterationUsage | BetaFallbackMessageIterationUsage>;

export interface BetaJSONOutputFormat {
  schema: {
    [key: string]: unknown;
  };
  type: 'json_schema';
}

export interface BetaMCPTool {
  input_schema: {
    [key: string]: unknown;
  };
  name: string;
  description?: string;
}

export interface BetaMCPToolConfig {
  defer_loading?: boolean;
  enabled?: boolean;
}

export interface BetaMCPToolDefaultConfig {
  defer_loading?: boolean;
  enabled?: boolean;
}

export interface BetaMCPToolListingBlock {
  mcp_server_name: string;
  tools: Array<BetaMCPTool>;
  type: 'mcp_tool_listing';
}

export interface BetaMCPToolListingBlockParam {
  mcp_server_name: string;
  tools: Array<BetaMCPToolParam>;
  type: 'mcp_tool_listing';
}

export interface BetaMCPToolParam {
  input_schema: {
    [key: string]: unknown;
  };
  name: string;
  description?: string | null;
}

export interface BetaMCPToolResultBlock {
  content: string | Array<BetaTextBlock>;
  is_error: boolean;
  tool_use_id: string;
  type: 'mcp_tool_result';
}

export interface BetaMCPToolUseBlock {
  id: string;
  input: unknown;
  name: string;
  server_name: string;
  type: 'mcp_tool_use';
}

export interface BetaMCPToolUseBlockParam {
  id: string;
  input: unknown;
  name: string;
  server_name: string;
  type: 'mcp_tool_use';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaMCPToolset {
  mcp_server_name: string;
  type: 'mcp_toolset';
  cache_control?: BetaCacheControlEphemeral | null;
  configs?: {
    [key: string]: BetaMCPToolConfig;
  } | null;
  default_config?: BetaMCPToolDefaultConfig;
  tools?: Array<BetaMCPToolParam> | null;
}

export interface BetaMemoryTool20250818 {
  name: 'memory';
  type: 'memory_20250818';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaMessage {
  id: string;
  container: BetaContainer | null;
  content: Array<BetaContentBlock>;
  context_management: BetaContextManagementResponse | null;
  diagnostics: BetaDiagnostics | null;
  model: MessagesAPI.Model;
  role: 'assistant';
  stop_details: BetaRefusalStopDetails | null;
  stop_reason: BetaStopReason | null;
  stop_sequence: string | null;
  type: 'message';
  usage: BetaUsage;
  input_transformations?: Array<BetaInputTransformation> | null;
}

export interface BetaMessageIterationUsage {
  cache_creation: BetaCacheCreation | null;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  model: MessagesAPI.Model | null;
  output_tokens: number;
  type: 'message';
}

export interface BetaMessageParam {
  content: string | Array<BetaContentBlockParam>;
  role: 'user' | 'assistant' | 'system';
  clear_at?: 'next_user_message' | 'never' | null;
  output_config?: BetaSystemMessageOutputConfig | null;
}

export interface BetaMetadata {
  user_id?: string | null;
}

export interface BetaOutputConfig {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  format?: BetaJSONOutputFormat | null;
  task_budget?: BetaTokenTaskBudget | null;
}

export interface BetaOutputTokensDetails {
  thinking_tokens: number;
}

export interface BetaPlainTextSource {
  data: string;
  media_type: 'text/plain';
  type: 'text';
}

export namespace BetaRawMessageDeltaEvent {
}

export interface BetaRedactedThinkingBlock {
  data: string;
  type: 'redacted_thinking';
}

export interface BetaRedactedThinkingBlockParam {
  data: string;
  type: 'redacted_thinking';
}

export interface BetaRefusalStopDetails {
  category: 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null;
  explanation: string | null;
  fallback_credit_token: string | null;
  fallback_has_prefill_claim: boolean | null;
  recommended_model: string | null;
  type: 'refusal';
}

export interface BetaRequestDocumentBlock {
  source: BetaBase64PDFSource | BetaPlainTextSource | BetaContentBlockSource | BetaURLPDFSource | BetaFileDocumentSource;
  type: 'document';
  cache_control?: BetaCacheControlEphemeral | null;
  citations?: BetaCitationsConfigParam | null;
  context?: string | null;
  title?: string | null;
}

export interface BetaRequestMCPServerToolConfiguration {
  allowed_tools?: Array<string> | null;
  enabled?: boolean | null;
}

export interface BetaRequestMCPServerURLDefinition {
  name: string;
  type: 'url';
  url: string;
  authorization_token?: string | null;
  tool_configuration?: BetaRequestMCPServerToolConfiguration | null;
}

export interface BetaRequestMCPToolResultBlockParam {
  tool_use_id: string;
  type: 'mcp_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
  content?: string | Array<BetaTextBlockParam>;
  is_error?: boolean;
}

export interface BetaRequestToolAdditionBlock {
  tool: BetaToolChangeToolReference | BetaToolChangeMCPToolReference | BetaToolChangeMCPToolsetReference | BetaToolChangeToolDefinitionParam;
  type: 'tool_addition';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaRequestToolRemovalBlock {
  tool: BetaToolChangeToolReference | BetaToolChangeMCPToolReference | BetaToolChangeMCPToolsetReference;
  type: 'tool_removal';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaResponseTool {
  input_schema: BetaResponseToolInputSchema;
  name: string;
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  defer_loading?: boolean;
  description?: string;
  eager_input_streaming?: boolean | null;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
  type?: 'custom' | null;
}

export interface BetaResponseToolAdditionBlock {
  tool: BetaResponseToolChangeToolReference | BetaResponseToolChangeMCPToolReference | BetaResponseToolChangeMCPToolsetReference | BetaToolChangeToolDefinition;
  type: 'tool_addition';
}

export interface BetaResponseToolChangeMCPToolReference {
  name: string;
  server_name: string;
  type: 'mcp_tool_reference';
}

export interface BetaResponseToolChangeMCPToolsetReference {
  server_name: string;
  type: 'mcp_toolset_reference';
}

export interface BetaResponseToolChangeToolReference {
  name: string;
  type: 'tool_reference';
}

export interface BetaResponseToolInputSchema {
  type: 'object';
  properties?: {
    [key: string]: unknown;
  } | null;
  required?: Array<string> | null;
  [k: string]: unknown;
}

export interface BetaResponseToolRemovalBlock {
  tool: BetaResponseToolChangeToolReference | BetaResponseToolChangeMCPToolReference | BetaResponseToolChangeMCPToolsetReference;
  type: 'tool_removal';
}

export type BetaResponseToolUnion = BetaResponseTool | BetaToolBash20241022 | BetaToolBash20250124 | BetaCodeExecutionTool20250522 | BetaCodeExecutionTool20250825 | BetaCodeExecutionTool20260120 | BetaCodeExecutionTool20260521 | BetaBrowserToolset20260801 | BetaToolComputerUse20241022 | BetaMemoryTool20250818 | BetaToolComputerUse20250124 | BetaToolTextEditor20241022 | BetaToolComputerUse20251124 | BetaComputerToolset20260801 | BetaToolTextEditor20250124 | BetaToolTextEditor20250429 | BetaToolTextEditor20250728 | BetaWebSearchTool20250305 | BetaWebFetchTool20250910 | BetaWebSearchTool20260209 | BetaWebFetchTool20260209 | BetaWebFetchTool20260309 | BetaWebSearchTool20260318 | BetaWebFetchTool20260318 | BetaAdvisorTool20260301 | BetaToolSearchToolBm25_20251119 | BetaToolSearchToolRegex20251119 | BetaMCPToolset;

export interface BetaSearchResultBlockParam {
  content: Array<BetaTextBlockParam>;
  source: string;
  title: string;
  type: 'search_result';
  cache_control?: BetaCacheControlEphemeral | null;
  citations?: BetaCitationsConfigParam;
}

export interface BetaServerToolCaller {
  tool_id: string;
  type: 'code_execution_20250825';
}

export interface BetaServerToolCaller20260120 {
  tool_id: string;
  type: 'code_execution_20260120';
}

export interface BetaServerToolUsage {
  web_fetch_requests: number;
  web_search_requests: number;
}

export interface BetaServerToolUseBlock {
  id: string;
  input: {
    [key: string]: unknown;
  };
  name: 'advisor' | 'web_search' | 'web_fetch' | 'code_execution' | 'bash_code_execution' | 'text_editor_code_execution' | 'tool_search_tool_regex' | 'tool_search_tool_bm25';
  type: 'server_tool_use';
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
}

export interface BetaServerToolUseBlockParam {
  id: string;
  input: unknown;
  name: 'advisor' | 'web_search' | 'web_fetch' | 'code_execution' | 'bash_code_execution' | 'text_editor_code_execution' | 'tool_search_tool_regex' | 'tool_search_tool_bm25';
  type: 'server_tool_use';
  cache_control?: BetaCacheControlEphemeral | null;
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
}

export interface BetaSkillParams {
  skill_id: string;
  type: 'anthropic' | 'custom';
  version?: string;
}

export type BetaStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'compaction' | 'refusal' | 'model_context_window_exceeded';

export interface BetaSystemMessageOutputConfig {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
}

export interface BetaTextBlock {
  citations: Array<BetaTextCitation> | null;
  text: string;
  type: 'text';
}

export interface BetaTextBlockParam {
  text: string;
  type: 'text';
  cache_control?: BetaCacheControlEphemeral | null;
  citations?: Array<BetaTextCitationParam> | null;
}

export type BetaTextCitation = BetaCitationCharLocation | BetaCitationPageLocation | BetaCitationContentBlockLocation | BetaCitationsWebSearchResultLocation | BetaCitationSearchResultLocation;

export type BetaTextCitationParam = BetaCitationCharLocationParam | BetaCitationPageLocationParam | BetaCitationContentBlockLocationParam | BetaCitationWebSearchResultLocationParam | BetaCitationSearchResultLocationParam;

export interface BetaTextEditorCodeExecutionCreateResultBlock {
  is_file_update: boolean;
  type: 'text_editor_code_execution_create_result';
}

export interface BetaTextEditorCodeExecutionCreateResultBlockParam {
  is_file_update: boolean;
  type: 'text_editor_code_execution_create_result';
}

export interface BetaTextEditorCodeExecutionStrReplaceResultBlock {
  lines: Array<string> | null;
  new_lines: number | null;
  new_start: number | null;
  old_lines: number | null;
  old_start: number | null;
  type: 'text_editor_code_execution_str_replace_result';
}

export interface BetaTextEditorCodeExecutionStrReplaceResultBlockParam {
  type: 'text_editor_code_execution_str_replace_result';
  lines?: Array<string> | null;
  new_lines?: number | null;
  new_start?: number | null;
  old_lines?: number | null;
  old_start?: number | null;
}

export interface BetaTextEditorCodeExecutionToolResultBlock {
  content: BetaTextEditorCodeExecutionToolResultError | BetaTextEditorCodeExecutionViewResultBlock | BetaTextEditorCodeExecutionCreateResultBlock | BetaTextEditorCodeExecutionStrReplaceResultBlock;
  tool_use_id: string;
  type: 'text_editor_code_execution_tool_result';
}

export interface BetaTextEditorCodeExecutionToolResultBlockParam {
  content: BetaTextEditorCodeExecutionToolResultErrorParam | BetaTextEditorCodeExecutionViewResultBlockParam | BetaTextEditorCodeExecutionCreateResultBlockParam | BetaTextEditorCodeExecutionStrReplaceResultBlockParam;
  tool_use_id: string;
  type: 'text_editor_code_execution_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaTextEditorCodeExecutionToolResultError {
  error_code: 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded' | 'file_not_found';
  error_message: string | null;
  type: 'text_editor_code_execution_tool_result_error';
}

export interface BetaTextEditorCodeExecutionToolResultErrorParam {
  error_code: 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded' | 'file_not_found';
  type: 'text_editor_code_execution_tool_result_error';
  error_message?: string | null;
}

export interface BetaTextEditorCodeExecutionViewResultBlock {
  content: string;
  file_type: 'text' | 'image' | 'pdf';
  num_lines: number | null;
  start_line: number | null;
  total_lines: number | null;
  type: 'text_editor_code_execution_view_result';
}

export interface BetaTextEditorCodeExecutionViewResultBlockParam {
  content: string;
  file_type: 'text' | 'image' | 'pdf';
  type: 'text_editor_code_execution_view_result';
  num_lines?: number | null;
  start_line?: number | null;
  total_lines?: number | null;
}

export interface BetaThinkingBlock {
  signature: string;
  thinking: string;
  type: 'thinking';
}

export interface BetaThinkingBlockBinding {
  prefix_mismatch_behavior?: BetaThinkingPrefixMismatchBehavior | null;
}

export interface BetaThinkingBlockParam {
  signature: string;
  thinking: string;
  type: 'thinking';
}

export interface BetaThinkingConfigAdaptive {
  type: 'adaptive';
  block_binding?: BetaThinkingBlockBinding | null;
  display?: 'summarized' | 'omitted' | 'updates' | null;
}

export interface BetaThinkingConfigBetweenTools {
  type: 'between_tools';
}

export interface BetaThinkingConfigDisabled {
  type: 'disabled';
}

export interface BetaThinkingConfigEnabled {
  budget_tokens: number;
  type: 'enabled';
  block_binding?: BetaThinkingBlockBinding | null;
  display?: 'summarized' | 'omitted' | 'updates' | null;
}

export type BetaThinkingConfigParam = BetaThinkingConfigEnabled | BetaThinkingConfigDisabled | BetaThinkingConfigBetweenTools | BetaThinkingConfigAdaptive;

export interface BetaThinkingDroppedInputTransformation {
  path: string;
  reason: 'model_binding_mismatch' | 'prefix_binding_mismatch' | 'organization_binding_mismatch' | 'end_user_binding_mismatch';
  type: 'thinking_dropped';
}

export interface BetaThinkingMismatchAllowedInputTransformation {
  path: string;
  reason: 'model_binding_mismatch' | 'prefix_binding_mismatch' | 'organization_binding_mismatch' | 'end_user_binding_mismatch';
  type: 'thinking_mismatch_allowed';
}

export type BetaThinkingPrefixMismatchBehavior = 'error' | 'drop_block';

export interface BetaThinkingTurns {
  type: 'thinking_turns';
  value: number;
}

export interface BetaTokenTaskBudget {
  total: number;
  type: 'tokens';
  remaining?: number | null;
}

export interface BetaTool {
  input_schema: BetaTool.InputSchema;
  name: string;
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  description?: string;
  eager_input_streaming?: boolean | null;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
  type?: 'custom' | null;
}

export namespace BetaTool {
  export interface InputSchema {
    type: 'object';
    properties?: unknown | null;
    required?: string[] | readonly string[] | null;
    [k: string]: unknown;
  }
}

export interface BetaToolBash20241022 {
  name: 'bash';
  type: 'bash_20241022';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolBash20250124 {
  name: 'bash';
  type: 'bash_20250124';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolChangeMCPToolReference {
  name: string;
  server_name: string;
  type: 'mcp_tool_reference';
}

export interface BetaToolChangeMCPToolsetReference {
  server_name: string;
  type: 'mcp_toolset_reference';
}

export interface BetaToolChangeToolDefinition {
  definition: BetaResponseToolUnion;
  type: 'tool_definition';
}

export interface BetaToolChangeToolDefinitionParam {
  definition: BetaToolUnion;
  type: 'tool_definition';
}

export interface BetaToolChangeToolReference {
  name: string;
  type: 'tool_reference';
}

export type BetaToolChoice = BetaToolChoiceAuto | BetaToolChoiceAny | BetaToolChoiceTool | BetaToolChoiceNone;

export interface BetaToolChoiceAny {
  type: 'any';
  disable_parallel_tool_use?: boolean;
}

export interface BetaToolChoiceAuto {
  type: 'auto';
  disable_parallel_tool_use?: boolean;
}

export interface BetaToolChoiceNone {
  type: 'none';
}

export interface BetaToolChoiceTool {
  name: string;
  type: 'tool';
  disable_parallel_tool_use?: boolean;
}

export interface BetaToolComputerUse20241022 {
  display_height_px: number;
  display_width_px: number;
  name: 'computer';
  type: 'computer_20241022';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  display_number?: number | null;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolComputerUse20250124 {
  display_height_px: number;
  display_width_px: number;
  name: 'computer';
  type: 'computer_20250124';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  display_number?: number | null;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolComputerUse20251124 {
  display_height_px: number;
  display_width_px: number;
  name: 'computer';
  type: 'computer_20251124';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  display_number?: number | null;
  enable_zoom?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolReferenceBlock {
  tool_name: string;
  type: 'tool_reference';
}

export interface BetaToolReferenceBlockParam {
  tool_name: string;
  type: 'tool_reference';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaToolResultBlockParam {
  tool_use_id: string;
  type: 'tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
  content?: string | Array<BetaTextBlockParam | BetaImageBlockParam | BetaSearchResultBlockParam | BetaRequestDocumentBlock | BetaToolReferenceBlockParam | BetaBrowserStateBlockParam>;
  is_error?: boolean;
  toolset_name?: string | null;
}

export interface BetaToolSearchToolBm25_20251119 {
  name: 'tool_search_tool_bm25';
  type: 'tool_search_tool_bm25_20251119' | 'tool_search_tool_bm25';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface BetaToolSearchToolRegex20251119 {
  name: 'tool_search_tool_regex';
  type: 'tool_search_tool_regex_20251119' | 'tool_search_tool_regex';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface BetaToolSearchToolResultBlock {
  content: BetaToolSearchToolResultError | BetaToolSearchToolSearchResultBlock;
  tool_use_id: string;
  type: 'tool_search_tool_result';
}

export interface BetaToolSearchToolResultBlockParam {
  content: BetaToolSearchToolResultErrorParam | BetaToolSearchToolSearchResultBlockParam;
  tool_use_id: string;
  type: 'tool_search_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
}

export interface BetaToolSearchToolResultError {
  error_code: 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded';
  error_message: string | null;
  type: 'tool_search_tool_result_error';
}

export interface BetaToolSearchToolResultErrorParam {
  error_code: 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded';
  type: 'tool_search_tool_result_error';
  error_message?: string | null;
}

export interface BetaToolSearchToolSearchResultBlock {
  tool_references: Array<BetaToolReferenceBlock>;
  type: 'tool_search_tool_search_result';
}

export interface BetaToolSearchToolSearchResultBlockParam {
  tool_references: Array<BetaToolReferenceBlockParam>;
  type: 'tool_search_tool_search_result';
}

export interface BetaToolTextEditor20241022 {
  name: 'str_replace_editor';
  type: 'text_editor_20241022';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolTextEditor20250124 {
  name: 'str_replace_editor';
  type: 'text_editor_20250124';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolTextEditor20250429 {
  name: 'str_replace_based_edit_tool';
  type: 'text_editor_20250429';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface BetaToolTextEditor20250728 {
  name: 'str_replace_based_edit_tool';
  type: 'text_editor_20250728';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  max_characters?: number | null;
  strict?: boolean;
}

export type BetaToolUnion = BetaTool | BetaToolBash20241022 | BetaToolBash20250124 | BetaCodeExecutionTool20250522 | BetaCodeExecutionTool20250825 | BetaCodeExecutionTool20260120 | BetaCodeExecutionTool20260521 | BetaBrowserToolset20260801 | BetaToolComputerUse20241022 | BetaMemoryTool20250818 | BetaToolComputerUse20250124 | BetaToolTextEditor20241022 | BetaToolComputerUse20251124 | BetaComputerToolset20260801 | BetaToolTextEditor20250124 | BetaToolTextEditor20250429 | BetaToolTextEditor20250728 | BetaWebSearchTool20250305 | BetaWebFetchTool20250910 | BetaWebSearchTool20260209 | BetaWebFetchTool20260209 | BetaWebFetchTool20260309 | BetaWebSearchTool20260318 | BetaWebFetchTool20260318 | BetaAdvisorTool20260301 | BetaToolSearchToolBm25_20251119 | BetaToolSearchToolRegex20251119 | BetaMCPToolset;

export interface BetaToolUseBlock {
  id: string;
  input: unknown;
  name: string;
  type: 'tool_use';
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
  toolset_name?: string | null;
}

export interface BetaToolUseBlockParam {
  id: string;
  input: unknown;
  name: string;
  type: 'tool_use';
  cache_control?: BetaCacheControlEphemeral | null;
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
  toolset_name?: string | null;
}

export interface BetaToolUsesKeep {
  type: 'tool_uses';
  value: number;
}

export interface BetaToolUsesTrigger {
  type: 'tool_uses';
  value: number;
}

export interface BetaURLImageSource {
  type: 'url';
  url: string;
}

export interface BetaURLPDFSource {
  type: 'url';
  url: string;
}

export interface BetaUsage {
  cache_creation: BetaCacheCreation | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  fallback_credit: BetaFallbackCreditUsage | null;
  inference_geo: string | null;
  input_tokens: number;
  iterations: BetaIterationsUsage | null;
  output_tokens: number;
  output_tokens_details: BetaOutputTokensDetails | null;
  server_tool_use: BetaServerToolUsage | null;
  service_tier: 'standard' | 'priority' | 'batch' | null;
  speed: 'standard' | 'fast' | null;
}

export interface BetaUserLocation {
  type: 'approximate';
  city?: string | null;
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}

export interface BetaWebFetchBlock {
  content: BetaDocumentBlock;
  retrieved_at: string | null;
  type: 'web_fetch_result';
  url: string;
}

export interface BetaWebFetchBlockParam {
  content: BetaRequestDocumentBlock;
  type: 'web_fetch_result';
  url: string;
  retrieved_at?: string | null;
}

export interface BetaWebFetchTool20250910 {
  name: 'web_fetch';
  type: 'web_fetch_20250910';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: BetaCacheControlEphemeral | null;
  citations?: BetaCitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  strict?: boolean;
  url_sources?: BetaWebFetchURLSources | null;
}

export interface BetaWebFetchTool20260209 {
  name: 'web_fetch';
  type: 'web_fetch_20260209';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: BetaCacheControlEphemeral | null;
  citations?: BetaCitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  strict?: boolean;
  url_sources?: BetaWebFetchURLSources | null;
}

export interface BetaWebFetchTool20260309 {
  name: 'web_fetch';
  type: 'web_fetch_20260309';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: BetaCacheControlEphemeral | null;
  citations?: BetaCitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  strict?: boolean;
  url_sources?: BetaWebFetchURLSources | null;
  use_cache?: boolean;
}

export interface BetaWebFetchTool20260318 {
  name: 'web_fetch';
  type: 'web_fetch_20260318';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: BetaCacheControlEphemeral | null;
  citations?: BetaCitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  response_inclusion?: 'full' | 'excluded';
  strict?: boolean;
  url_sources?: BetaWebFetchURLSources | null;
  use_cache?: boolean;
}

export interface BetaWebFetchToolResultBlock {
  content: BetaWebFetchToolResultErrorBlock | BetaWebFetchBlock;
  tool_use_id: string;
  type: 'web_fetch_tool_result';
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
}

export interface BetaWebFetchToolResultBlockParam {
  content: BetaWebFetchToolResultErrorBlockParam | BetaWebFetchBlockParam;
  tool_use_id: string;
  type: 'web_fetch_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
}

export interface BetaWebFetchToolResultErrorBlock {
  error_code: BetaWebFetchToolResultErrorCode;
  type: 'web_fetch_tool_result_error';
}

export interface BetaWebFetchToolResultErrorBlockParam {
  error_code: BetaWebFetchToolResultErrorCode;
  type: 'web_fetch_tool_result_error';
}

export type BetaWebFetchToolResultErrorCode = 'invalid_tool_input' | 'url_too_long' | 'url_not_allowed' | 'url_not_in_prior_context' | 'url_not_accessible' | 'unsupported_content_type' | 'too_many_requests' | 'max_uses_exceeded' | 'unavailable' | 'content_too_large';

export interface BetaWebFetchURLSourceAll {
  type: 'all';
}

export interface BetaWebFetchURLSourceExcept {
  tools: Array<BetaWebFetchURLSourceToolReference>;
  type: 'except';
}

export interface BetaWebFetchURLSourceNone {
  type: 'none';
}

export interface BetaWebFetchURLSourceOnly {
  tools: Array<BetaWebFetchURLSourceToolReference>;
  type: 'only';
}

export interface BetaWebFetchURLSourceToolReference {
  name: string;
  type: 'tool_reference';
}

export interface BetaWebFetchURLSources {
  client_tool_results?: BetaWebFetchURLSourceAll | BetaWebFetchURLSourceNone | BetaWebFetchURLSourceOnly | BetaWebFetchURLSourceExcept;
  server_tool_results?: BetaWebFetchURLSourceAll | BetaWebFetchURLSourceNone | BetaWebFetchURLSourceOnly | BetaWebFetchURLSourceExcept;
  user_input?: BetaWebFetchURLSourceAll | BetaWebFetchURLSourceNone;
}

export interface BetaWebSearchResultBlock {
  encrypted_content: string;
  page_age: string | null;
  title: string;
  type: 'web_search_result';
  url: string;
}

export interface BetaWebSearchResultBlockParam {
  encrypted_content: string;
  title: string;
  type: 'web_search_result';
  url: string;
  page_age?: string | null;
}

export interface BetaWebSearchTool20250305 {
  name: 'web_search';
  type: 'web_search_20250305';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  max_uses?: number | null;
  strict?: boolean;
  user_location?: BetaUserLocation | null;
}

export interface BetaWebSearchTool20260209 {
  name: 'web_search';
  type: 'web_search_20260209';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  max_uses?: number | null;
  strict?: boolean;
  user_location?: BetaUserLocation | null;
}

export interface BetaWebSearchTool20260318 {
  name: 'web_search';
  type: 'web_search_20260318';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: BetaCacheControlEphemeral | null;
  defer_loading?: boolean;
  max_uses?: number | null;
  response_inclusion?: 'full' | 'excluded';
  strict?: boolean;
  user_location?: BetaUserLocation | null;
}

export interface BetaWebSearchToolRequestError {
  error_code: BetaWebSearchToolResultErrorCode;
  type: 'web_search_tool_result_error';
}

export interface BetaWebSearchToolResultBlock {
  content: BetaWebSearchToolResultBlockContent;
  tool_use_id: string;
  type: 'web_search_tool_result';
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
}

export type BetaWebSearchToolResultBlockContent = BetaWebSearchToolResultError | Array<BetaWebSearchResultBlock>;

export interface BetaWebSearchToolResultBlockParam {
  content: BetaWebSearchToolResultBlockParamContent;
  tool_use_id: string;
  type: 'web_search_tool_result';
  cache_control?: BetaCacheControlEphemeral | null;
  caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
}

export type BetaWebSearchToolResultBlockParamContent = Array<BetaWebSearchResultBlockParam> | BetaWebSearchToolRequestError;

export interface BetaWebSearchToolResultError {
  error_code: BetaWebSearchToolResultErrorCode;
  type: 'web_search_tool_result_error';
}

export type BetaWebSearchToolResultErrorCode = 'invalid_tool_input' | 'unavailable' | 'max_uses_exceeded' | 'too_many_requests' | 'query_too_long' | 'request_too_large';

export interface MessageCreateParamsBase {
  max_tokens: number;
  messages: Array<BetaMessageParam>;
  model: MessagesAPI.Model;
  cache_control?: BetaCacheControlEphemeral | null;
  compaction?: BetaCompactionConfig | null;
  container?: BetaContainerParams | string | null;
  context_management?: BetaContextManagementConfig | null;
  diagnostics?: BetaDiagnosticsParam | null;
  fallback_credit_token?: string | BetaFallbackCreditTokenParam | null;
  fallbacks?: BetaFallbacksParam | null;
  inference_geo?: string | null;
  mcp_servers?: Array<BetaRequestMCPServerURLDefinition>;
  metadata?: BetaMetadata;
  output_config?: BetaOutputConfig;
  output_format?: BetaJSONOutputFormat | null;
  service_tier?: 'auto' | 'standard_only';
  speed?: 'standard' | 'fast' | null;
  stop_sequences?: Array<string>;
  stream?: boolean;
  system?: string | Array<BetaTextBlockParam>;
  temperature?: number;
  thinking?: BetaThinkingConfigParam;
  tool_choice?: BetaToolChoice;
  tools?: Array<BetaToolUnion>;
  top_k?: number;
  top_p?: number;
}
