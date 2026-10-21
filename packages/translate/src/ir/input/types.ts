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
// sidecar resolves to the source protocol's native turn bypasses this IR
// entirely. The other two are the types below:
//
//     A user turn      -> IRInputUserTurn      -> B user turn
//     A assistant turn -> IRInputAssistantTurn -> B assistant turn
//
// A request arrives complete, so this IR is a plain value: no paths, no
// lifecycle events, no accumulation. That is the whole structural difference
// from the stream IR; the Fit boundary is identical.
//
// The request envelope: everything about a request that is not its
// conversation. Tool declarations are not here yet, because `allowed_tools`
// selectors reference them and the two must enter together.
export interface IRInputEnvelope {
  readonly model: string; // All
  readonly sampling?: IRInputSampling; // All
  readonly output_format?: IRInputOutputFormat; // ChatCompletions, Responses, Messages, GenerateContent
}

// Every sampling knob that more than one protocol expresses. A target that
// cannot carry one drops it; a target that can carries it verbatim.
export interface IRInputSampling {
  readonly temperature?: number; // All
  readonly top_p?: number; // All
  readonly top_k?: number; // Messages, GenerateContent
  readonly stop?: readonly string[]; // All
  readonly seed?: number; // ChatCompletions, GenerateContent
  readonly max_output_tokens?: IRInputMaxOutputTokens; // All
}

