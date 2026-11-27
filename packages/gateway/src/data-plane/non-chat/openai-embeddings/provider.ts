import { defineStage } from '../../pipeline/facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { copilotPipelines } from '@floway-dev/upstream-copilot';
import { customPipelines } from '@floway-dev/upstream-custom';
import { ollamaPipelines } from '@floway-dev/upstream-ollama';

export const openaiEmbeddingsTargets = {
  azure: azurePipelines.openaiEmbeddings,
  copilot: copilotPipelines.openaiEmbeddings,
  custom: customPipelines.openaiEmbeddings,
  ollama: ollamaPipelines.openaiEmbeddings,
} as const;

const boundary = providerBoundary('openaiEmbeddings');

export const openaiEmbeddingsProvider = defineStage({
  name: 'openaiEmbeddings.provider',
  request: { needs: ['http', 'upstream', 'model', 'openaiEmbeddings'] },
  into: {
    azure: boundary,
    copilot: boundary,
    custom: boundary,
    ollama: boundary,
  },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    if (kind === 'azure' || kind === 'copilot' || kind === 'custom' || kind === 'ollama') return await scope.into[kind](facts);
    throw new Error(`The ${kind} upstream has no openaiEmbeddings pipeline`);
  },
});
