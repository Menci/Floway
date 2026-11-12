// Input Fit IR carries concepts translatable by at least one protocol pair.
// Authenticated native replay bypasses it; vendor-native residuals remain in protocol readers and sidecars.
// Requests arrive complete, so input IR is an immutable value rather than an operation stream.
// Target writers project the fields their wire can represent.
export interface IRInputSettings {
  readonly model: string;
  // The return path is a stream, so the request path asks the upstream for one
  // and a target writer rejects an IR that does not say `true`.
  readonly stream: boolean;
  readonly temperature?: number | null;
  readonly top_p?: number | null;
  readonly top_k?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
  // Preserve the visible-output ceiling independently of the cap that includes reasoning.
  readonly max_visible_output_tokens?: number | null;
  readonly max_output_tokens?: number | null;
  readonly output_format?: IRInputOutputFormat;
  // Readers normalize non-null metadata to string pairs; target writers do not coerce it again.
  readonly metadata?: Readonly<Record<string, string>> | null;
  readonly store?: boolean | null;
  // Preserve service-tier strings and explicit null; each target owns vocabulary mapping.
  readonly service_tier?: string | null;
  readonly parallel_tool_calls?: boolean | null;
  // Keep effort as an open string, independently of numeric budget. Protocol readers and writers own their thinking-mode mapping.
  readonly reasoning_effort?: string;
  // Budget and effort remain independent; a source may cap reasoning tokens without naming an effort level.
  readonly reasoning_budget?: number;
  // Dynamic budgeting represents model-selected reasoning limits: a negative GenerateContent budget or adaptive Messages thinking.
  readonly reasoning_budget_dynamic?: boolean;
  // Preserve the summary scale while normalizing boolean source preferences at their reader.
  readonly reasoning_summary?: string;
  readonly verbosity?: string;
  // Preserve an explicit nullable cache key exactly as supplied, independently of field omission.
  readonly prompt_cache_key?: string | null;
  // Retention and breakpoint lifetime are independent controls.
  readonly prompt_cache_retention?: string | null;
  readonly prompt_cache_options?: IRInputPromptCacheOptions | null;
  // Preserve an explicit nullable safety identifier exactly as supplied.
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

// Structured output. `strict` keeps absent, null, false, and true distinct.
export interface IRInputOutputFormat {
  readonly type: 'text' | 'json_object' | 'json_schema';
  readonly name?: string;
  readonly description?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly strict?: boolean | null;
}

// One request's own fields, from the source's wire to the target's. The
// conversation is not part of it: turns travel separately as turns, because a
// writer needs them interleaved with the assistant turns a sidecar restored.
export interface IRInputRequestHeader {
  readonly settings: IRInputSettings;
  // Absent and empty are the same thing: a request that declares no tool.
  readonly tools?: readonly IRInputTool[];
  readonly tool_choice?: IRInputToolChoice;
}

// A callable the model may invoke. Hosted tools (web search, code execution,
// file search, computer use) have no cross-vendor meaning and stay in the
// native reader, matching the Fit rule for hosted history.
//
// Messages expresses both arms as one declaration shape; the distinction
// survives only where the target distinguishes it.
export type IRInputTool = IRInputFunctionTool | IRInputCustomTool;

export interface IRInputFunctionTool extends IRInputToolSelector {
  readonly type: 'function';
  readonly description?: string;
  // Preserve omitted source schemas; each target owns any schema its wire requires.
  readonly parameters?: Readonly<Record<string, unknown>>;
  // Preserve strict as true, false or source-unspecified; each target applies its wire requirement.
  readonly strict?: boolean;
}

// A freeform tool: the model returns the string the declaration describes.
// Responses has a native arm for it; Chat Completions and Messages wrap it in a
// single-`input`-string function schema.
export interface IRInputCustomTool extends IRInputToolSelector {
  readonly type: 'custom';
  readonly description?: string;
  readonly format?: IRInputCustomToolFormat;
}

export type IRInputCustomToolFormat =
  | { readonly type: 'text' }
  | { readonly type: 'grammar'; readonly definition: string; readonly syntax: string };

// What the model may call, and how freely. `allowed_tools` states a mode with a
// restricted callable set, so it stays a distinct arm rather than being flattened
// into that mode plus a filtered declaration list: widening or narrowing the
// declaration list changes what the model can see, not what it may choose.
export type IRInputToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | IRInputToolSelector
  | { readonly type: 'allowed_tools'; readonly mode: 'auto' | 'required'; readonly tools: readonly IRInputToolSelector[] };

// A selector names one declared callable by kind and its logical identity, which
// is what every protocol's selector arm states. A protocol that groups its
// declarations states the group here too.
export interface IRInputToolSelector {
  readonly type: 'function' | 'custom';
  readonly name: string;
  readonly namespace?: string;
}

// A turn groups one conversation branch. Assistant messages keep their own
// boundaries; top-level instructions and inline system/developer messages retain distinct client
// boundaries. Items stay ordered while each
// target chooses its native message grouping.
export type IRInputTurn = IRInputClientTurn | IRInputAssistantTurn;

// Client turns contain all nonassistant input, including instructions, messages, and tool results.
// Kind identifies the conversation branch; item role identifies the speaker.
export interface IRInputClientTurn {
  readonly kind: 'client';
  readonly items: readonly IRInputClientItem[];
}

export interface IRInputAssistantTurn {
  readonly kind: 'assistant';
  readonly items: readonly IRInputAssistantItem[];
}

// Items stay flat and ordered because protocols disagree about where a message
// boundary sits: Messages keeps tool results inside a user message, Chat
// Completions gives them a `tool` message, Responses makes them an input item,
// and GenerateContent makes them a part of a user content. Keeping a source
// message's own parts together while tool results and tool calls remain
// separate items lets every writer reproduce its own grouping without this IR
// prejudging one protocol's shape.
export type IRInputClientItem = IRInputInstructionItem | IRInputClientMessageItem | IRInputToolResultItem;

export type IRInputAssistantItem =
  | IRInputAssistantMessageItem
  | IRInputReasoningItem
  | IRInputFunctionCallItem
  | IRInputCustomToolCallItem;

/** A source protocol's top-level instruction field, distinct from conversation history. */
export interface IRInputInstructionItem {
  readonly type: 'instruction';
  readonly content: readonly IRInputTextPart[];
}

/** A client-side conversation message at its source position. */
export type IRInputClientMessageItem =
  | { readonly type: 'message'; readonly role: 'user'; readonly content: readonly IRInputUserContentPart[] }
  | { readonly type: 'message'; readonly role: 'system' | 'developer'; readonly content: readonly IRInputTextPart[] };

// Assistant IR projects text and refusals. Source readers reject assistant media that this model cannot represent.
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

// A refusal is model output, so only assistant history carries one. No protocol
// accepts it in client-produced content.
export interface IRInputRefusalPart {
  readonly type: 'refusal';
  readonly refusal: string;
}

export interface IRInputImagePart {
  readonly type: 'image';
  readonly image: IRInputMedia;
  // Preserve the open-string image detail value; each target owns its supported projection.
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

// Anthropic content-backed documents admit text and images only. Keeping the
// nested sequence lets non-document targets mark its provenance without
// pretending it was a byte file; a future GenerateContent target can project
// the same sequence to text and inlineData parts.
export type IRInputDocumentContentPart = IRInputTextPart | IRInputImagePart;

export interface IRInputAudioPart {
  readonly type: 'audio';
  readonly audio: IRInputAudio;
}

// Chat Completions names a two-value `format` enum and GenerateContent names a
// MIME type; the MIME type is the neutral spelling, so readers normalize into
// it and the Chat writer derives its enum.
export interface IRInputAudio {
  readonly media_type: string;
  readonly data: string;
}

// Preserve URL and file references exactly as stated. Inline media retains its supplied MIME type;
// bare base64 remains untyped. Target writers choose the wire representation.
export type IRInputMedia =
  | { readonly source_kind: 'url'; readonly url: string }
  | { readonly source_kind: 'data'; readonly data: string }
  | { readonly source_kind: 'base64'; readonly media_type?: string; readonly data: string }
  | { readonly source_kind: 'file'; readonly file_id: string };

// Only readable reasoning enters IR; opaque signed replay state remains in authenticated sidecars.
// Summary and content stay separate so each target can project the fields it supports.
export interface IRInputReasoningItem {
  readonly type: 'reasoning';
  readonly id?: string;
  readonly summary?: readonly string[];
  readonly content?: readonly string[];
}

export interface IRInputFunctionCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'function_call';
  // Call IDs may be absent in input IR; target request preparation supplies those required by its wire.
  readonly call_id?: string;
  // Keep argument JSON as raw text, including malformed input. Each target parses at its own boundary.
  // Absence means the source supplied no argument object and remains distinct from explicit null or {}.
  readonly arguments?: string;
}

export interface IRInputCustomToolCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'custom_tool_call';
  readonly call_id?: string;
  readonly input: string;
}

export interface IRInputToolResultItem {
  readonly type: 'tool_result';
  // Target allocation pairs an id-less result with a pending call before writing.
  readonly call_id?: string;
  // The name is supplied when the source correlates results by function name.
  readonly name?: string;
  // String output remains opaque, including serialized structured results. Content-part arrays preserve
  // source multimodal structure until the target chooses its representation.
  readonly output: string | readonly IRInputToolResultContentPart[];
  // Record the call kind from source history so target writers can choose custom or function results without inferring it again.
  readonly tool_kind?: 'function' | 'custom';
  // Messages is_error maps to the incomplete result state on Responses.
  readonly is_error?: boolean;
}

export type IRInputToolResultContentPart = IRInputTextPart | IRInputImagePart | IRInputFilePart | IRInputDocumentPart;
