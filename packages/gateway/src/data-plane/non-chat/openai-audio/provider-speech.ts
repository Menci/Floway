import { defineStage } from '../../pipeline/facts.ts';
import { providerBoundary } from '../shared/routing.ts';
import { customPipelines } from '@floway-dev/upstream-custom';

export const openaiAudioSpeechTargets = {
  custom: customPipelines.openaiAudioSpeech,
} as const;

const boundary = providerBoundary('openaiAudioSpeech');

export const openaiAudioSpeechProvider = defineStage({
  name: 'openaiAudioSpeech.provider',
  request: { needs: ['http', 'upstream', 'model', 'openaiAudioSpeech'] },
  into: {
    custom: boundary,
  },
  async execute(facts, scope) {
    const { kind } = facts.upstream;
    if (kind === 'custom') return await scope.into[kind](facts);
    throw new Error(`The ${kind} upstream has no openaiAudioSpeech pipeline`);
  },
});
