import { openaiEmbeddingsTargets } from './provider.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { localHead, openAIError } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';

const endpoint = '/embeddings';

export const discoverOpenAIEmbeddings = defineStage({
  name: 'openaiEmbeddings.discover',
  through: {
    request: { needs: ['serve.startedAt', 'openaiEmbeddings'], provides: ['candidates'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiEmbeddings'] },
  async execute(facts, scope) {
    const payload = facts.openaiEmbeddings;
    const model = payload.model;
    const { candidates, exists } = await discoverCandidates(scope.services, {
      model,
      kind: 'embedding',
      payload,
      supports: candidate => candidate.model.endpoints.openaiEmbeddings !== undefined
        && Object.hasOwn(openaiEmbeddingsTargets, candidate.upstream.kind),
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });
    return {
      http: localHead(exists ? 400 : 404),
      openaiEmbeddings: { kind: 'error', source: 'local', error: openAIError(unavailableModel(model, endpoint, exists)) },
    };
  },
});
