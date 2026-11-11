// Input-side Fit IR: one request's conversation, expressed once so every
// `A via B` pair translates the same source semantics instead of re-deriving
// them from a foreign wire shape. It is the counterpart of the returned-stream
// output IR in `ir/output/` and observes the same Fit rule: a concept belongs here
// only when at least one translated pair can carry it into another protocol.
// Native residual structure (encrypted reasoning, vendor signatures, hosted
// tool calls, item identities) belongs to the authenticated sidecar and the
// per-protocol readers, never here.
//
// Request translation has three branches. An assistant turn whose authenticated
// sidecar resolves to the target protocol's native turn bypasses this IR
// entirely. The other two are the types below:
//
//     A client turn    -> IRInputClientTurn    -> B client turn
//     An assistant turn -> IRInputAssistantTurn -> B assistant turn
//
// A request arrives complete, so this IR is a plain value: no paths, no
// lifecycle events, no accumulation. That is the whole structural difference
// from the stream IR; the Fit boundary is identical.
//
// How a request is generated, as opposed to what its conversation says. These
// are the request-wide quantities translated pairs can carry, normalized once
// so a writer can respell them for its own target.
//
// Readers preserve independently stated request quantities; each target chooses
// how to express them. A knob a target cannot express is dropped there.
export interface IRInputSettings {
  // The source's model id. A route that resolves a target model folds it into
  // the source payload before the trip, so this field always states the model
  // the request asks for.
  readonly model: string;
  // The return path is a stream, so the request path asks the upstream for one
  // and a target writer rejects an IR that does not say `true`.
  readonly stream: boolean;
  readonly temperature?: number; // All
  readonly top_p?: number; // All
  readonly top_k?: number; // Messages, GenerateContent
  readonly stop?: readonly string[]; // ChatCompletions, Messages, GenerateContent
  readonly seed?: number; // ChatCompletions, GenerateContent
  // Keep the legacy visible-output ceiling separate from the completion
  // ceiling that includes reasoning. A writer chooses the bound its wire can
  // state; reading a request must not choose between source-stated quantities.
  readonly max_tokens?: number | null; // ChatCompletions
  readonly max_completion_tokens?: number | null; // ChatCompletions
  readonly max_output_tokens?: number | null; // Responses, Messages, GenerateContent
  readonly output_format?: IRInputOutputFormat; // ChatCompletions, Responses, Messages, GenerateContent
  // Key/value tags a caller attaches for its own bookkeeping. The IR holds
  // string pairs; a wire that admits other value types converts at its reader
  // rather than here.
  readonly metadata?: Readonly<Record<string, string>>; // ChatCompletions, Responses, Messages
  // Whether the upstream keeps the response for later retrieval.
  readonly store?: boolean; // ChatCompletions, Responses
  // The service tier the caller asks for, forwarded as the open string every
  // protocol defines; a target whose tier vocabulary differs maps it there.
  readonly service_tier?: string; // ChatCompletions, Responses, Messages
  // Whether the model may issue several calls in one turn.
  readonly parallel_tool_calls?: boolean; // ChatCompletions, Responses, Messages
  // The reasoning effort is independent of its numeric budget. A target with
  // only effort levels can approximate a budget when no level was supplied.
  readonly reasoning_effort?: string; // ChatCompletions, Responses, Messages
  // How many tokens the model may spend on internal reasoning. This is a
  // separate quantity from the effort level: Messages states both, and a source
  // that caps the budget without naming a level still asked for that cap.
  readonly reasoning_budget?: number; // Messages, GenerateContent
  // The source asks the target to pick the budget itself rather than state one.
  // GenerateContent spells it as a negative budget, Messages as an adaptive
  // thinking mode; both mean "let the model decide", which no number states.
  readonly reasoning_budget_dynamic?: boolean; // Messages, GenerateContent
  // Whether the caller asks for readable reasoning, and how much of it. An open
  // string because Responses defines an enumerated scale while GenerateContent
  // states a boolean.
  readonly reasoning_summary?: string; // Responses, GenerateContent
  // How much prose the model should produce. Both OpenAI protocols state the
  // same open scale, Chat at the top level and Responses under `text`.
  readonly verbosity?: string; // ChatCompletions, Responses
  // A key the caller groups cacheable prefixes by. Both wires accept an
  // explicit `null`, which is distinct from omitting the field: `null` states
  // that no key applies, while an absent field defers to the target.
  readonly prompt_cache_key?: string | null; // ChatCompletions, Responses
  // Maximum cache retention and minimum breakpoint lifetime are independent.
  // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/chat/completions/completions.ts
  readonly prompt_cache_retention?: string | null; // ChatCompletions, Responses
  readonly prompt_cache_options?: IRInputPromptCacheOptions | null; // ChatCompletions, Responses
  // An opaque caller identity the upstream uses for abuse review. Nullable for
  // the same reason as `prompt_cache_key`.
  readonly safety_identifier?: string | null; // ChatCompletions, Responses
  // The caller's legacy identity remains independent of the dedicated cache
  // and safety identities; its uses span both concerns.
  readonly user?: string | null; // ChatCompletions, Responses
  // Whether token probabilities are requested and how many alternatives to
  // return at each position. The target decides how to request their inclusion.
  readonly logprobs?: boolean | null; // ChatCompletions, Responses
  readonly top_logprobs?: number | null; // ChatCompletions, Responses
  // How many independent completions the caller asks for.
  readonly choice_count?: number; // ChatCompletions, GenerateContent
  readonly presence_penalty?: number | null; // ChatCompletions, Responses, GenerateContent
  readonly frequency_penalty?: number | null; // ChatCompletions, Responses, GenerateContent
}

