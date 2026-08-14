import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, ProviderModel } from '@floway-dev/provider';

// Boundary ctx for Copilot Messages interceptors. The chain runs inside
// `provider.callMessages` after the gateway has handed control to the
// provider, so the gateway main flow no longer needs to know that Copilot
// has interceptors at all.
//
// `payload` is the source-shape body with `model` re-attached so interceptors
// that read the public model id (e.g. claude-opus-4-8 carve-outs) keep
// working unchanged; the terminal strips it before serializing to the wire.
// `headers` carries the provider's ordinary admitted headers.
// Parsed `anthropic-beta` tokens arrive through the typed Messages call
// contract and are copied into `anthropicBeta` so variant selection and
// interceptors share one token list. The terminal serializes the normalized
// list back onto a fresh wire-header bag.
export interface MessagesBoundaryCtx {
  payload: MessagesPayload;
  headers: Headers;
  anthropicBeta: string[];
  readonly model: ProviderModel;
}

export type CopilotMessagesBoundaryInterceptor = Interceptor<
  MessagesBoundaryCtx,
  object,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>;

// count_tokens is a one-shot, non-streaming HTTP exchange: the terminal
// returns the raw upstream `Response` directly. Pure header/payload mutators
// only — post-`run()` event-stream inspection is not portable to this result.
export type CopilotMessagesCountTokensBoundaryInterceptor = Interceptor<
  MessagesBoundaryCtx,
  object,
  Response
>;
