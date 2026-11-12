// Input Fit IR contains cross-protocol request semantics; authenticated native replay bypasses it.
export interface IRInputSettings {
  readonly model: string;
  readonly stream: boolean;
  readonly temperature?: number | null;
  readonly top_p?: number | null;
  readonly top_k?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
  // The visible-output ceiling is distinct from a cap that includes reasoning.
  readonly max_visible_output_tokens?: number | null;
  readonly max_output_tokens?: number | null;
  readonly output_format?: IRInputOutputFormat;
  readonly metadata?: Readonly<Record<string, string>> | null;
  readonly store?: boolean | null;
  readonly service_tier?: string | null;
  readonly parallel_tool_calls?: boolean | null;
  // Effort and numeric budget are independent source controls.
  readonly reasoning_effort?: string;
  readonly reasoning_budget?: number;
  readonly reasoning_budget_dynamic?: boolean;
  readonly reasoning_summary?: string;
  readonly verbosity?: string;
  readonly prompt_cache_key?: string | null;
  readonly prompt_cache_retention?: string | null;
  readonly prompt_cache_options?: IRInputPromptCacheOptions | null;
  readonly safety_identifier?: string | null;
  readonly user?: string | null;
  readonly logprobs?: boolean | null;
  readonly top_logprobs?: number | null;
  readonly choice_count?: number;
  readonly presence_penalty?: number | null;
  readonly frequency_penalty?: number | null;
}

export interface IRInputPromptCacheOptions {
  readonly mode?: string;
  readonly ttl?: string;
}

export interface IRInputOutputFormat {
  readonly type: 'text' | 'json_object' | 'json_schema';
  readonly name?: string;
  readonly description?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly strict?: boolean | null;
}

// Turns stay separate so restored native assistant turns can be interleaved.
export interface IRInputRequestHeader {
  readonly settings: IRInputSettings;
  // Absent and empty are the same thing: a request that declares no tool.
  readonly tools?: readonly IRInputTool[];
  readonly tool_choice?: IRInputToolChoice;
}

// Hosted tools have no cross-protocol IR form.
export type IRInputTool = IRInputFunctionTool | IRInputCustomTool;

export interface IRInputFunctionTool extends IRInputToolSelector {
  readonly type: 'function';
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface IRInputCustomTool extends IRInputToolSelector {
  readonly type: 'custom';
  readonly description?: string;
  readonly format?: IRInputCustomToolFormat;
}

export type IRInputCustomToolFormat =
  | { readonly type: 'text' }
  | { readonly type: 'grammar'; readonly definition: string; readonly syntax: string };

// `allowed_tools` restricts calls without changing the visible declarations.
export type IRInputToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | IRInputToolSelector
  | { readonly type: 'allowed_tools'; readonly mode: 'auto' | 'required'; readonly tools: readonly IRInputToolSelector[] };

export interface IRInputToolSelector {
  readonly type: 'function' | 'custom';
  readonly name: string;
  readonly namespace?: string;
}

export type IRInputTurn = IRInputClientTurn | IRInputAssistantTurn;

export interface IRInputClientTurn {
  readonly kind: 'client';
  readonly items: readonly IRInputClientItem[];
}

export interface IRInputAssistantTurn {
  readonly kind: 'assistant';
  readonly items: readonly IRInputAssistantItem[];
}

// Flat ordered items let each target reconstruct its own message grouping.
export type IRInputClientItem = IRInputInstructionItem | IRInputClientMessageItem | IRInputToolResultItem;

export type IRInputAssistantItem =
  | IRInputAssistantMessageItem
  | IRInputReasoningItem
  | IRInputFunctionCallItem
  | IRInputCustomToolCallItem;

export interface IRInputInstructionItem {
  readonly type: 'instruction';
  readonly content: readonly IRInputTextPart[];
}

export type IRInputClientMessageItem =
  | { readonly type: 'message'; readonly role: 'user'; readonly content: readonly IRInputUserContentPart[] }
  | { readonly type: 'message'; readonly role: 'system' | 'developer'; readonly content: readonly IRInputTextPart[] };

export interface IRInputAssistantMessageItem {
  readonly type: 'message';
  readonly content: readonly IRInputAssistantContentPart[];
}

export type IRInputUserContentPart =
  | IRInputTextPart
  | IRInputImagePart
  | IRInputFilePart
  | IRInputDocumentPart
  | IRInputAudioPart;

export type IRInputAssistantContentPart = IRInputTextPart | IRInputRefusalPart;

export interface IRInputTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface IRInputRefusalPart {
  readonly type: 'refusal';
  readonly refusal: string;
}

export interface IRInputImagePart {
  readonly type: 'image';
  readonly image: IRInputMedia;
  readonly detail?: string | null;
}

export interface IRInputFilePart {
  readonly type: 'file';
  readonly file: IRInputMedia;
  readonly filename?: string | null;
}

export interface IRInputDocumentPart {
  readonly type: 'document';
  readonly document: IRInputDocument;
}

export interface IRInputDocument {
  readonly source: IRInputDocumentSource;
}

export type IRInputDocumentSource =
  | { readonly source_kind: 'media'; readonly media: IRInputMedia }
  | { readonly source_kind: 'text'; readonly media_type: 'text/plain'; readonly text: string }
  | { readonly source_kind: 'content'; readonly content: readonly IRInputDocumentContentPart[] };

// Content-backed documents contain text and images, not file parts.
export type IRInputDocumentContentPart = IRInputTextPart | IRInputImagePart;

export interface IRInputAudioPart {
  readonly type: 'audio';
  readonly audio: IRInputAudio;
}

export interface IRInputAudio {
  readonly media_type: string;
  readonly data: string;
}

export type IRInputMedia =
  | { readonly source_kind: 'url'; readonly url: string }
  | { readonly source_kind: 'data'; readonly data: string }
  | { readonly source_kind: 'base64'; readonly media_type?: string; readonly data: string }
  | { readonly source_kind: 'file'; readonly file_id: string };

// Opaque signed reasoning remains in authenticated sidecars.
export interface IRInputReasoningItem {
  readonly type: 'reasoning';
  readonly id?: string;
  readonly summary?: readonly string[];
  readonly content?: readonly string[];
}

export interface IRInputFunctionCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'function_call';
  readonly call_id?: string;
  // Raw JSON preserves malformed input and distinguishes omission from null or {}.
  readonly arguments?: string;
}

export interface IRInputCustomToolCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'custom_tool_call';
  readonly call_id?: string;
  readonly input: string;
}

export interface IRInputToolResultItem {
  readonly type: 'tool_result';
  readonly call_id?: string;
  readonly name?: string;
  // Strings stay opaque; arrays preserve structured multimodal output.
  readonly output: string | readonly IRInputToolResultContentPart[];
  readonly tool_kind?: 'function' | 'custom';
  readonly is_error?: boolean;
}

export type IRInputToolResultContentPart = IRInputTextPart | IRInputImagePart | IRInputFilePart | IRInputDocumentPart;