export interface IRInputPromptCacheOptions {
  readonly mode?: string;
  readonly ttl?: string;
}

// Structured output. `strict` is three-state: absent means the source did not
// say, which is not the same as `false`.
export interface IRInputOutputFormat {
  readonly type: 'text' | 'json_object' | 'json_schema'; // All
  readonly name?: string; // ChatCompletions, Responses
  readonly description?: string; // ChatCompletions, Responses
  readonly schema?: Readonly<Record<string, unknown>>; // All
  readonly strict?: boolean; // ChatCompletions, Responses, Messages
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
  // A JSON Schema object. Both OpenAI wires accept one optionally and omit it
  // when the source declared none; Messages always states one, so the reader
  // forwards what the source declared.
  readonly parameters?: Readonly<Record<string, unknown>>;
  // Three-state: absent means the source did not say. Chat defaults to false,
  // Responses requires the field, so a writer states its target's requirement.
  readonly strict?: boolean;
}

// A freeform tool: the model returns the string the declaration describes.
// Responses has a native arm for it; Chat Completions and Messages wrap it in a
// single-`input`-string function schema.
export interface IRInputCustomTool extends IRInputToolSelector {
  readonly type: 'custom';
  readonly description?: string;
  // The constrained grammar a target uses to validate the model's string.
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
// boundaries; adjacent client messages join except at prompts, whose boundaries
// let targets place them inline or hoist them. Items stay ordered while each
// target chooses its native message grouping.
export type IRInputTurn = IRInputClientTurn | IRInputAssistantTurn;

// Everything the client stated. The branch is named `client` rather than `user`
// because its items keep their real roles: system and developer prompts and
// tool results live here too, and `role: 'user'` would describe only one of
// them. The assistant branch is the only other one, which is what the sidecar
// selects on.
//
// `kind` rather than `role` keeps the turn discriminant distinct from the item
// `role`: an item's role says who stated it, while a turn's kind says only
// which of the two branches it is.
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
export type IRInputClientItem = IRInputPromptItem | IRInputUserMessageItem | IRInputToolResultItem;

export type IRInputAssistantItem =
  | IRInputAssistantMessageItem
  | IRInputReasoningItem
  | IRInputFunctionCallItem
  | IRInputCustomToolCallItem;

// A prompt boundary: text the caller sets rather than a turn it takes. It
// represents a top-level prompt field (`instructions`, `systemInstruction`, or
// Messages' `system`) as well as a system or developer message inside the
// conversation, so no placement field is needed — position carries the
// placement and each writer applies its own hoisting rule.
//
// Its own discriminant keeps a prompt distinct from user content, whose parts
// may carry media; a reader of the union must not have to re-read `role`.
export interface IRInputPromptItem {
  readonly type: 'prompt'; // ChatCompletions, Responses, Messages
  readonly role: 'system' | 'developer'; // ChatCompletions, Responses; Messages has `system` only
  // Text only: no pair carries media in system or developer content, and each
  // reader rejects a non-text part rather than silently dropping it.
  readonly content: readonly IRInputTextPart[]; // ChatCompletions, Responses, Messages
}

export interface IRInputUserMessageItem {
  readonly type: 'message'; // All
  readonly content: readonly IRInputUserContentPart[]; // All
}

// Assistant history carries no media. Messages assistant blocks and
// GenerateContent model parts have no image, file, or audio variant, and the
// routes reject Responses assistant media instead of flattening it.
export interface IRInputAssistantMessageItem {
  readonly type: 'message'; // All
  readonly content: readonly IRInputAssistantContentPart[]; // All
}

export type IRInputUserContentPart =
  | IRInputTextPart
  | IRInputImagePart
  | IRInputFilePart
  | IRInputAudioPart;

export type IRInputAssistantContentPart = IRInputTextPart | IRInputRefusalPart;

export interface IRInputTextPart {
  readonly type: 'text'; // All
  readonly text: string; // All
}

// A refusal is model output, so only assistant history carries one. No protocol
// accepts it in client-produced content.
export interface IRInputRefusalPart {
  readonly type: 'refusal'; // ChatCompletions, Responses
  readonly refusal: string; // ChatCompletions, Responses
}

export interface IRInputImagePart {
  readonly type: 'image'; // All
  readonly image: IRInputMedia; // All
  // Chat Completions forwards the `auto | low | high` axis as an open string;
  // Responses adds `original`. Messages has no per-image detail.
  readonly detail?: string | null; // ChatCompletions, Responses
}

export interface IRInputFilePart {
  readonly type: 'file'; // ChatCompletions, Responses, GenerateContent; Messages carries it as `document`
  readonly file: IRInputMedia; // All
  readonly filename?: string | null; // ChatCompletions, Responses
}

export interface IRInputAudioPart {
  readonly type: 'audio'; // ChatCompletions, GenerateContent
  readonly audio: IRInputAudio; // ChatCompletions, GenerateContent
}

// Chat Completions names a two-value `format` enum and GenerateContent names a
// MIME type; the MIME type is the neutral spelling, so readers normalize into
// it and the Chat writer derives its enum.
export interface IRInputAudio {
  readonly media_type: string; // ChatCompletions, GenerateContent
  readonly data: string; // ChatCompletions, GenerateContent
}

// A vendor file reference stays a reference because each vendor shares one file
// namespace across its own protocols (Chat Completions and Responses use the
// same OpenAI file IDs; Messages has its own). The IR keeps the reference as
// stated and leaves portability to each pair.
//
// `media_type` is absent exactly when the source does not state one: OpenAI
// `file_data` is bare base64, while images always arrive with a type (a data
// URL upstream, or a typed base64 block in Messages and GenerateContent).
// Both OpenAI readers decode a `data:` URL into the base64 arm; raw base64
// remains untyped when no media type was stated. The `url` arm is a reference
// the target may fetch or forward.
export type IRInputMedia =
  | { readonly source_kind: 'url'; readonly url: string } // All
  | { readonly source_kind: 'base64'; readonly media_type?: string; readonly data: string } // All
  | { readonly source_kind: 'file'; readonly file_id: string }; // ChatCompletions, Responses, Messages

// Readable reasoning only. Signatures, encrypted blobs, redacted blocks, and
// opaque replay material are vendor-signed values with no cross-vendor
// meaning; the authenticated sidecar exists for exactly those, so they never
// enter the IR. `summary` and `content` stay separate even though most targets
// concatenate them, matching the output IR's decision.
//
// Chat Completions states reasoning only through provider-extension aliases
// with no wire contract, so its reader cannot identify one and yields no
// reasoning item. Its writer still emits `reasoning_text`, so reasoning
// produced by another protocol is not lost on that path. GenerateContent is
// the same in reverse: a source only, with no route targeting it.
export interface IRInputReasoningItem {
  readonly type: 'reasoning'; // Responses, Messages, GenerateContent; ChatCompletions as target
  // GenerateContent names its reasoning parts; Responses does not carry an id
  // through its reader, and no target requires one.
  readonly id?: string; // GenerateContent
  readonly summary?: readonly string[]; // Responses, GenerateContent, ChatCompletions; Messages as target
  readonly content?: readonly string[]; // Responses
}

export interface IRInputFunctionCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'function_call'; // All
  // A source that omits the id leaves it absent. A target whose wire correlates
  // results by id states the missing ones while writing.
  readonly call_id?: string; // All
  // JSON text, never a parsed object. Chat Completions and Responses carry
  // arguments as strings that may be malformed, and a reader that parsed them
  // would have to invent a wrapper for invalid JSON. Each target parses at its
  // own boundary with its own fallback, as the output IR's writers do.
  // Absent only when the source had no argument object at all, which is
  // distinct from an explicit `null` or `{}`.
  readonly arguments?: string; // All
}

