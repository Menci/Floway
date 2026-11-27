import { defineStage } from './facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { customPipelines } from '@floway-dev/upstream-custom';

const gemini = providerBoundary('geminiGenerateContentCountTokens');

export const geminiGenerateContentCountTokensTargets = { custom: customPipelines.geminiGenerateContentCountTokens };

export const routeGeminiGenerateContentCountTokensProvider = defineStage({
  name: 'geminiGenerateContentCountTokens.provider',
  request: { needs: gemini.request.needs },
  into: { custom: gemini },
  async execute(facts, scope) {
    if (facts.upstream.kind !== 'custom') throw new Error(`The ${facts.upstream.kind} upstream has no Gemini countTokens pipeline`);
    return await scope.into.custom(facts);
  },
});
