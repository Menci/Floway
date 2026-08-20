import type { Interceptor } from '@floway-dev/interceptor';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel, ProviderOpenAIResponsesResult, OpenAIResponsesAction } from '@floway-dev/provider';

// Boundary ctx for Copilot OpenAI Responses interceptors. See anthropic-messages/types.ts for
// the boundary-isolation rationale. A single chain wraps both the streaming
// `/responses` call and the non-streaming synth-via-trigger compaction call;
// the chain terminal dispatches on `ctx.action` to pick the wire shape.
// `action` mirrors the gateway-side OpenAIResponsesInvocation.action — interceptors
// MAY mutate it during the chain to re-route dispatch in the terminal.
export interface OpenAIResponsesBoundaryCtx {
  payload: CanonicalOpenAIResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  action: OpenAIResponsesAction;
}

// Single chain feeds both the streaming generate terminal and the compact
// terminal; the terminal switches on `ctx.action` and emits the matching
// ProviderOpenAIResponsesResult variant. Pure payload/header mutators are written
// with a `<TResult>` generic so they fit; event-stream mutators (whitespace
// abort, item-id membrane) inspect the result variant directly.
export type CopilotOpenAIResponsesBoundaryInterceptor = Interceptor<
  OpenAIResponsesBoundaryCtx,
  ProviderOpenAIResponsesResult
>;
