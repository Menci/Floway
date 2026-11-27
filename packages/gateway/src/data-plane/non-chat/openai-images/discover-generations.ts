import { openaiImagesGenerationsTargets } from './provider-generations.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { localHead, openAIError } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';

const endpoint = '/images/generations';

export const discoverOpenAIImagesGenerations = defineStage({
  name: 'openaiImagesGenerations.discover',
  through: {
    request: { needs: ['serve.startedAt', 'openaiImagesGenerations'], provides: ['candidates'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiImagesGenerations'] },
  async execute(facts, scope) {
    const payload = facts.openaiImagesGenerations;
    const model = payload.model;
    const { candidates, exists } = await discoverCandidates(scope.services, {
      model,
      kind: 'image',
      payload,
      supports: candidate => candidate.model.endpoints.openaiImagesGenerations !== undefined
        && Object.hasOwn(openaiImagesGenerationsTargets, candidate.upstream.kind),
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });
    return {
      http: localHead(exists ? 400 : 404),
      openaiImagesGenerations: { kind: 'error', source: 'local', error: openAIError(unavailableModel(model, endpoint, exists)) },
    };
  },
});
