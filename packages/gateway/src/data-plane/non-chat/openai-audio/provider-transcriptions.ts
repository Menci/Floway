import { defineStage } from '../../pipeline/facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { azurePipelines } from '@floway-dev/upstream-azure';
import { customPipelines } from '@floway-dev/upstream-custom';
import { ollamaPipelines } from '@floway-dev/upstream-ollama';

export const openaiAudioTranscriptionsTargets = {
  azure: azurePipelines.openaiAudioTranscriptions,
  custom: customPipelines.openaiAudioTranscriptions,
  ollama: ollamaPipelines.openaiAudioTranscriptions,
} as const;

const boundary = providerBoundary('openaiAudioTranscriptions');

export const openaiAudioTranscriptionsProvider = defineStage({
  name: 'openaiAudioTranscriptions.provider',
  request: { needs: ['http', 'upstream', 'model', 'openaiAudioTranscriptions'] },
  into: {
    azure: boundary,
    custom: boundary,
    ollama: boundary,
  },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    if (kind === 'azure' || kind === 'custom' || kind === 'ollama') return await scope.into[kind](facts);
    throw new Error(`The ${kind} upstream has no openaiAudioTranscriptions pipeline`);
  },
});