// One ceiling, spelled three ways. `max_tokens` predates reasoning models and
// counts only visible output; `max_completion_tokens` is its documented alias
// that also counts hidden reasoning tokens, so a request may carry either and
// they are not interchangeable. Responses states the same ceiling once as
// `max_output_tokens`.
//
// A source that states more than one of them is kept as stated: some upstreams
// reject a request carrying both, so the choice of which one to forward belongs
// to the target writer rather than to the reader.
export interface IRInputMaxOutputTokens {
  readonly max_tokens?: number; // ChatCompletions, Messages, GenerateContent
  readonly max_completion_tokens?: number; // ChatCompletions
  readonly max_output_tokens?: number; // Responses
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

export interface IRInputConversation {
  readonly turns: readonly IRInputTurn[];
}

// A turn is a maximal run of one branch class, not a protocol's message
// grouping. Chat Completions makes every message its own turn; the others
// merge adjacent messages of the same class. Writers regroup the flat item
// list into whatever boundaries their protocol uses, so the source grouping
// never constrains them.
export type IRInputTurn = IRInputUserTurn | IRInputAssistantTurn;

// Client-produced input. The branch is named `user` because the sidecar branch
// selects on assistant-versus-not; the items inside keep their real roles,
// so system, developer, and tool results live here too.
export interface IRInputUserTurn {
  readonly role: 'user';
  readonly items: readonly IRInputUserItem[];
}

export interface IRInputAssistantTurn {
  readonly role: 'assistant';
  readonly items: readonly IRInputAssistantItem[];
}

// Items stay flat and ordered because protocols disagree about where a message
// boundary sits: Messages keeps tool results inside a user message, Chat
// Completions gives them a `tool` message, Responses makes them an input item,
// and GenerateContent makes them a part of a user content. Keeping a source
// message's own parts together while tool results and tool calls remain
// separate items lets every writer reproduce its own grouping without this IR
// prejudging one protocol's shape.
export type IRInputUserItem = IRInputSystemMessageItem | IRInputUserMessageItem | IRInputToolResultItem;

export type IRInputAssistantItem =
  | IRInputAssistantMessageItem
  | IRInputReasoningItem
  | IRInputFunctionCallItem
  | IRInputCustomToolCallItem;

// A leading system run represents both Responses `instructions` and
// GenerateContent `systemInstruction`, so no placement field is needed:
// position carries the placement and each writer applies its own hoisting rule.
// Readers lift those envelope fields into the leading item; Messages' top-level
// `system` becomes a leading item the same way. Responses keeps later
// system/developer messages inline, Chat Completions forwards them as
// developer/system messages, and Messages has an inline system role.
export interface IRInputSystemMessageItem {
  readonly type: 'message'; // ChatCompletions, Responses, Messages
  readonly role: 'system' | 'developer'; // ChatCompletions, Responses; Messages has `system` only
  // Text only: no pair carries media in system or developer content. Messages
  // and Chat Completions accept text there, and every route rejects anything
  // else at the target boundary rather than silently dropping it.
  readonly content: readonly IRInputTextPart[]; // ChatCompletions, Responses, Messages
}

export interface IRInputUserMessageItem {
  readonly type: 'message'; // All
  readonly role: 'user'; // All
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
  | IRInputRefusalPart
  | IRInputImagePart
  | IRInputFilePart
  | IRInputAudioPart;

export type IRInputAssistantContentPart = IRInputTextPart | IRInputRefusalPart;

export interface IRInputTextPart {
  readonly type: 'text'; // All
  readonly text: string; // All
}

// Chat Completions and Responses both carry refusals as a distinct content
// kind, on assistant content and (on the Chat Completions wire) on user content
// as well. Messages and GenerateContent have no such block; their writers
// project assistant refusals to text and reject user refusals, which is what
// the routes do today.
export interface IRInputRefusalPart {
  readonly type: 'refusal'; // ChatCompletions, Responses
  readonly refusal: string; // ChatCompletions, Responses
}

export interface IRInputImagePart {
  readonly type: 'image'; // All
  readonly image: IRInputMedia; // All
  // Chat Completions and Responses share the `auto | low | high | original`
  // axis; Messages has no per-image detail. Open string because both wire
  // contracts already forward unknown values verbatim.
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
// same OpenAI file IDs; Messages has its own). A pair that crosses vendors must
// not treat the ID as portable, and that policy stays with the pair.
//
// `media_type` is absent exactly when the source does not state one: OpenAI
// `file_data` is bare base64, while images always arrive with a type (a data
// URL upstream, or a typed base64 block in Messages and GenerateContent).
// A reader decodes a `data:` URL into the base64 arm: inline bytes are one
// concept regardless of how a protocol spells them, and the `url` arm means a
// reference a target may fetch or forward.
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
// Chat Completions is a target here but not a source: its reasoning text
// aliases are provider extensions with no wire contract, so its reader cannot
// identify one and produces no reasoning item, matching the current
// bare-translation behavior. Its writer emits `reasoning_text`, the alias the
// gateway already chose for translated output, so reasoning is not lost on that
// path. GenerateContent, conversely, is a source only: no route targets it.
export interface IRInputReasoningItem {
  readonly type: 'reasoning'; // Responses, Messages, GenerateContent; ChatCompletions as target
  // A source that names its reasoning items keeps the name; a source that does
  // not leaves it absent and each writer allocates one.
  readonly id?: string; // Responses, GenerateContent
  readonly summary?: readonly string[]; // Responses, GenerateContent, ChatCompletions; Messages as target
  readonly content?: readonly string[]; // Responses
}

export interface IRInputFunctionCallItem {
  readonly type: 'function_call'; // All
  // Required even though GenerateContent may omit `functionCall.id`: a reader
  // synthesizes a deterministic ID so a tool result can correlate, which is
  // what the routes already do.
  readonly call_id: string; // All
  readonly name: string; // All
  // JSON text, never a parsed object. Chat Completions and Responses carry
  // arguments as strings that may be malformed, and a reader that parsed them
  // would have to invent a wrapper for invalid JSON. Each target parses at its
  // own boundary with its own fallback, as the output IR's writers do.
  // Absent only when the source had no argument object at all, which is
  // distinct from an explicit `null` or `{}`.
  readonly arguments?: string; // All
}

export interface IRInputCustomToolCallItem {
  readonly type: 'custom_tool_call'; // ChatCompletions, Responses
  readonly call_id: string; // ChatCompletions, Responses
  readonly name: string; // ChatCompletions, Responses
  readonly input: string; // ChatCompletions, Responses
}

// No `name` field: Chat Completions, Responses, and Messages all correlate a
// result to its call by ID, and GenerateContent is not a translation target.
// A future GenerateContent writer derives `functionResponse.name` from the call
// carrying the same ID; an orphan result then fails loudly instead of guessing.
export interface IRInputToolResultItem {
  readonly type: 'tool_result'; // All
  readonly call_id: string; // All
  // A string is an opaque payload: a source string, or a structured result
  // that no protocol expresses as content parts (GenerateContent's
  // `functionResponse.response` object). Parts are used when the source itself
  // carries structured content, so Responses and Messages outputs keep their
  // images and files until the target decides how to flatten them.
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
