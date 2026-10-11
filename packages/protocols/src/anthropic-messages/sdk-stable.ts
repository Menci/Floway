// Official SDK wire declarations.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts

export interface Base64ImageSource {
  data: string;
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  type: 'base64';
}

export interface Base64PDFSource {
  data: string;
  media_type: 'application/pdf';
  type: 'base64';
}

export interface BashCodeExecutionOutputBlock {
  file_id: string;
  type: 'bash_code_execution_output';
}

export interface BashCodeExecutionOutputBlockParam {
  file_id: string;
  type: 'bash_code_execution_output';
}

export interface BashCodeExecutionResultBlock {
  content: Array<BashCodeExecutionOutputBlock>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'bash_code_execution_result';
}

export interface BashCodeExecutionResultBlockParam {
  content: Array<BashCodeExecutionOutputBlockParam>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'bash_code_execution_result';
}

export interface BashCodeExecutionToolResultBlock {
  content: BashCodeExecutionToolResultError | BashCodeExecutionResultBlock;
  tool_use_id: string;
  type: 'bash_code_execution_tool_result';
}

export interface BashCodeExecutionToolResultBlockParam {
  content: BashCodeExecutionToolResultErrorParam | BashCodeExecutionResultBlockParam;
  tool_use_id: string;
  type: 'bash_code_execution_tool_result';
  cache_control?: CacheControlEphemeral | null;
}

export interface BashCodeExecutionToolResultError {
  error_code: BashCodeExecutionToolResultErrorCode;
  type: 'bash_code_execution_tool_result_error';
}

export type BashCodeExecutionToolResultErrorCode = 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded' | 'output_file_too_large';

export interface BashCodeExecutionToolResultErrorParam {
  error_code: BashCodeExecutionToolResultErrorCode;
  type: 'bash_code_execution_tool_result_error';
}

export interface BrowserCloseTabConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserDoubleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserFileUploadConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserFindConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserFormInputConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserGetPageTextConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserHoldKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserHoverConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserJavascriptExecConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserLeftClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserLeftClickDragConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserLeftMouseDownConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserLeftMouseUpConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserListTabsConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserMiddleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserMouseMoveConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserNavigateConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserNewTabConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserReadConsoleConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserReadNetworkConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserReadPageConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserRightClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserScreenshotConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserScrollConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserScrollToConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserStateBlockParam {
  tabs: Array<BrowserStateTabEntry>;
  type: 'browser_state';
  cache_control?: CacheControlEphemeral | null;
  state_changes?: Array<BrowserStateChange> | null;
}

export type BrowserStateChange = BrowserStateChangeTabOpened | BrowserStateChangeDownloadStarted | BrowserStateChangeDownloadCompleted | BrowserStateChangeDownloadFailed;

export interface BrowserStateChangeDownloadCompleted {
  download_id: string;
  type: 'download_completed';
  url: string;
  path?: string | null;
  size_bytes?: number | null;
}

export interface BrowserStateChangeDownloadFailed {
  download_id: string;
  type: 'download_failed';
  url: string;
  error?: string | null;
}

export interface BrowserStateChangeDownloadStarted {
  download_id: string;
  type: 'download_started';
  url: string;
}

export interface BrowserStateChangeTabOpened {
  tab_id: string;
  type: 'tab_opened';
}

export interface BrowserStateTabEntry {
  tab_id: string;
  title: string;
  url: string;
  active?: boolean;
}

export interface BrowserSwitchTabConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserToolset20260801 {
  type: 'browser_toolset_20260801';
  cache_control?: CacheControlEphemeral | null;
  configs?: BrowserToolsetConfigs | null;
}

export interface BrowserToolsetConfigs {
  close_tab?: BrowserCloseTabConfig | null;
  double_click?: BrowserDoubleClickConfig | null;
  file_upload?: BrowserFileUploadConfig | null;
  find?: BrowserFindConfig | null;
  form_input?: BrowserFormInputConfig | null;
  get_page_text?: BrowserGetPageTextConfig | null;
  hold_key?: BrowserHoldKeyConfig | null;
  hover?: BrowserHoverConfig | null;
  javascript_exec?: BrowserJavascriptExecConfig | null;
  key?: BrowserKeyConfig | null;
  left_click?: BrowserLeftClickConfig | null;
  left_click_drag?: BrowserLeftClickDragConfig | null;
  left_mouse_down?: BrowserLeftMouseDownConfig | null;
  left_mouse_up?: BrowserLeftMouseUpConfig | null;
  list_tabs?: BrowserListTabsConfig | null;
  middle_click?: BrowserMiddleClickConfig | null;
  mouse_move?: BrowserMouseMoveConfig | null;
  navigate?: BrowserNavigateConfig | null;
  new_tab?: BrowserNewTabConfig | null;
  read_console?: BrowserReadConsoleConfig | null;
  read_network?: BrowserReadNetworkConfig | null;
  read_page?: BrowserReadPageConfig | null;
  right_click?: BrowserRightClickConfig | null;
  screenshot?: BrowserScreenshotConfig | null;
  scroll?: BrowserScrollConfig | null;
  scroll_to?: BrowserScrollToConfig | null;
  switch_tab?: BrowserSwitchTabConfig | null;
  triple_click?: BrowserTripleClickConfig | null;
  type?: BrowserTypeConfig | null;
  wait?: BrowserWaitConfig | null;
  zoom?: BrowserZoomConfig | null;
}

export interface BrowserTripleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserTypeConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserWaitConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface BrowserZoomConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface CacheControlEphemeral {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface CacheCreation {
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
}

export interface CacheMissMessagesChanged {
  cache_missed_input_tokens: number;
  type: 'messages_changed';
}

export interface CacheMissModelChanged {
  cache_missed_input_tokens: number;
  type: 'model_changed';
}

export interface CacheMissPreviousMessageNotFound {
  type: 'previous_message_not_found';
}

export type CacheMissReason = CacheMissModelChanged | CacheMissSystemChanged | CacheMissToolsChanged | CacheMissMessagesChanged | CacheMissPreviousMessageNotFound | CacheMissUnavailable;

export interface CacheMissSystemChanged {
  cache_missed_input_tokens: number;
  type: 'system_changed';
}

export interface CacheMissToolsChanged {
  cache_missed_input_tokens: number;
  type: 'tools_changed';
}

export interface CacheMissUnavailable {
  type: 'unavailable';
}

export interface CitationCharLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_char_index: number;
  file_id: string | null;
  start_char_index: number;
  type: 'char_location';
}

