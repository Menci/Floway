import { openaiAudioTranscriptionsTargets } from './provider-transcriptions.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { localHead, openAIError } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';

const endpoint = '/audio/transcriptions';

export const discoverOpenAIAudioTranscriptions = defineStage({
  name: 'openaiAudioTranscriptions.discover',
  through: {
    request: { needs: ['serve.startedAt', 'openaiAudioTranscriptions', 'requestedModel'], provides: ['candidates'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiAudioTranscriptions'] },
  async execute(facts, scope) {
    const payload = facts.openaiAudioTranscriptions;
    const model = facts.requestedModel;
    const { candidates, exists } = await discoverCandidates(scope.services, {
      model,
      kind: 'transcription',
      payload,
      supports: candidate => candidate.model.endpoints.openaiAudioTranscriptions !== undefined
        && Object.hasOwn(openaiAudioTranscriptionsTargets, candidate.upstream.kind),
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });
    return {
      http: localHead(exists ? 400 : 404),
      openaiAudioTranscriptions: { kind: 'error', source: 'local', error: openAIError(unavailableModel(model, endpoint, exists)) },
    };
  },
});
