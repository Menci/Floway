import { defineStage } from '../../pipeline/facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { chatgptPipelines } from '@floway-dev/upstream-chatgpt';
import { copilotPipelines } from '@floway-dev/upstream-copilot';
import { customPipelines } from '@floway-dev/upstream-custom';

export const openaiImagesGenerationsTargets = {
  azure: azurePipelines.openaiImagesGenerations,
  chatgpt: chatgptPipelines.openaiImagesGenerations,
  copilot: copilotPipelines.openaiImagesGenerations,
  custom: customPipelines.openaiImagesGenerations,
} as const;

const boundary = providerBoundary('openaiImagesGenerations');

export const openaiImagesGenerationsProvider = defineStage({
  name: 'openaiImagesGenerations.provider',
  request: { needs: ['http', 'upstream', 'model', 'openaiImagesGenerations'] },
  into: {
    azure: boundary,
    chatgpt: boundary,
    copilot: boundary,
    custom: boundary,
  },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    if (kind === 'azure' || kind === 'chatgpt' || kind === 'copilot' || kind === 'custom') return await scope.into[kind](facts);
    throw new Error(`The ${kind} upstream has no openaiImagesGenerations pipeline`);
  },
});
