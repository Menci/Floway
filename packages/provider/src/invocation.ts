import type { UpstreamModel } from './model.ts';
import type { Fetcher } from './options.ts';
import type { ModelProviderInstance, ResponsesAction } from './provider.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

export type ChatTargetApi = 'messages' | 'responses' | 'chat-completions';

// One (provider, model) pair the resolver produced for an inbound id,
// plus the per-request `Fetcher` minted for the provider's upstream. The
// pair is the smallest unit the dispatch layer needs to make a wire call:
// `provider.provider.callXxx(model, body, ...)` — upstream id / upstream
// name / provider kind / capability flags come off `provider.*`, model id
// / providerData / endpoints off `model.*`.
//
// Resolution narrows by `model.kind` only — choosing the inbound target
// protocol from `model.endpoints` is the attempt layer's job, not part of
// the candidate.
export interface ProviderCandidate {
  readonly provider: ModelProviderInstance;
  readonly model: UpstreamModel;
  readonly fetcher: Fetcher;
}

// Per-protocol invocation shape passed to interceptors. Carries the
// source-shape request body (mutable, so the body can be cleaned), the
// candidate the attempt is dispatching against, the chat target protocol
// the attempt picked for this candidate, and a mutable `Headers` instance
// carried into the boundary chain — so workarounds that only need to set
// or drop a header stay at the owning interceptor boundary instead of
// widening the provider call signature.
export interface MessagesInvocation {
  payload: MessagesPayload;
  readonly candidate: ProviderCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface ResponsesInvocation {
  payload: ResponsesPayload;
  // Mutable action tag — interceptors can flip 'compact' to 'generate' so the
  // inner provider call runs a normal summarization turn (see the
  // responses-compact-shim) and the gateway derives snapshot mode from the
  // post-chain action carried on the provider's tagged result.
  action: ResponsesAction;
  readonly candidate: ProviderCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface ChatCompletionsInvocation {
  payload: ChatCompletionsPayload;
  readonly candidate: ProviderCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface GeminiInvocation {
  payload: GeminiPayload;
  readonly candidate: ProviderCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}
