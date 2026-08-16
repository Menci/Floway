// OpenAI text completions (`POST /v1/completions`). The gateway carries this protocol end to
// end: what a client sends is parsed into `CompletionsPayload`, what an upstream answers is
// parsed into a `CompletionsResult` or a frame stream, and what the client receives is
// serialized back from those. No body is forwarded verbatim, so the shapes here are the
// protocol's own rather than a convenience view over bytes in flight.
//
// Request and response follow OpenAI's `CreateCompletionRequest` and
// `CreateCompletionResponse`, and the specification's own note on the latter is why there is
// no separate streaming envelope type below the chunk level — "both the streamed and the
// non-streamed response objects share the same shape (unlike the chat endpoint)":
// https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L33793-L34030
// https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L34031-L34149

// `model` is the one field the gateway itself reads structurally on the way in — routing is
// what needs it — and `stream` / `stream_options` are what decide the shape of the answer.
// The rest is named because the protocol names it, and is optional here because the upstream
// is what accepts or refuses a request: the specification also requires `prompt`, and an
// opinion about that held here would have to be kept in step with every OpenAI-compatible
// upstream we route to. The index signature carries a vendor extension through to the
// upstream that understands it.
export interface CompletionsPayload {
  model: string;
  prompt?: string | readonly string[] | readonly number[] | readonly (readonly number[])[] | null;
  best_of?: number | null;
  echo?: boolean | null;
  frequency_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  logprobs?: number | null;
  max_tokens?: number | null;
  n?: number | null;
  presence_penalty?: number | null;
  seed?: number | null;
  stop?: string | readonly string[] | null;
  stream?: boolean | null;
  stream_options?: CompletionsStreamOptions | null;
  suffix?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  user?: string | null;
  [key: string]: unknown;
}

// `/v1/completions` shares OpenAI's `ChatCompletionStreamOptions` with `/v1/chat/completions`,
// so `include_obfuscation` sits beside `include_usage` here as well:
// https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L31764-L31810
// The index signature is what lets the gateway turn `include_usage` on without dropping the
// siblings a client sent.
export interface CompletionsStreamOptions {
  include_usage?: boolean;
  include_obfuscation?: boolean;
  [key: string]: unknown;
}

// One choice in a streaming chunk. `text` accumulates across chunks (the
// streaming contract). The Zhipu/GLM vLLM fork seen in the wild emits a
// final placeholder choice carrying only `index` (no `text`, no
// `finish_reason`) alongside the usage block — so `text` and
// `finish_reason` are optional, matching that shape on the typed surface.
// `logprobs` is opaque to the gateway — carried through as-is.
interface CompletionsChoiceStreaming {
  index: number;
  text?: string;
  finish_reason?: string | null;
  logprobs?: unknown;
}

// OpenAI's `CompletionUsage`, which `/v1/completions` reuses verbatim from
// `/v1/chat/completions`:
// https://github.com/openai/openai-openapi/blob/2186421dca0cca7c1e67caa7739005e8b1ccc4dd/openapi.yaml#L32210-L32283
// The optional prompt-cache split is the part upstreams disagree about: OpenAI's own text
// models do not populate it today, while vLLM, llama.cpp, Fireworks, OpenRouter and xAI Grok
// all emit `cached_tokens` here on `/v1/completions`, and Azure mirrors the schema. Billing
// reads the split through `openAICacheTokensFromUsage`, which also knows the field names the
// wilder forks use, so what is named here is the schema rather than the union of the wild.
export interface CompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

// One streaming chunk on the wire. The final usage chunk (sent when
// `stream_options.include_usage` is on) carries the usage totals plus an
// empty or placeholder `choices` array; isOpenAIUsageOnlyEventShape (in
// protocols/common) detects that chunk shape without consulting the typed
// surface.
export interface CompletionsStreamEvent {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: CompletionsChoiceStreaming[];
  usage?: CompletionsUsage;
  system_fingerprint?: string;
}

export interface CompletionsChoice {
  index: number;
  text: string;
  finish_reason: string | null;
  logprobs?: unknown;
}

// `service_tier` is not in the specification's response schema — it belongs to the chat
// endpoint — but a vLLM fork was observed emitting it on the non-streaming
// `/v1/completions` body (null, on a Zhipu/GLM build) and billing reads it as the pricing
// tier when it is there, so it is named rather than left to the index signature.
export interface CompletionsResult {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: CompletionsChoice[];
  service_tier?: string | null;
  usage?: CompletionsUsage;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export { parseCompletionsPayload, parseCompletionsResult } from './parse.ts';
export { reassembleCompletionsEvents } from './reassemble.ts';
export { parseCompletionsStream, type ParseCompletionsStreamOptions } from './stream.ts';
export { completionsProtocolFrameToSSEFrame } from './to-sse.ts';
