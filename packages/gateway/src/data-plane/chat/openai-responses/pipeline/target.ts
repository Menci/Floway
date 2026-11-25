import type { ServeCandidate } from '../../../pipeline/facts.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';

const generationTargets = ['openaiResponses', 'anthropicMessages', 'openaiChatCompletions'] as const;

export const openAIResponsesTargetFor = ({ upstream, model }: ServeCandidate) =>
  generationTargets.find(target => model.endpoints[target] !== undefined && providerSupportsOperation(upstream.kind, target));

export const servesOpenAIResponses = (candidate: ServeCandidate): boolean =>
  openAIResponsesTargetFor(candidate) !== undefined;
