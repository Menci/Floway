import type { InternalModel, ProviderModel } from './model.ts';
import type { Fetcher } from './options.ts';
import type { Provider, OpenAIResponsesAction } from './provider.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export type ChatTargetApi = 'anthropicMessages' | 'openaiResponses' | 'openaiChatCompletions';

// A resolver's live candidate belongs to services. Pipeline facts retain its identifier and
// portable model/rule content; the selected operation hands off into provider.pipelines.
export interface ModelCandidate {
  readonly provider: Provider;
  readonly model: InternalModel;
  readonly fetcher: Fetcher;
  readonly rules?: AliasRules;
}

// Alias rows must be expanded before selecting one upstream's catalog metadata.
export const providerModelOf = (candidate: ModelCandidate): ProviderModel => {
  const { model, provider } = candidate;
  if (model.providerModels === undefined) {
    throw new Error(`providerModelOf: model '${model.id}' is an alias row; the resolver should have expanded it to a target row before dispatch`);
  }
  const providerModel = model.providerModels[provider.upstreamId];
  if (providerModel === undefined) {
    throw new Error(`providerModelOf: model '${model.id}' has no providerModel for '${provider.upstreamId}'`);
  }
  return providerModel;
};

// Local planning views carry immutable payload content and live candidate/transport handles.
// Stages materialize their resulting payload, action and header lines into facts.
export interface AnthropicMessagesInvocation {
  payload: AnthropicMessagesPayload;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface OpenAIResponsesInvocation {
  payload: CanonicalOpenAIResponsesPayload;
  // Planning may choose a different dispatched action while preserving source intent.
  action: OpenAIResponsesAction;
  readonly candidate: ModelCandidate;
  readonly targetApi: ChatTargetApi;
  readonly headers: Headers;
}

export interface OpenAIChatCompletionsInvocation {
  payload: OpenAIChatCompletionsPayload;
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