export interface CitationCharLocationParam {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_char_index: number;
  start_char_index: number;
  type: 'char_location';
}

export interface CitationContentBlockLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_block_index: number;
  file_id: string | null;
  start_block_index: number;
  type: 'content_block_location';
}

export interface CitationContentBlockLocationParam {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_block_index: number;
  start_block_index: number;
  type: 'content_block_location';
}

export interface CitationPageLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_page_number: number;
  file_id: string | null;
  start_page_number: number;
  type: 'page_location';
}

export interface CitationPageLocationParam {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_page_number: number;
  start_page_number: number;
  type: 'page_location';
}

export interface CitationSearchResultLocationParam {
  cited_text: string;
  end_block_index: number;
  search_result_index: number;
  source: string;
  start_block_index: number;
  title: string | null;
  type: 'search_result_location';
}

export interface CitationWebSearchResultLocationParam {
  cited_text: string;
  encrypted_index: string;
  title: string | null;
  type: 'web_search_result_location';
  url: string;
}

export interface CitationsConfig {
  enabled: boolean;
}

export interface CitationsConfigParam {
  enabled?: boolean;
}

export interface CitationsSearchResultLocation {
  cited_text: string;
  end_block_index: number;
  search_result_index: number;
  source: string;
  start_block_index: number;
  title: string | null;
  type: 'search_result_location';
}

export interface CitationsWebSearchResultLocation {
  cited_text: string;
  encrypted_index: string;
  title: string | null;
  type: 'web_search_result_location';
  url: string;
}

export interface CodeExecutionOutputBlock {
  file_id: string;
  type: 'code_execution_output';
}

export interface CodeExecutionOutputBlockParam {
  file_id: string;
  type: 'code_execution_output';
}

export interface CodeExecutionResultBlock {
  content: Array<CodeExecutionOutputBlock>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'code_execution_result';
}

export interface CodeExecutionResultBlockParam {
  content: Array<CodeExecutionOutputBlockParam>;
  return_code: number;
  stderr: string;
  stdout: string;
  type: 'code_execution_result';
}

