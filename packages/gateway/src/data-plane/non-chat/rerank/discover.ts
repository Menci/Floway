import { defineStage } from './facts.ts';
import { discoverCandidates } from '../../pipeline/discover-candidates.ts';
import { localHead, openAIError } from '../shared/http.ts';
import { rerankRequestIncompatibility } from '@floway-dev/protocols/rerank';

export const discover = defineStage({
  name: 'rerank.discover-candidates',
  through: {
    request: { needs: ['rerank', 'requestedModel'], provides: ['candidates'], consumes: ['requestedModel'] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'rerank'] },
  async execute({ requestedModel, ...facts }, scope) {
    const { candidates, exists, incompatibilities } = await discoverCandidates(scope.services, {
      model: requestedModel,
      kind: 'rerank',
      payload: facts.rerank,
      supports: ({ upstream, model }) => upstream.kind === 'custom'
        && model.endpoints.rerank !== undefined && model.rerankTarget !== undefined,
      incompatibility({ model }, request) {
        if (model.rerankTarget === undefined) throw new Error(`Rerank model ${model.id} has no outbound target`);
        return rerankRequestIncompatibility(model.rerankTarget.protocol, request);
      },
    });
    if (candidates.length > 0) return await scope.next({ ...facts, candidates });

    const message = incompatibilities.length > 0
      ? `Model ${requestedModel} does not support this rerank request: ${incompatibilities.join('; ')}.`
      : exists ? `Model ${requestedModel} does not support rerank.`
        : `Model ${requestedModel} is not available on any configured upstream.`;
    scope.services.dump?.error('gateway');
    return { http: localHead(exists ? 400 : 404), rerank: { kind: 'error', source: 'local', error: openAIError(message) } };
  },
});
