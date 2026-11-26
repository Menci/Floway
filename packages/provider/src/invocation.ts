import type { ProviderModel } from './model.ts';
import type { Fetcher } from './options.ts';
import type { Provider, OpenAIResponsesAction } from './provider.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export type ChatTargetApi = 'anthropicMessages' | 'geminiGenerateContent' | 'openaiResponses' | 'openaiChatCompletions';

// One (provider, model) pair the resolver produced for an inbound id,
// plus the per-request `Fetcher` minted for the provider's upstream. The
// pair is the smallest unit the dispatch layer needs to make a wire call:
// `provider.instance.callXxx(candidate.model, body, ...)` — upstream id /
// upstream name / provider kind / allowlist come off `provider.*`, and both
// public metadata (id, endpoints, limits, pricing, chat) and provider-specific
// invocation fields (upstreamModelId, providerData, enabledFlags) live directly
// on `candidate.model`.
//
// Resolution narrows by `model.kind` only — choosing the inbound target
// protocol from `model.endpoints` is the attempt layer's job, not part of
// the candidate.
//
// `rules` is set only for candidates minted by the alias walk — it carries
// the picked target's rule overlay so the attempt's terminal wire call can
// apply it against the target IR. Absent (undefined) for direct-resolution
// candidates and present (possibly `{}`) for alias-origin candidates.
export interface ModelCandidate {
  readonly provider: Provider;
  readonly model: ProviderModel;
  readonly fetcher: Fetcher;
  readonly rules?: AliasRules;
}

// Per-protocol invocation shape passed to interceptors. Carries the
// source-shape request body (mutable, so the body can be cleaned), the
// candidate the attempt is dispatching against, the chat target protocol
// the attempt picked for this candidate, and a mutable `Headers` instance
// carried into the boundary chain — so workarounds that only need to set
// or drop a header stay at the owning interceptor boundary instead of
// widening the provider call signature. `anthropicBeta` is the typed
// `anthropic-beta` flag set (mutable, so an interceptor can drop a flag the
// selected upstream must not see) handed to the native Anthropic Messages call.
export interface AnthropicMessagesInvocation {
  payload: AnthropicMessagesPayload;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
  anthropicBeta: readonly string[];
}

export interface OpenAIResponsesInvocation {
  payload: CanonicalOpenAIResponsesPayload;
  // Mutable action tag — interceptors can flip 'compact' to 'generate' so the
  // inner provider call runs a normal summarization turn (see the
  // openai-responses-compact-shim) and the gateway derives snapshot mode from the
  // post-chain action carried on the provider's tagged result.
  action: OpenAIResponsesAction;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface OpenAIChatCompletionsInvocation {
  payload: OpenAIChatCompletionsPayloadEx;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface GeminiGenerateContentInvocation {
  payload: GeminiGenerateContentPayload;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}
