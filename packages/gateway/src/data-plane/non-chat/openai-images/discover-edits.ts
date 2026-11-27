import { openaiImagesEditsTargets } from './provider-edits.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { localHead, openAIError } from '../shared/http.ts';
import { unavailableModel } from '../shared/routing.ts';

const endpoint = '/images/edits';

export const discoverOpenAIImagesEdits = defineStage({
  name: 'openaiImagesEdits.discover',
  through: {
    request: { needs: ['serve.startedAt', 'openaiImagesEdits', 'requestedModel'], provides: ['candidates'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiImagesEdits'] },
  async execute(facts, scope) {
    const payload = facts.openaiImagesEdits;
    const model = facts.requestedModel;
    const { candidates, exists } = await discoverCandidates(scope.services, {
      model,
      kind: 'image',
      payload,
      supports: candidate => candidate.model.endpoints.openaiImagesEdits !== undefined
        && Object.hasOwn(openaiImagesEditsTargets, candidate.upstream.kind),
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });
    return {
      http: localHead(exists ? 400 : 404),
      openaiImagesEdits: { kind: 'error', source: 'local', error: openAIError(unavailableModel(model, endpoint, exists)) },
    };
  },
});
