import type { InternalModel, ProviderModel } from './model.ts';
import type { Fetcher } from './options.ts';
import type { Provider } from './provider.ts';
import type { AliasRules } from '@floway-dev/protocols/common';

export type ChatTargetApi = 'anthropicMessages' | 'geminiGenerateContent' | 'openaiResponses' | 'openaiChatCompletions';

export interface ModelCandidate {
  readonly provider: Provider;
  readonly model: InternalModel;
  readonly fetcher: Fetcher;
  readonly rules?: AliasRules;
}

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
