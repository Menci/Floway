import type { InternalModel, ProviderModel } from './model.ts';
import type { Fetcher } from './options.ts';
import type { Provider, ResponsesAction } from './provider.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

export type ChatTargetApi = 'messages' | 'responses' | 'chat-completions';

// One (provider, model) pair the resolver produced for an inbound id,
// plus the per-request `Fetcher` minted for the provider's upstream. The
// pair is the smallest unit the dispatch layer needs to make a wire call:
// `provider.instance.callXxx(providerModelOf(candidate), body, ...)` —
// upstream id / upstream name / provider kind / capability flags come off
// `provider.*`, the merged public metadata (id, endpoints, limits, ...) off
// `model.*`, and the per-upstream `ProviderModel` (providerData,
// enabledFlags) off `providerModelOf(candidate)`.
//
// Resolution narrows by `model.kind` only — choosing the inbound target
// protocol from `model.endpoints` is the attempt layer's job, not part of
// the candidate.
//
// `rules` is set only for candidates minted by the alias walk — it carries
// the picked target's rule overlay so the attempt's terminal wire call can
// apply it against the target IR. Absent (undefined) for direct-resolution
// candidates, present (possibly `{}`) for alias-origin candidates; the two
// values together also mark the candidate as needing a `payload.model`
// rewrite before dispatch.
export interface ModelCandidate {
  readonly provider: Provider;
  readonly model: InternalModel;
  readonly fetcher: Fetcher;
  readonly rules?: AliasRules;
}

// Pull the emitting upstream's `ProviderModel` off the candidate. Dispatch
// hands this to the provider's `callXxx`; interceptor gates read
// `.enabledFlags`, boundary shims read `.providerData`, etc. The candidate
// always names exactly one upstream via `provider.upstream`; for real-row
// candidates the resolver populates `model.providerModels` with an entry
// under that key at candidate-creation time.
//
// Two error paths, distinguished so a caller reading the message can tell
// which invariant broke: an alias row was mistakenly used as a dispatch
// target (the resolver should have expanded it to its target's real row
// first), or a real row is missing the entry for the candidate's upstream
// (the candidate was assembled outside the resolver, or the row was merged
// after the upstream stopped contributing).
export const providerModelOf = (candidate: ModelCandidate): ProviderModel => {
  const { model, provider } = candidate;
  if (model.providerModels === undefined) {
    throw new Error(`providerModelOf: model '${model.id}' is an alias row; the resolver should have expanded it to a target row before dispatch`);
  }
  const providerModel = model.providerModels[provider.upstream];
  if (providerModel === undefined) {
    throw new Error(`providerModelOf: model '${model.id}' has no providerModel for '${provider.upstream}'`);
  }
  return providerModel;
};

// Per-protocol invocation shape passed to interceptors. Carries the
// source-shape request body (mutable, so the body can be cleaned), the
// candidate the attempt is dispatching against, the chat target protocol
// the attempt picked for this candidate, and a mutable `Headers` instance
// carried into the boundary chain — so workarounds that only need to set
// or drop a header stay at the owning interceptor boundary instead of
// widening the provider call signature.
export interface MessagesInvocation {
  payload: MessagesPayload;
  readonly candidate: ModelCandidate;
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
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface ChatCompletionsInvocation {
  payload: ChatCompletionsPayload;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface GeminiInvocation {
  payload: GeminiPayload;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}
