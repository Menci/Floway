import { defineStage } from '../../pipeline/facts.ts';
import { observePerformance } from '../../pipeline/performance.ts';

export const measureOpenAIAudioTranscriptionsPerformance = defineStage({
  name: 'openaiAudioTranscriptions.performance',
  through: {
    request: { needs: ['upstream', 'model'], provides: [], consumes: [] },
    response: { needs: ['openaiAudioTranscriptions', 'usage'], provides: ['openaiAudioTranscriptions', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const measured = observePerformance(scope, answer.openaiAudioTranscriptions, answer.usage, {
      operation: 'audio_transcription',
      upstream: facts.upstream.id,
      model: facts.model.id,
    });
    return { ...answer, openaiAudioTranscriptions: measured.outcome, usage: measured.usage };
  },
});
