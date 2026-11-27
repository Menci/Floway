import type { UpstreamModel } from './model.ts';
import type { Fetcher } from './options.ts';
import type { Upstream, OpenAIResponsesAction } from './upstream.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export type ChatTargetApi = 'anthropicMessages' | 'geminiGenerateContent' | 'openaiResponses' | 'openaiChatCompletions';

// One resolved (upstream, model) dispatch unit plus the per-request `Fetcher`
// minted for that upstream. Resolution narrows by `model.kind` only; choosing
// the target protocol from `model.endpoints` belongs to the attempt layer.
//
// `rules` is set only for alias-origin candidates (present, possibly `{}`),
// carrying the picked target's rule overlay for the terminal wire call.
export interface ModelCandidate {
  readonly upstream: Upstream;
  readonly model: UpstreamModel;
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