export interface IRInputCustomToolCallItem extends Pick<IRInputToolSelector, 'name' | 'namespace'> {
  readonly type: 'custom_tool_call'; // ChatCompletions, Responses
  readonly call_id?: string; // ChatCompletions, Responses
  readonly input: string; // ChatCompletions, Responses
}

export interface IRInputToolResultItem {
  readonly type: 'tool_result'; // All
  // A result follows the call it answers: an absent id means it answers the
  // call still awaiting one, which the target's id filling resolves before
  // writing.
  readonly call_id?: string; // All
  // The function this result answers. A source whose wire correlates results
  // by name (GenerateContent) states it; a source that correlates by id does
  // not, because the id already names the call.
  readonly name?: string; // GenerateContent
  // A string is an opaque payload: a source string, or a structured result
  // that no protocol expresses as content parts (GenerateContent's
  // `functionResponse.response` object). Parts are used when the source itself
  // carries structured content, so Responses keeps images and files until the
  // target decides how to flatten them; Messages keeps images only and rejects
  // a file.
  readonly output: string | readonly IRInputToolResultContentPart[]; // All
  // A Chat Completions `tool` message does not say which call kind it answers;
  // only the preceding assistant message's `tool_calls` do. Readers record the
  // fact here so a Responses writer picks `custom_tool_call_output` over
  // `function_call_output` without re-deriving it from conversation position.
  readonly tool_kind?: 'function' | 'custom'; // ChatCompletions, Responses
  // Messages spells this as `is_error` and Responses as an incomplete output
  // status; Chat Completions and GenerateContent have no equivalent.
  readonly is_error?: boolean; // Messages, Responses
}

export type IRInputToolResultContentPart = IRInputTextPart | IRInputImagePart | IRInputFilePart;
