// OpenAI text-completion protocol (POST /v1/completions). Floway runs
// this endpoint as a passthrough — there is no translation to or from the
// other LLM protocols, no shared interceptor chain, and no per-event shape
// the gateway depends on beyond the OpenAI streaming envelope. The payload
// type below is the gateway's read-only view of the client's request so the
// `/completions` handler can route on `model` and react to `stream` /
// `stream_options.include_usage` without parsing manually. The trailing
// index signature lets every other client-side field flow through to the
// upstream without a code change here.

export interface CompletionsPayload {
  model: string;
  stream?: boolean | null;
  stream_options?: { include_usage?: boolean } | null;
  [key: string]: unknown;
}

// One choice in a streaming chunk. `text` accumulates across chunks (the
// streaming contract). The Zhipu/GLM vLLM fork seen in the wild emits a
// final placeholder choice carrying only `index` (no `text`, no
// `finish_reason`) alongside the usage block — so `text` and
// `finish_reason` are optional, matching that shape on the typed surface.
// `logprobs` is opaque to the gateway — passed through as-is.
export interface CompletionsChoiceStreaming {
  index: number;
  text?: string;
  finish_reason?: string | null;
  logprobs?: unknown;
}

export interface CompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // OpenAI's CompletionUsage schema (which /v1/completions reuses verbatim
  // from /v1/chat/completions) carries an optional prompt-cache split.
  // OpenAI's own text models do not populate it today, but vLLM, llama.cpp,
  // Fireworks, OpenRouter, and xAI Grok all emit `cached_tokens` here on
  // /v1/completions, and Azure mirrors the schema. Floway extracts it when
  // present so billing dimensions match what the upstream actually reported.
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

// Reassembled single-shot result. Mirrors what OpenAI returns from a
// non-streaming /v1/completions call. The dashboard's dump renderer uses
// this to fold the captured frame log back into a human-readable view.
export interface CompletionsChoice {
  index: number;
  text: string;
  finish_reason: string | null;
  logprobs?: unknown;
}

export interface CompletionsResult {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: CompletionsChoice[];
  usage?: CompletionsUsage;
  system_fingerprint?: string;
}

export { reassembleCompletionsEvents } from './reassemble.ts';
export { completionsProtocolFrameToSSEFrame } from './to-sse.ts';
