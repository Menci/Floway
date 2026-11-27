import { defineStage } from './facts.ts';
import { targets } from './provider.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { localHead, openAIError } from '../shared/http.ts';

export const discover = defineStage({
  name: 'decision.discover-candidates',
  through: {
    request: { needs: ['decision', 'requestedModel'], provides: ['candidates'], consumes: ['requestedModel'] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'decision'] },
  async execute({ requestedModel, ...facts }, scope) {
    const { candidates, exists } = await discoverCandidates(scope.services, {
      model: requestedModel,
      kind: 'decision',
      payload: facts.decision,
      supports: ({ upstream, model }) => Object.hasOwn(targets, upstream.kind)
        && model.endpoints.decision !== undefined && model.decisionTarget !== undefined,
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });

    const message = exists
      ? `Model ${requestedModel} does not support decision.`
      : `Model ${requestedModel} is not available on any configured upstream.`;
    scope.services.dump?.error('gateway');
    return { http: localHead(exists ? 400 : 404), decision: { kind: 'error', source: 'local', error: openAIError(message) } };
  },
});
