import type { Interceptor } from '@floway-dev/interceptor';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderModel, ProviderResponsesResult, ResponsesAction } from '@floway-dev/provider';

// Boundary ctx for Copilot Responses interceptors. See messages/types.ts for
// the boundary-isolation rationale. A single chain wraps both the streaming
// `/responses` call and the non-streaming synth-via-trigger compaction call;
// the chain terminal dispatches on `ctx.action` to pick the wire shape.
// `action` mirrors the gateway-side ResponsesInvocation.action — interceptors
// MAY mutate it during the chain to re-route dispatch in the terminal.
export interface ResponsesBoundaryCtx {
  payload: ResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  action: ResponsesAction;
}

// Single chain feeds both the streaming generate terminal and the compact
// terminal; the terminal switches on `ctx.action` and emits the matching
// ProviderResponsesResult variant. Pure payload/header mutators are written
// with a `<TResult>` generic so they fit; event-stream mutators (whitespace
// abort, output-item id sync) inspect the result variant and pass the value
// branch (compact envelope) through unchanged.
export type CopilotResponsesBoundaryInterceptor = Interceptor<
  ResponsesBoundaryCtx,
  object,
  ProviderResponsesResult
>;
