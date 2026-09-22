// OpenAI text-completion protocol (POST /v1/completions). Floway runs
// this endpoint as a passthrough, so this module declares the
// protocol's wire shape rather than a read-time DTO: the gateway's
// /completions handler parses the inbound body through its own local
// shape and reads `model` / `stream` / `stream_options` directly. Only
// `model` is read structurally by downstream code (the provider
// interface accepts `Omit<OpenAICompletionsPayload, 'model'>` and forwards
// the rest unchanged); every other field flows through via the index
// signature.

export interface OpenAICompletionsPayload {
  model: string;
  [key: string]: unknown;
}

// One choice in a streaming chunk. `text` accumulates across chunks (the
// streaming contract). The Zhipu/GLM vLLM fork seen in the wild emits a
// final placeholder choice carrying only `index` (no `text`, no
// `finish_reason`) alongside the usage block — so `text` and
// `finish_reason` are optional, matching that shape on the typed surface.
// `logprobs` is opaque to the gateway — passed through as-is.
interface OpenAICompletionsChoiceStreaming {
  index: number;
  text?: string;
  finish_reason?: string | null;
  logprobs?: unknown;
}

export interface OpenAICompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // OpenAI's CompletionUsage schema (which /v1/completions reuses verbatim
  // from /v1/chat/completions) carries an optional prompt-cache split.
  // OpenAI's own text models do not populate it today, but vLLM, llama.cpp,
  // Fireworks, OpenRouter, and xAI Grok all emit `cached_tokens` here on
  // /v1/completions, and Azure mirrors the schema. Floway extracts it when
  // present so billing metrics match what the upstream actually reported.
  prompt_tokens_details?: { cached_tokens?: number };
}

// One streaming chunk on the wire. The final usage chunk (sent when
// `stream_options.include_usage` is on) carries the usage totals plus an
// empty or placeholder `choices` array; isOpenAIUsageOnlyEventShape (in
// protocols/common) detects that chunk shape without consulting the typed
// surface.
export interface OpenAICompletionsStreamEvent {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: OpenAICompletionsChoiceStreaming[];
  usage?: OpenAICompletionsUsage;
  system_fingerprint?: string;
}

export interface OpenAICompletionsChoice {
  index: number;
  text: string;
  finish_reason: string | null;
  logprobs?: unknown;
}

export interface OpenAICompletionsResult {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: OpenAICompletionsChoice[];
  usage?: OpenAICompletionsUsage;
  system_fingerprint?: string;
}

export { reassembleOpenAICompletionsEvents } from './reassemble.ts';
export { openaiCompletionsProtocolFrameToSSEFrame } from './to-sse.ts';
