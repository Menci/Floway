import { defineStage } from '../../pipeline/facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { chatgptPipelines } from '@floway-dev/upstream-chatgpt';
import { copilotPipelines } from '@floway-dev/upstream-copilot';
import { customPipelines } from '@floway-dev/upstream-custom';

export const openaiImagesEditsTargets = {
  azure: azurePipelines.openaiImagesEdits,
  chatgpt: chatgptPipelines.openaiImagesEdits,
  copilot: copilotPipelines.openaiImagesEdits,
  custom: customPipelines.openaiImagesEdits,
} as const;

const boundary = providerBoundary('openaiImagesEdits');

export const openaiImagesEditsProvider = defineStage({
  name: 'openaiImagesEdits.provider',
  request: { needs: ['http', 'upstream', 'model', 'openaiImagesEdits'] },
  into: {
    azure: boundary,
    chatgpt: boundary,
    copilot: boundary,
    custom: boundary,
  },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    if (kind === 'azure' || kind === 'chatgpt' || kind === 'copilot' || kind === 'custom') return await scope.into[kind](facts);
    throw new Error(`The ${kind} upstream has no openaiImagesEdits pipeline`);
  },
});
