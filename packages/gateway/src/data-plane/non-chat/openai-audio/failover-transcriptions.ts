import { defineStage } from '../../pipeline/facts.ts';
import { selectCandidate } from '../../pipeline/failover.ts';

export const failoverOpenAIAudioTranscriptions = defineStage({
  name: 'openaiAudioTranscriptions.failover',
  through: {
    request: { needs: ['candidates'], provides: ['upstream', 'model'], consumes: ['candidates'] },
    response: { needs: ['http', 'openaiAudioTranscriptions'], provides: ['candidate'], consumes: [] },
  },
  async execute({ candidates, ...facts }, scope) {
    return await selectCandidate(
      candidates,
      scope,
      ({ upstream, model }) => scope.next({ ...facts, upstream, model }),
      answer => answer.openaiAudioTranscriptions,
    );
  },
});
