// Input Fit IR contains cross-protocol request semantics; authenticated native replay bypasses it.
// Coverage comments name the source protocols that can populate each type or field.
// All
export interface IRInputSettings {
  readonly model: string; // All
  readonly stream: boolean; // All
  readonly temperature?: number | null; // All
  readonly top_p?: number | null; // All
  readonly top_k?: number; // Messages, GenerateContent
  readonly stop?: readonly string[]; // ChatCompletions, Messages, GenerateContent
  readonly seed?: number; // ChatCompletions, GenerateContent
  // The visible-output ceiling is distinct from a cap that includes reasoning.
  readonly max_visible_output_tokens?: number | null; // ChatCompletions
  readonly max_output_tokens?: number | null; // All
  readonly output_format?: IRInputOutputFormat; // All
  readonly metadata?: Readonly<Record<string, string>> | null; // ChatCompletions, Responses, Messages
  readonly store?: boolean | null; // ChatCompletions, Responses
  readonly service_tier?: string | null; // ChatCompletions, Responses, Messages
  readonly parallel_tool_calls?: boolean | null; // ChatCompletions, Responses, Messages
  // Effort and numeric budget are independent source controls.
  readonly reasoning_effort?: string; // All
  readonly reasoning_budget?: number; // Messages, GenerateContent
  readonly reasoning_budget_dynamic?: boolean; // Messages, GenerateContent
  readonly reasoning_summary?: string; // Responses
  readonly verbosity?: string; // ChatCompletions, Responses
  readonly prompt_cache_key?: string | null; // ChatCompletions, Responses
  readonly prompt_cache_retention?: string | null; // ChatCompletions, Responses
  readonly prompt_cache_options?: IRInputPromptCacheOptions | null; // ChatCompletions, Responses
  readonly safety_identifier?: string | null; // ChatCompletions, Responses
  readonly user?: string | null; // ChatCompletions, Responses
  readonly logprobs?: boolean | null; // ChatCompletions, Responses
  readonly top_logprobs?: number | null; // ChatCompletions, Responses
  readonly choice_count?: number; // ChatCompletions, GenerateContent
  readonly presence_penalty?: number | null; // ChatCompletions, Responses, GenerateContent
  readonly frequency_penalty?: number | null; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses
export interface IRInputPromptCacheOptions {
  readonly mode?: string; // ChatCompletions, Responses
  readonly ttl?: string; // ChatCompletions, Responses
}

// All
export interface IRInputOutputFormat {
  readonly type: 'text' | 'json_object' | 'json_schema'; // All
  readonly name?: string; // All
  readonly description?: string; // ChatCompletions, Responses
  readonly schema?: Readonly<Record<string, unknown>>; // All
  readonly strict?: boolean | null; // ChatCompletions, Responses, Messages
}

// Turns stay separate so restored native assistant turns can be interleaved.
// All
export interface IRInputRequestHeader {
  readonly settings: IRInputSettings; // All
  // Absent and empty are the same thing: a request that declares no tool.
  readonly tools?: readonly IRInputTool[]; // All
  readonly tool_choice?: IRInputToolChoice; // All
}

// Hosted tools have no cross-protocol IR form.
// All
export type IRInputTool = IRInputFunctionTool | IRInputCustomTool;

// All
export interface IRInputFunctionTool extends IRInputToolSelector {
  readonly type: 'function'; // All
  readonly description?: string; // All
  readonly parameters?: Readonly<Record<string, unknown>>; // All
  readonly strict?: boolean; // ChatCompletions, Responses, Messages
}

// ChatCompletions, Responses
export interface IRInputCustomTool extends IRInputToolSelector {
  readonly type: 'custom'; // ChatCompletions, Responses
  readonly description?: string; // ChatCompletions, Responses
  readonly format?: IRInputCustomToolFormat; // ChatCompletions, Responses
}

// ChatCompletions, Responses
export type IRInputCustomToolFormat =
  | { readonly type: 'text' } // ChatCompletions, Responses
  | {
    readonly type: 'grammar'; // ChatCompletions, Responses
    readonly definition: string; // ChatCompletions, Responses
    readonly syntax: string; // ChatCompletions, Responses
  };

// `allowed_tools` restricts calls without changing the visible declarations.
// All
export type IRInputToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | IRInputToolSelector
  | {
    readonly type: 'allowed_tools'; // ChatCompletions, Responses, GenerateContent
    readonly mode: 'auto' | 'required'; // ChatCompletions, Responses, GenerateContent
    readonly tools: readonly IRInputToolSelector[]; // ChatCompletions, Responses, GenerateContent
  };

// All
export interface IRInputToolSelector {
  readonly type: 'function' | 'custom'; // All
  readonly name: string; // All
  readonly namespace?: string; // Responses
}

// All
export type IRInputTurn = IRInputClientTurn | IRInputAssistantTurn;

// All
export interface IRInputClientTurn {
  readonly kind: 'client'; // All
  readonly items: readonly IRInputClientItem[]; // All
}

// All
export interface IRInputAssistantTurn {
  readonly kind: 'assistant'; // All
  readonly items: readonly IRInputAssistantItem[]; // All
}

// Flat ordered items let each target reconstruct its own message grouping.
// All
export type IRInputClientItem = IRInputInstructionItem | IRInputClientMessageItem | IRInputToolResultItem;

// All
export type IRInputAssistantItem =
  | IRInputAssistantMessageItem
  | IRInputReasoningItem
  | IRInputFunctionCallItem
  | IRInputCustomToolCallItem;

// Messages, Responses, GenerateContent
export interface IRInputInstructionItem {
  readonly type: 'instruction'; // Messages, Responses, GenerateContent
  readonly content: readonly IRInputTextPart[]; // Messages, Responses, GenerateContent
}

// All
export type IRInputClientMessageItem =
  | {
    readonly type: 'message'; // All
    readonly role: 'user'; // All
    readonly content: readonly IRInputUserContentPart[]; // All
  }
  | {
    readonly type: 'message'; // ChatCompletions, Responses, Messages
    readonly role: 'system' | 'developer'; // ChatCompletions, Responses, Messages
    readonly content: readonly IRInputTextPart[]; // ChatCompletions, Responses, Messages
  };

// All
export interface IRInputAssistantMessageItem {
  readonly type: 'message'; // All
  readonly content: readonly IRInputAssistantContentPart[]; // All
}

// All
export type IRInputUserContentPart =
  | IRInputTextPart
  | IRInputImagePart
  | IRInputFilePart
  | IRInputDocumentPart
  | IRInputAudioPart;

// All
export type IRInputAssistantContentPart = IRInputTextPart | IRInputRefusalPart;

// All
export interface IRInputTextPart {
  readonly type: 'text'; // All
  readonly text: string; // All
}

// ChatCompletions, Responses
export interface IRInputRefusalPart {
  readonly type: 'refusal'; // ChatCompletions, Responses
  readonly refusal: string; // ChatCompletions, Responses
}

// All
export interface IRInputImagePart {
  readonly type: 'image'; // All
  readonly image: IRInputMedia; // All
  readonly detail?: string | null; // ChatCompletions, Responses
}

// ChatCompletions, Responses, GenerateContent
export interface IRInputFilePart {
  readonly type: 'file'; // ChatCompletions, Responses, GenerateContent
  readonly file: IRInputMedia; // ChatCompletions, Responses, GenerateContent
  readonly filename?: string | null; // ChatCompletions, Responses
}

// Messages
export interface IRInputDocumentPart {
  readonly type: 'document'; // Messages
  readonly document: IRInputDocument; // Messages
}

// Messages
export interface IRInputDocument {
  readonly source: IRInputDocumentSource; // Messages
}

// Messages
export type IRInputDocumentSource =
  | {
    readonly source_kind: 'media'; // Messages
    readonly media: IRInputMedia; // Messages
  }
  | {
    readonly source_kind: 'text'; // Messages
    readonly media_type: 'text/plain'; // Messages
    readonly text: string; // Messages
  }
  | {
    readonly source_kind: 'content'; // Messages
    readonly content: readonly IRInputDocumentContentPart[]; // Messages
  };

// Content-backed documents contain text and images, not file parts.
// Messages
export type IRInputDocumentContentPart = IRInputTextPart | IRInputImagePart;

// ChatCompletions, GenerateContent
export interface IRInputAudioPart {
  readonly type: 'audio'; // ChatCompletions, GenerateContent
  readonly audio: IRInputAudio; // ChatCompletions, GenerateContent
}

// ChatCompletions, GenerateContent
export interface IRInputAudio {
  readonly media_type: string; // ChatCompletions, GenerateContent
  readonly data: string; // ChatCompletions, GenerateContent
}

// All
export type IRInputMedia =
  | {
    readonly source_kind: 'url'; // ChatCompletions, Responses, Messages
    readonly url: string; // ChatCompletions, Responses, Messages
  }
  | {
    readonly source_kind: 'data'; // ChatCompletions, Responses
    readonly data: string; // ChatCompletions, Responses
  }
  | {
    readonly source_kind: 'base64'; // Messages, GenerateContent
    readonly media_type?: string; // Messages, GenerateContent
    readonly data: string; // Messages, GenerateContent
  }
  | {
    readonly source_kind: 'file'; // ChatCompletions, Responses, Messages
    readonly file_id: string; // ChatCompletions, Responses, Messages
  };

// Opaque signed reasoning remains in authenticated sidecars.
// Messages, Responses, GenerateContent
export interface IRInputReasoningItem {
  readonly type: 'reasoning'; // Messages, Responses, GenerateContent
  readonly id?: string; // Responses, GenerateContent
  readonly summary?: readonly string[]; // Messages, Responses, GenerateContent
  readonly content?: readonly string[]; // Responses
}

// All
export interface IRInputFunctionCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'function_call'; // All
  readonly call_id?: string; // All
  // Raw JSON preserves malformed input and distinguishes omission from null or {}.
  readonly arguments?: string; // All
}

// ChatCompletions, Responses
export interface IRInputCustomToolCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'custom_tool_call'; // ChatCompletions, Responses
  readonly call_id?: string; // ChatCompletions, Responses
  readonly input: string; // ChatCompletions, Responses
}

// All
export interface IRInputToolResultItem {
  readonly type: 'tool_result'; // All
  readonly call_id?: string; // All
  readonly name?: string; // ChatCompletions, GenerateContent
  // Strings stay opaque; arrays preserve structured multimodal output.
  readonly output: string | readonly IRInputToolResultContentPart[]; // All
  readonly tool_kind?: 'function' | 'custom'; // ChatCompletions, Responses
  readonly is_error?: boolean; // Messages, Responses
}

// All
export type IRInputToolResultContentPart = IRInputTextPart | IRInputImagePart | IRInputFilePart | IRInputDocumentPart;
