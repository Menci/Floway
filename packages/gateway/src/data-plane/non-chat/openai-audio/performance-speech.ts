import { defineStage } from '../../pipeline/facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureOpenAIAudioSpeechPerformance = defineStage({
  name: 'openaiAudioSpeech.performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['openaiAudioSpeech', 'usage'], provides: ['openaiAudioSpeech', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const measured = observePerformance(scope, answer.openaiAudioSpeech, answer.usage, {
      operation: 'audio_speech',
      upstream: facts.upstream.id,
      model: facts.model.id,
    });
    return { ...answer, openaiAudioSpeech: measured.outcome, usage: measured.usage };
  },
});