export interface CodeExecutionTool20250522 {
  name: 'code_execution';
  type: 'code_execution_20250522';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface CodeExecutionTool20250825 {
  name: 'code_execution';
  type: 'code_execution_20250825';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface CodeExecutionTool20260120 {
  name: 'code_execution';
  type: 'code_execution_20260120';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface CodeExecutionTool20260521 {
  name: 'code_execution';
  type: 'code_execution_20260521';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface CodeExecutionToolResultBlock {
  content: CodeExecutionToolResultBlockContent;
  tool_use_id: string;
  type: 'code_execution_tool_result';
}

export type CodeExecutionToolResultBlockContent = CodeExecutionToolResultError | CodeExecutionResultBlock | EncryptedCodeExecutionResultBlock;

export interface CodeExecutionToolResultBlockParam {
  content: CodeExecutionToolResultBlockParamContent;
  tool_use_id: string;
  type: 'code_execution_tool_result';
  cache_control?: CacheControlEphemeral | null;
}

export type CodeExecutionToolResultBlockParamContent = CodeExecutionToolResultErrorParam | CodeExecutionResultBlockParam | EncryptedCodeExecutionResultBlockParam;

export interface CodeExecutionToolResultError {
  error_code: CodeExecutionToolResultErrorCode;
  type: 'code_execution_tool_result_error';
}

export type CodeExecutionToolResultErrorCode = 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded';

export interface CodeExecutionToolResultErrorParam {
  error_code: CodeExecutionToolResultErrorCode;
  type: 'code_execution_tool_result_error';
}

export interface ComputerCursorPositionConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerDoubleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerHoldKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerKeyConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerLeftClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerLeftClickDragConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerLeftMouseDownConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerLeftMouseUpConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerMiddleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerMouseMoveConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerRightClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerScreenshotConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerScrollConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerToolset20260801 {
  type: 'computer_toolset_20260801';
  cache_control?: CacheControlEphemeral | null;
  configs?: ComputerToolsetConfigs | null;
}

export interface ComputerToolsetConfigs {
  cursor_position?: ComputerCursorPositionConfig | null;
  double_click?: ComputerDoubleClickConfig | null;
  hold_key?: ComputerHoldKeyConfig | null;
  key?: ComputerKeyConfig | null;
  left_click?: ComputerLeftClickConfig | null;
  left_click_drag?: ComputerLeftClickDragConfig | null;
  left_mouse_down?: ComputerLeftMouseDownConfig | null;
  left_mouse_up?: ComputerLeftMouseUpConfig | null;
  middle_click?: ComputerMiddleClickConfig | null;
  mouse_move?: ComputerMouseMoveConfig | null;
  right_click?: ComputerRightClickConfig | null;
  screenshot?: ComputerScreenshotConfig | null;
  scroll?: ComputerScrollConfig | null;
  triple_click?: ComputerTripleClickConfig | null;
  type?: ComputerTypeConfig | null;
  wait?: ComputerWaitConfig | null;
  zoom?: ComputerZoomConfig | null;
}

export interface ComputerTripleClickConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerTypeConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerWaitConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface ComputerZoomConfig {
  defer_loading?: boolean | null;
  enabled?: boolean | null;
}

export interface Container {
  id: string;
  expires_at: string;
  skills: Array<ContainerSkill> | null;
}

export interface ContainerParams {
  id?: string | null;
  skills?: Array<SkillParams> | null;
}

export interface ContainerSkill {
  skill_id: string;
  type: 'anthropic' | 'custom';
  version: string;
}

export interface ContainerUploadBlock {
  file_id: string;
  type: 'container_upload';
}

export interface ContainerUploadBlockParam {
  file_id: string;
  type: 'container_upload';
  cache_control?: CacheControlEphemeral | null;
}

export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ServerToolUseBlock | WebSearchToolResultBlock | WebFetchToolResultBlock | CodeExecutionToolResultBlock | BashCodeExecutionToolResultBlock | TextEditorCodeExecutionToolResultBlock | ToolSearchToolResultBlock | ContainerUploadBlock;

export type ContentBlockParam = TextBlockParam | ImageBlockParam | DocumentBlockParam | SearchResultBlockParam | ThinkingBlockParam | RedactedThinkingBlockParam | ToolUseBlockParam | ToolResultBlockParam | ServerToolUseBlockParam | WebSearchToolResultBlockParam | WebFetchToolResultBlockParam | CodeExecutionToolResultBlockParam | BashCodeExecutionToolResultBlockParam | TextEditorCodeExecutionToolResultBlockParam | ToolSearchToolResultBlockParam | ContainerUploadBlockParam;

export interface ContentBlockSource {
  content: string | Array<ContentBlockSourceContent>;
  type: 'content';
}

export type ContentBlockSourceContent = TextBlockParam | ImageBlockParam;

export interface Diagnostics {
  cache_miss_reason: CacheMissReason | null;
}

export interface DiagnosticsParam {
  previous_message_id?: string | null;
}

export interface DirectCaller {
  type: 'direct';
}

export interface DocumentBlock {
  citations: CitationsConfig | null;
  source: Base64PDFSource | PlainTextSource;
  title: string | null;
  type: 'document';
}

export interface DocumentBlockParam {
  source: Base64PDFSource | PlainTextSource | ContentBlockSource | URLPDFSource | FileDocumentSource;
  type: 'document';
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam | null;
  context?: string | null;
  title?: string | null;
}

export interface EncryptedCodeExecutionResultBlock {
  content: Array<CodeExecutionOutputBlock>;
  encrypted_stdout: string;
  return_code: number;
  stderr: string;
  type: 'encrypted_code_execution_result';
}

export interface EncryptedCodeExecutionResultBlockParam {
  content: Array<CodeExecutionOutputBlockParam>;
  encrypted_stdout: string;
  return_code: number;
  stderr: string;
  type: 'encrypted_code_execution_result';
}

export interface FileDocumentSource {
  file_id: string;
  type: 'file';
}

export interface FileImageSource {
  file_id: string;
  type: 'file';
}

export interface ImageBlockParam {
  source: Base64ImageSource | URLImageSource | FileImageSource;
  type: 'image';
  cache_control?: CacheControlEphemeral | null;
  transformations?: ImageTransformationsParam | null;
}

export interface ImageTransformationsParam {
  oversized_image?: 'downsize' | 'error';
}

export interface JSONOutputFormat {
  schema: {
    [key: string]: unknown;
  };
  type: 'json_schema';
}

export interface MemoryTool20250818 {
  name: 'memory';
  type: 'memory_20250818';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface Message {
  id: string;
  container: Container | null;
  content: Array<ContentBlock>;
  diagnostics: Diagnostics | null;
  model: Model;
  role: 'assistant';
  stop_details: RefusalStopDetails | null;
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  type: 'message';
  usage: Usage;
}

export type MessageCreateParamsContainer = ContainerParams | string;

export interface MessageParam {
  content: string | Array<ContentBlockParam>;
  role: 'user' | 'assistant' | 'system';
}

export interface Metadata {
  user_id?: string | null;
}

export type Model = 'claude-sonnet-5-5' | 'claude-fable-5-1' | 'claude-opus-5-5' | 'claude-mythos-5-1' | 'claude-sonnet-5' | 'claude-fable-5' | 'claude-mythos-5' | 'claude-opus-5' | 'claude-opus-4-8' | 'claude-opus-4-7' | 'claude-mythos-preview' | 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5' | 'claude-haiku-4-5-20251001' | 'claude-opus-4-5' | 'claude-opus-4-5-20251101' | 'claude-sonnet-4-5' | 'claude-sonnet-4-5-20250929' | (string & {});

export interface OutputConfig {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  format?: JSONOutputFormat | null;
}

export interface OutputTokensDetails {
  thinking_tokens: number;
}

export interface PlainTextSource {
  data: string;
  media_type: 'text/plain';
  type: 'text';
}

export namespace RawMessageDeltaEvent {
}

export interface RedactedThinkingBlock {
  data: string;
  type: 'redacted_thinking';
}

export interface RedactedThinkingBlockParam {
  data: string;
  type: 'redacted_thinking';
}

export interface RefusalStopDetails {
  category: 'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null;
  explanation: string | null;
  type: 'refusal';
}

export interface SearchResultBlockParam {
  content: Array<TextBlockParam>;
  source: string;
  title: string;
  type: 'search_result';
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam;
}

export interface ServerToolCaller {
  tool_id: string;
  type: 'code_execution_20250825';
}

export interface ServerToolCaller20260120 {
  tool_id: string;
  type: 'code_execution_20260120';
}

export interface ServerToolUsage {
  web_fetch_requests: number;
  web_search_requests: number;
}

export interface ServerToolUseBlock {
  id: string;
  caller: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
  input: unknown;
  name: 'web_search' | 'web_fetch' | 'code_execution' | 'bash_code_execution' | 'text_editor_code_execution' | 'tool_search_tool_regex' | 'tool_search_tool_bm25';
  type: 'server_tool_use';
}

export interface ServerToolUseBlockParam {
  id: string;
  input: unknown;
  name: 'web_search' | 'web_fetch' | 'code_execution' | 'bash_code_execution' | 'text_editor_code_execution' | 'tool_search_tool_regex' | 'tool_search_tool_bm25';
  type: 'server_tool_use';
  cache_control?: CacheControlEphemeral | null;
  caller?: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
}

export interface SkillParams {
  skill_id: string;
  type: 'anthropic' | 'custom';
  version?: string;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | 'model_context_window_exceeded';

export interface TextBlock {
  citations: Array<TextCitation> | null;
  text: string;
  type: 'text';
}

export interface TextBlockParam {
  text: string;
  type: 'text';
  cache_control?: CacheControlEphemeral | null;
  citations?: Array<TextCitationParam> | null;
}

export type TextCitation = CitationCharLocation | CitationPageLocation | CitationContentBlockLocation | CitationsWebSearchResultLocation | CitationsSearchResultLocation;

export type TextCitationParam = CitationCharLocationParam | CitationPageLocationParam | CitationContentBlockLocationParam | CitationWebSearchResultLocationParam | CitationSearchResultLocationParam;

export interface TextEditorCodeExecutionCreateResultBlock {
  is_file_update: boolean;
  type: 'text_editor_code_execution_create_result';
}

export interface TextEditorCodeExecutionCreateResultBlockParam {
  is_file_update: boolean;
  type: 'text_editor_code_execution_create_result';
}

export interface TextEditorCodeExecutionStrReplaceResultBlock {
  lines: Array<string> | null;
  new_lines: number | null;
  new_start: number | null;
  old_lines: number | null;
  old_start: number | null;
  type: 'text_editor_code_execution_str_replace_result';
}

export interface TextEditorCodeExecutionStrReplaceResultBlockParam {
  type: 'text_editor_code_execution_str_replace_result';
  lines?: Array<string> | null;
  new_lines?: number | null;
  new_start?: number | null;
  old_lines?: number | null;
  old_start?: number | null;
}

export interface TextEditorCodeExecutionToolResultBlock {
  content: TextEditorCodeExecutionToolResultError | TextEditorCodeExecutionViewResultBlock | TextEditorCodeExecutionCreateResultBlock | TextEditorCodeExecutionStrReplaceResultBlock;
  tool_use_id: string;
  type: 'text_editor_code_execution_tool_result';
}

export interface TextEditorCodeExecutionToolResultBlockParam {
  content: TextEditorCodeExecutionToolResultErrorParam | TextEditorCodeExecutionViewResultBlockParam | TextEditorCodeExecutionCreateResultBlockParam | TextEditorCodeExecutionStrReplaceResultBlockParam;
  tool_use_id: string;
  type: 'text_editor_code_execution_tool_result';
  cache_control?: CacheControlEphemeral | null;
}

export interface TextEditorCodeExecutionToolResultError {
  error_code: TextEditorCodeExecutionToolResultErrorCode;
  error_message: string | null;
  type: 'text_editor_code_execution_tool_result_error';
}

export type TextEditorCodeExecutionToolResultErrorCode = 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded' | 'file_not_found';

export interface TextEditorCodeExecutionToolResultErrorParam {
  error_code: TextEditorCodeExecutionToolResultErrorCode;
  type: 'text_editor_code_execution_tool_result_error';
  error_message?: string | null;
}

export interface TextEditorCodeExecutionViewResultBlock {
  content: string;
  file_type: 'text' | 'image' | 'pdf';
  num_lines: number | null;
  start_line: number | null;
  total_lines: number | null;
  type: 'text_editor_code_execution_view_result';
}

export interface TextEditorCodeExecutionViewResultBlockParam {
  content: string;
  file_type: 'text' | 'image' | 'pdf';
  type: 'text_editor_code_execution_view_result';
  num_lines?: number | null;
  start_line?: number | null;
  total_lines?: number | null;
}

export interface ThinkingBlock {
  signature: string;
  thinking: string;
  type: 'thinking';
}

export interface ThinkingBlockParam {
  signature: string;
  thinking: string;
  type: 'thinking';
}

export interface ThinkingConfigAdaptive {
  type: 'adaptive';
  display?: 'summarized' | 'omitted' | null;
}

export interface ThinkingConfigBetweenTools {
  type: 'between_tools';
}

export interface ThinkingConfigDisabled {
  type: 'disabled';
}

export interface ThinkingConfigEnabled {
  budget_tokens: number;
  type: 'enabled';
  display?: 'summarized' | 'omitted' | null;
}

export type ThinkingConfigParam = ThinkingConfigEnabled | ThinkingConfigDisabled | ThinkingConfigBetweenTools | ThinkingConfigAdaptive;

export interface Tool {
  input_schema: Tool.InputSchema;
  name: string;
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  description?: string;
  eager_input_streaming?: boolean | null;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
  type?: 'custom' | null;
}

export namespace Tool {
  export interface InputSchema {
    type: 'object';
    properties?: unknown | null;
    required?: Array<string> | null;
    [k: string]: unknown;
  }
}

export interface ToolBash20250124 {
  name: 'bash';
  type: 'bash_20250124';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export type ToolChoice = ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | ToolChoiceNone;

export interface ToolChoiceAny {
  type: 'any';
  disable_parallel_tool_use?: boolean;
}

export interface ToolChoiceAuto {
  type: 'auto';
  disable_parallel_tool_use?: boolean;
}

export interface ToolChoiceNone {
  type: 'none';
}

export interface ToolChoiceTool {
  name: string;
  type: 'tool';
  disable_parallel_tool_use?: boolean;
}

export interface ToolReferenceBlock {
  tool_name: string;
  type: 'tool_reference';
}

export interface ToolReferenceBlockParam {
  tool_name: string;
  type: 'tool_reference';
  cache_control?: CacheControlEphemeral | null;
}

export interface ToolResultBlockParam {
  tool_use_id: string;
  type: 'tool_result';
  cache_control?: CacheControlEphemeral | null;
  content?: string | Array<TextBlockParam | ImageBlockParam | SearchResultBlockParam | DocumentBlockParam | ToolReferenceBlockParam | BrowserStateBlockParam>;
  is_error?: boolean;
  toolset_name?: string | null;
}

export interface ToolSearchToolBm25_20251119 {
  name: 'tool_search_tool_bm25';
  type: 'tool_search_tool_bm25_20251119' | 'tool_search_tool_bm25';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface ToolSearchToolRegex20251119 {
  name: 'tool_search_tool_regex';
  type: 'tool_search_tool_regex_20251119' | 'tool_search_tool_regex';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  strict?: boolean;
}

export interface ToolSearchToolResultBlock {
  content: ToolSearchToolResultError | ToolSearchToolSearchResultBlock;
  tool_use_id: string;
  type: 'tool_search_tool_result';
}

export interface ToolSearchToolResultBlockParam {
  content: ToolSearchToolResultErrorParam | ToolSearchToolSearchResultBlockParam;
  tool_use_id: string;
  type: 'tool_search_tool_result';
  cache_control?: CacheControlEphemeral | null;
}

export interface ToolSearchToolResultError {
  error_code: ToolSearchToolResultErrorCode;
  error_message: string | null;
  type: 'tool_search_tool_result_error';
}

export type ToolSearchToolResultErrorCode = 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded';

export interface ToolSearchToolResultErrorParam {
  error_code: ToolSearchToolResultErrorCode;
  type: 'tool_search_tool_result_error';
  error_message?: string | null;
}

export interface ToolSearchToolSearchResultBlock {
  tool_references: Array<ToolReferenceBlock>;
  type: 'tool_search_tool_search_result';
}

export interface ToolSearchToolSearchResultBlockParam {
  tool_references: Array<ToolReferenceBlockParam>;
  type: 'tool_search_tool_search_result';
}

export interface ToolTextEditor20250124 {
  name: 'str_replace_editor';
  type: 'text_editor_20250124';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface ToolTextEditor20250429 {
  name: 'str_replace_based_edit_tool';
  type: 'text_editor_20250429';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  strict?: boolean;
}

export interface ToolTextEditor20250728 {
  name: 'str_replace_based_edit_tool';
  type: 'text_editor_20250728';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  input_examples?: Array<{
    [key: string]: unknown;
  }>;
  max_characters?: number | null;
  strict?: boolean;
}

export type ToolUnion = Tool | ToolBash20250124 | CodeExecutionTool20250522 | CodeExecutionTool20250825 | CodeExecutionTool20260120 | CodeExecutionTool20260521 | BrowserToolset20260801 | MemoryTool20250818 | ComputerToolset20260801 | ToolTextEditor20250124 | ToolTextEditor20250429 | ToolTextEditor20250728 | WebSearchTool20250305 | WebFetchTool20250910 | WebSearchTool20260209 | WebFetchTool20260209 | WebFetchTool20260309 | WebSearchTool20260318 | WebFetchTool20260318 | ToolSearchToolBm25_20251119 | ToolSearchToolRegex20251119;

export interface ToolUseBlock {
  id: string;
  caller: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
  input: unknown;
  name: string;
  type: 'tool_use';
  toolset_name?: string | null;
}

export interface ToolUseBlockParam {
  id: string;
  input: unknown;
  name: string;
  type: 'tool_use';
  cache_control?: CacheControlEphemeral | null;
  caller?: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
  toolset_name?: string | null;
}

export interface URLImageSource {
  type: 'url';
  url: string;
}

export interface URLPDFSource {
  type: 'url';
  url: string;
}

export interface Usage {
  cache_creation: CacheCreation | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  inference_geo: string | null;
  input_tokens: number;
  output_tokens: number;
  output_tokens_details: OutputTokensDetails | null;
  server_tool_use: ServerToolUsage | null;
  service_tier: 'standard' | 'priority' | 'batch' | null;
}

export interface UserLocation {
  type: 'approximate';
  city?: string | null;
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}

export interface WebFetchBlock {
  content: DocumentBlock;
  retrieved_at: string | null;
  type: 'web_fetch_result';
  url: string;
}

export interface WebFetchBlockParam {
  content: DocumentBlockParam;
  type: 'web_fetch_result';
  url: string;
  retrieved_at?: string | null;
}

export interface WebFetchTool20250910 {
  name: 'web_fetch';
  type: 'web_fetch_20250910';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  strict?: boolean;
  url_sources?: WebFetchURLSources | null;
}

export interface WebFetchTool20260209 {
  name: 'web_fetch';
  type: 'web_fetch_20260209';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  strict?: boolean;
  url_sources?: WebFetchURLSources | null;
}

export interface WebFetchTool20260309 {
  name: 'web_fetch';
  type: 'web_fetch_20260309';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  strict?: boolean;
  url_sources?: WebFetchURLSources | null;
  use_cache?: boolean;
}

export interface WebFetchTool20260318 {
  name: 'web_fetch';
  type: 'web_fetch_20260318';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;
  max_uses?: number | null;
  response_inclusion?: 'full' | 'excluded';
  strict?: boolean;
  url_sources?: WebFetchURLSources | null;
  use_cache?: boolean;
}

export interface WebFetchToolResultBlock {
  caller: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
  content: WebFetchToolResultErrorBlock | WebFetchBlock;
  tool_use_id: string;
  type: 'web_fetch_tool_result';
}

export interface WebFetchToolResultBlockParam {
  content: WebFetchToolResultErrorBlockParam | WebFetchBlockParam;
  tool_use_id: string;
  type: 'web_fetch_tool_result';
  cache_control?: CacheControlEphemeral | null;
  caller?: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
}

export interface WebFetchToolResultErrorBlock {
  error_code: WebFetchToolResultErrorCode;
  type: 'web_fetch_tool_result_error';
}

export interface WebFetchToolResultErrorBlockParam {
  error_code: WebFetchToolResultErrorCode;
  type: 'web_fetch_tool_result_error';
}

export type WebFetchToolResultErrorCode = 'invalid_tool_input' | 'url_too_long' | 'url_not_allowed' | 'url_not_in_prior_context' | 'url_not_accessible' | 'unsupported_content_type' | 'too_many_requests' | 'max_uses_exceeded' | 'unavailable' | 'content_too_large';

export interface WebFetchURLSourceAll {
  type: 'all';
}

export interface WebFetchURLSourceExcept {
  tools: Array<WebFetchURLSourceToolReference>;
  type: 'except';
}

export interface WebFetchURLSourceNone {
  type: 'none';
}

export interface WebFetchURLSourceOnly {
  tools: Array<WebFetchURLSourceToolReference>;
  type: 'only';
}

export interface WebFetchURLSourceToolReference {
  name: string;
  type: 'tool_reference';
}

export interface WebFetchURLSources {
  client_tool_results?: WebFetchURLSourceAll | WebFetchURLSourceNone | WebFetchURLSourceOnly | WebFetchURLSourceExcept;
  server_tool_results?: WebFetchURLSourceAll | WebFetchURLSourceNone | WebFetchURLSourceOnly | WebFetchURLSourceExcept;
  user_input?: WebFetchURLSourceAll | WebFetchURLSourceNone;
}

export interface WebSearchResultBlock {
  encrypted_content: string;
  page_age: string | null;
  title: string;
  type: 'web_search_result';
  url: string;
}

export interface WebSearchResultBlockParam {
  encrypted_content: string;
  title: string;
  type: 'web_search_result';
  url: string;
  page_age?: string | null;
}

export interface WebSearchTool20250305 {
  name: 'web_search';
  type: 'web_search_20250305';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  max_uses?: number | null;
  strict?: boolean;
  user_location?: UserLocation | null;
}

export namespace WebSearchTool20250305 {
}

export interface WebSearchTool20260209 {
  name: 'web_search';
  type: 'web_search_20260209';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  max_uses?: number | null;
  strict?: boolean;
  user_location?: UserLocation | null;
}

export namespace WebSearchTool20260209 {
}

export interface WebSearchTool20260318 {
  name: 'web_search';
  type: 'web_search_20260318';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120' | 'code_execution_20260521'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  defer_loading?: boolean;
  max_uses?: number | null;
  response_inclusion?: 'full' | 'excluded';
  strict?: boolean;
  user_location?: UserLocation | null;
}

export interface WebSearchToolRequestError {
  error_code: WebSearchToolResultErrorCode;
  type: 'web_search_tool_result_error';
}

export interface WebSearchToolResultBlock {
  caller: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
  content: WebSearchToolResultBlockContent;
  tool_use_id: string;
  type: 'web_search_tool_result';
}

export type WebSearchToolResultBlockContent = WebSearchToolResultError | Array<WebSearchResultBlock>;

export interface WebSearchToolResultBlockParam {
  content: WebSearchToolResultBlockParamContent;
  tool_use_id: string;
  type: 'web_search_tool_result';
  cache_control?: CacheControlEphemeral | null;
  caller?: DirectCaller | ServerToolCaller | ServerToolCaller20260120;
}

export type WebSearchToolResultBlockParamContent = Array<WebSearchResultBlockParam> | WebSearchToolRequestError;

export interface WebSearchToolResultError {
  error_code: WebSearchToolResultErrorCode;
  type: 'web_search_tool_result_error';
}

export type WebSearchToolResultErrorCode = 'invalid_tool_input' | 'unavailable' | 'max_uses_exceeded' | 'too_many_requests' | 'query_too_long' | 'request_too_large';

export interface MessageCreateParamsBase {
  max_tokens: number;
  messages: Array<MessageParam>;
  model: Model;
  cache_control?: CacheControlEphemeral | null;
  container?: MessageCreateParamsContainer | null;
  diagnostics?: DiagnosticsParam | null;
  inference_geo?: string | null;
  metadata?: Metadata;
  output_config?: OutputConfig;
  service_tier?: 'auto' | 'standard_only';
  stop_sequences?: Array<string>;
  stream?: boolean;
  system?: string | Array<TextBlockParam>;
  temperature?: number;
  thinking?: ThinkingConfigParam;
  tool_choice?: ToolChoice;
  tools?: Array<ToolUnion>;
  top_k?: number;
  top_p?: number;
}

export declare namespace Messages {
  export { type Model as Model, type ContentBlock as ContentBlock, type TextBlock as TextBlock, type TextCitation as TextCitation, type CitationCharLocation as CitationCharLocation, type CitationPageLocation as CitationPageLocation, type CitationContentBlockLocation as CitationContentBlockLocation, type CitationsWebSearchResultLocation as CitationsWebSearchResultLocation, type CitationsSearchResultLocation as CitationsSearchResultLocation, type ThinkingBlock as ThinkingBlock, type RedactedThinkingBlock as RedactedThinkingBlock, type ToolUseBlock as ToolUseBlock, type DirectCaller as DirectCaller, type ServerToolCaller as ServerToolCaller, type ServerToolCaller20260120 as ServerToolCaller20260120, type ServerToolUseBlock as ServerToolUseBlock, type WebSearchToolResultBlock as WebSearchToolResultBlock, type WebSearchToolResultBlockContent as WebSearchToolResultBlockContent, type WebSearchToolResultError as WebSearchToolResultError, type WebSearchToolResultErrorCode as WebSearchToolResultErrorCode, type WebSearchResultBlock as WebSearchResultBlock, type WebFetchToolResultBlock as WebFetchToolResultBlock, type WebFetchToolResultErrorBlock as WebFetchToolResultErrorBlock, type WebFetchToolResultErrorCode as WebFetchToolResultErrorCode, type WebFetchBlock as WebFetchBlock, type DocumentBlock as DocumentBlock, type CitationsConfig as CitationsConfig, type Base64PDFSource as Base64PDFSource, type PlainTextSource as PlainTextSource, type CodeExecutionToolResultBlock as CodeExecutionToolResultBlock, type CodeExecutionToolResultBlockContent as CodeExecutionToolResultBlockContent, type CodeExecutionToolResultError as CodeExecutionToolResultError, type CodeExecutionToolResultErrorCode as CodeExecutionToolResultErrorCode, type CodeExecutionResultBlock as CodeExecutionResultBlock, type CodeExecutionOutputBlock as CodeExecutionOutputBlock, type EncryptedCodeExecutionResultBlock as EncryptedCodeExecutionResultBlock, type BashCodeExecutionToolResultBlock as BashCodeExecutionToolResultBlock, type BashCodeExecutionToolResultError as BashCodeExecutionToolResultError, type BashCodeExecutionToolResultErrorCode as BashCodeExecutionToolResultErrorCode, type BashCodeExecutionResultBlock as BashCodeExecutionResultBlock, type BashCodeExecutionOutputBlock as BashCodeExecutionOutputBlock, type TextEditorCodeExecutionToolResultBlock as TextEditorCodeExecutionToolResultBlock, type TextEditorCodeExecutionToolResultError as TextEditorCodeExecutionToolResultError, type TextEditorCodeExecutionToolResultErrorCode as TextEditorCodeExecutionToolResultErrorCode, type TextEditorCodeExecutionViewResultBlock as TextEditorCodeExecutionViewResultBlock, type TextEditorCodeExecutionCreateResultBlock as TextEditorCodeExecutionCreateResultBlock, type TextEditorCodeExecutionStrReplaceResultBlock as TextEditorCodeExecutionStrReplaceResultBlock, type ToolSearchToolResultBlock as ToolSearchToolResultBlock, type ToolSearchToolResultError as ToolSearchToolResultError, type ToolSearchToolResultErrorCode as ToolSearchToolResultErrorCode, type ToolSearchToolSearchResultBlock as ToolSearchToolSearchResultBlock, type ToolReferenceBlock as ToolReferenceBlock, type ContainerUploadBlock as ContainerUploadBlock, type ContentBlockParam as ContentBlockParam, type TextBlockParam as TextBlockParam, type CacheControlEphemeral as CacheControlEphemeral, type TextCitationParam as TextCitationParam, type CitationCharLocationParam as CitationCharLocationParam, type CitationPageLocationParam as CitationPageLocationParam, type CitationContentBlockLocationParam as CitationContentBlockLocationParam, type CitationWebSearchResultLocationParam as CitationWebSearchResultLocationParam, type CitationSearchResultLocationParam as CitationSearchResultLocationParam, type ImageBlockParam as ImageBlockParam, type Base64ImageSource as Base64ImageSource, type URLImageSource as URLImageSource, type FileImageSource as FileImageSource, type ImageTransformationsParam as ImageTransformationsParam, type DocumentBlockParam as DocumentBlockParam, type ContentBlockSource as ContentBlockSource, type ContentBlockSourceContent as ContentBlockSourceContent, type URLPDFSource as URLPDFSource, type FileDocumentSource as FileDocumentSource, type CitationsConfigParam as CitationsConfigParam, type SearchResultBlockParam as SearchResultBlockParam, type ThinkingBlockParam as ThinkingBlockParam, type RedactedThinkingBlockParam as RedactedThinkingBlockParam, type ToolUseBlockParam as ToolUseBlockParam, type ToolResultBlockParam as ToolResultBlockParam, type ToolReferenceBlockParam as ToolReferenceBlockParam, type BrowserStateBlockParam as BrowserStateBlockParam, type BrowserStateTabEntry as BrowserStateTabEntry, type BrowserStateChange as BrowserStateChange, type BrowserStateChangeTabOpened as BrowserStateChangeTabOpened, type BrowserStateChangeDownloadStarted as BrowserStateChangeDownloadStarted, type BrowserStateChangeDownloadCompleted as BrowserStateChangeDownloadCompleted, type BrowserStateChangeDownloadFailed as BrowserStateChangeDownloadFailed, type ServerToolUseBlockParam as ServerToolUseBlockParam, type WebSearchToolResultBlockParam as WebSearchToolResultBlockParam, type WebSearchToolResultBlockParamContent as WebSearchToolResultBlockParamContent, type WebSearchResultBlockParam as WebSearchResultBlockParam, type WebSearchToolRequestError as WebSearchToolRequestError, type WebFetchToolResultBlockParam as WebFetchToolResultBlockParam, type WebFetchToolResultErrorBlockParam as WebFetchToolResultErrorBlockParam, type WebFetchBlockParam as WebFetchBlockParam, type CodeExecutionToolResultBlockParam as CodeExecutionToolResultBlockParam, type CodeExecutionToolResultBlockParamContent as CodeExecutionToolResultBlockParamContent, type CodeExecutionToolResultErrorParam as CodeExecutionToolResultErrorParam, type CodeExecutionResultBlockParam as CodeExecutionResultBlockParam, type CodeExecutionOutputBlockParam as CodeExecutionOutputBlockParam, type EncryptedCodeExecutionResultBlockParam as EncryptedCodeExecutionResultBlockParam, type BashCodeExecutionToolResultBlockParam as BashCodeExecutionToolResultBlockParam, type BashCodeExecutionToolResultErrorParam as BashCodeExecutionToolResultErrorParam, type BashCodeExecutionResultBlockParam as BashCodeExecutionResultBlockParam, type BashCodeExecutionOutputBlockParam as BashCodeExecutionOutputBlockParam, type TextEditorCodeExecutionToolResultBlockParam as TextEditorCodeExecutionToolResultBlockParam, type TextEditorCodeExecutionToolResultErrorParam as TextEditorCodeExecutionToolResultErrorParam, type TextEditorCodeExecutionViewResultBlockParam as TextEditorCodeExecutionViewResultBlockParam, type TextEditorCodeExecutionCreateResultBlockParam as TextEditorCodeExecutionCreateResultBlockParam, type TextEditorCodeExecutionStrReplaceResultBlockParam as TextEditorCodeExecutionStrReplaceResultBlockParam, type ToolSearchToolResultBlockParam as ToolSearchToolResultBlockParam, type ToolSearchToolResultErrorParam as ToolSearchToolResultErrorParam, type ToolSearchToolSearchResultBlockParam as ToolSearchToolSearchResultBlockParam, type ContainerUploadBlockParam as ContainerUploadBlockParam, type ToolUnion as ToolUnion, type Tool as Tool, type ToolBash20250124 as ToolBash20250124, type CodeExecutionTool20250522 as CodeExecutionTool20250522, type CodeExecutionTool20250825 as CodeExecutionTool20250825, type CodeExecutionTool20260120 as CodeExecutionTool20260120, type CodeExecutionTool20260521 as CodeExecutionTool20260521, type BrowserToolset20260801 as BrowserToolset20260801, type BrowserToolsetConfigs as BrowserToolsetConfigs, type BrowserCloseTabConfig as BrowserCloseTabConfig, type BrowserDoubleClickConfig as BrowserDoubleClickConfig, type BrowserFileUploadConfig as BrowserFileUploadConfig, type BrowserFindConfig as BrowserFindConfig, type BrowserFormInputConfig as BrowserFormInputConfig, type BrowserGetPageTextConfig as BrowserGetPageTextConfig, type BrowserHoldKeyConfig as BrowserHoldKeyConfig, type BrowserHoverConfig as BrowserHoverConfig, type BrowserJavascriptExecConfig as BrowserJavascriptExecConfig, type BrowserKeyConfig as BrowserKeyConfig, type BrowserLeftClickConfig as BrowserLeftClickConfig, type BrowserLeftClickDragConfig as BrowserLeftClickDragConfig, type BrowserLeftMouseDownConfig as BrowserLeftMouseDownConfig, type BrowserLeftMouseUpConfig as BrowserLeftMouseUpConfig, type BrowserListTabsConfig as BrowserListTabsConfig, type BrowserMiddleClickConfig as BrowserMiddleClickConfig, type BrowserMouseMoveConfig as BrowserMouseMoveConfig, type BrowserNavigateConfig as BrowserNavigateConfig, type BrowserNewTabConfig as BrowserNewTabConfig, type BrowserReadConsoleConfig as BrowserReadConsoleConfig, type BrowserReadNetworkConfig as BrowserReadNetworkConfig, type BrowserReadPageConfig as BrowserReadPageConfig, type BrowserRightClickConfig as BrowserRightClickConfig, type BrowserScreenshotConfig as BrowserScreenshotConfig, type BrowserScrollConfig as BrowserScrollConfig, type BrowserScrollToConfig as BrowserScrollToConfig, type BrowserSwitchTabConfig as BrowserSwitchTabConfig, type BrowserTripleClickConfig as BrowserTripleClickConfig, type BrowserTypeConfig as BrowserTypeConfig, type BrowserWaitConfig as BrowserWaitConfig, type BrowserZoomConfig as BrowserZoomConfig, type MemoryTool20250818 as MemoryTool20250818, type ComputerToolset20260801 as ComputerToolset20260801, type ComputerToolsetConfigs as ComputerToolsetConfigs, type ComputerCursorPositionConfig as ComputerCursorPositionConfig, type ComputerDoubleClickConfig as ComputerDoubleClickConfig, type ComputerHoldKeyConfig as ComputerHoldKeyConfig, type ComputerKeyConfig as ComputerKeyConfig, type ComputerLeftClickConfig as ComputerLeftClickConfig, type ComputerLeftClickDragConfig as ComputerLeftClickDragConfig, type ComputerLeftMouseDownConfig as ComputerLeftMouseDownConfig, type ComputerLeftMouseUpConfig as ComputerLeftMouseUpConfig, type ComputerMiddleClickConfig as ComputerMiddleClickConfig, type ComputerMouseMoveConfig as ComputerMouseMoveConfig, type ComputerRightClickConfig as ComputerRightClickConfig, type ComputerScreenshotConfig as ComputerScreenshotConfig, type ComputerScrollConfig as ComputerScrollConfig, type ComputerTripleClickConfig as ComputerTripleClickConfig, type ComputerTypeConfig as ComputerTypeConfig, type ComputerWaitConfig as ComputerWaitConfig, type ComputerZoomConfig as ComputerZoomConfig, type ToolTextEditor20250124 as ToolTextEditor20250124, type ToolTextEditor20250429 as ToolTextEditor20250429, type ToolTextEditor20250728 as ToolTextEditor20250728, type WebSearchTool20250305 as WebSearchTool20250305, type WebFetchTool20250910 as WebFetchTool20250910, type WebFetchURLSources as WebFetchURLSources, type WebFetchURLSourceAll as WebFetchURLSourceAll, type WebFetchURLSourceNone as WebFetchURLSourceNone, type WebFetchURLSourceOnly as WebFetchURLSourceOnly, type WebFetchURLSourceToolReference as WebFetchURLSourceToolReference, type WebFetchURLSourceExcept as WebFetchURLSourceExcept, type WebSearchTool20260209 as WebSearchTool20260209, type WebFetchTool20260209 as WebFetchTool20260209, type WebFetchTool20260309 as WebFetchTool20260309, type WebSearchTool20260318 as WebSearchTool20260318, type WebFetchTool20260318 as WebFetchTool20260318, type ToolSearchToolBm25_20251119 as ToolSearchToolBm25_20251119, type ToolSearchToolRegex20251119 as ToolSearchToolRegex20251119, type MessageCreateParamsBase as MessageCreateParamsBase, type MessageParam as MessageParam, type MessageCreateParamsContainer as MessageCreateParamsContainer, type ContainerParams as ContainerParams, type SkillParams as SkillParams, type DiagnosticsParam as DiagnosticsParam, type Metadata as Metadata, type OutputConfig as OutputConfig, type JSONOutputFormat as JSONOutputFormat, type ThinkingConfigParam as ThinkingConfigParam, type ThinkingConfigEnabled as ThinkingConfigEnabled, type ThinkingConfigDisabled as ThinkingConfigDisabled, type ThinkingConfigBetweenTools as ThinkingConfigBetweenTools, type ThinkingConfigAdaptive as ThinkingConfigAdaptive, type ToolChoice as ToolChoice, type ToolChoiceAuto as ToolChoiceAuto, type ToolChoiceAny as ToolChoiceAny, type ToolChoiceTool as ToolChoiceTool, type ToolChoiceNone as ToolChoiceNone, type Message as Message, type Container as Container, type ContainerSkill as ContainerSkill, type Diagnostics as Diagnostics, type CacheMissReason as CacheMissReason, type CacheMissModelChanged as CacheMissModelChanged, type CacheMissSystemChanged as CacheMissSystemChanged, type CacheMissToolsChanged as CacheMissToolsChanged, type CacheMissMessagesChanged as CacheMissMessagesChanged, type CacheMissPreviousMessageNotFound as CacheMissPreviousMessageNotFound, type CacheMissUnavailable as CacheMissUnavailable, type RefusalStopDetails as RefusalStopDetails, type StopReason as StopReason, type Usage as Usage, type CacheCreation as CacheCreation, type OutputTokensDetails as OutputTokensDetails, type ServerToolUsage as ServerToolUsage };
}
