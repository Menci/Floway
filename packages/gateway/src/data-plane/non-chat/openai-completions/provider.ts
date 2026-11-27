import { defineStage } from '../../pipeline/facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { customPipelines } from '@floway-dev/upstream-custom';
import { ollamaPipelines } from '@floway-dev/upstream-ollama';

export const openaiCompletionsTargets = {
  azure: azurePipelines.openaiCompletions,
  custom: customPipelines.openaiCompletions,
  ollama: ollamaPipelines.openaiCompletions,
} as const;

const boundary = providerBoundary('openaiCompletions');

export const openaiCompletionsProvider = defineStage({
  name: 'openaiCompletions.provider',
  request: { needs: ['http', 'upstream', 'model', 'openaiCompletions'] },
  into: {
    azure: boundary,
    custom: boundary,
    ollama: boundary,
  },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    if (kind === 'azure' || kind === 'custom' || kind === 'ollama') return await scope.into[kind](facts);
    throw new Error(`The ${kind} upstream has no openaiCompletions pipeline`);
  },
});
