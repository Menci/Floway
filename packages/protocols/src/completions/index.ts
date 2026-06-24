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
// streaming contract), `finish_reason` is null until the final chunk for
// the choice. `logprobs` is opaque to the gateway — passed through as-is.
export interface CompletionsChoiceStreaming {
  index: number;
  text: string;
  finish_reason: string | null;
  logprobs?: unknown;
}

export interface CompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// One streaming chunk on the wire. The final usage-only chunk (sent when
// `stream_options.include_usage` is on) carries an empty `choices` array
// plus `usage`; isOpenAIUsageOnlyEventShape (in protocols/common) detects
// this shape without consulting the typed surface.
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
