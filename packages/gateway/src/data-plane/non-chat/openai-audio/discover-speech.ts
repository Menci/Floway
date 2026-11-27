import { openaiAudioSpeechTargets } from './provider-speech.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { localHead, openAIError } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';

const endpoint = '/audio/speech';

export const discoverOpenAIAudioSpeech = defineStage({
  name: 'openaiAudioSpeech.discover',
  through: {
    request: { needs: ['serve.startedAt', 'openaiAudioSpeech'], provides: ['candidates'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiAudioSpeech'] },
  async execute(facts, scope) {
    const payload = facts.openaiAudioSpeech;
    const model = payload.model;
    const { candidates, exists } = await discoverCandidates(scope.services, {
      model,
      kind: 'speech',
      payload,
      supports: candidate => candidate.model.endpoints.openaiAudioSpeech !== undefined
        && Object.hasOwn(openaiAudioSpeechTargets, candidate.upstream.kind),
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });
    return {
      http: localHead(exists ? 400 : 404),
      openaiAudioSpeech: { kind: 'error', source: 'local', error: openAIError(unavailableModel(model, endpoint, exists)) },
    };
  },
});
