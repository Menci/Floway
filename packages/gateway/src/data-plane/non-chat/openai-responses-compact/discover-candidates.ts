import { defineStage } from './facts.ts';
import { compactGenerationPayload } from './generation-payload.ts';
import { analyzeOpenAIResponsesAffinity } from '../../chat/openai-responses/affinity/ingress.ts';
import { renderOpenAIResponsesFailure } from '../../chat/openai-responses/errors.ts';
import { buildChatAttemptTargets } from '../../chat/pipeline/attempt-targets.ts';
import { noViableCandidateFailure } from '../../chat/shared/errors.ts';

export const discoverOpenAIResponsesCompactCandidates = defineStage({
  name: 'openaiResponsesCompact.discover-candidates',
  through: {
    request: {
      needs: ['openaiResponsesCompact', 'requestedModel'], provides: ['compactTargets'], consumes: ['openaiResponsesCompact'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponsesCompact'] },
  async execute({ openaiResponsesCompact: payload, requestedModel, ...facts }, scope) {
    const { candidates, sawModel } = await scope.services.catalogCandidates({ kind: 'chat', model: requestedModel });
    const analysis = await analyzeOpenAIResponsesAffinity(compactGenerationPayload(payload), scope.services.affinity);
    const targets = buildChatAttemptTargets('openaiResponses', candidates, analysis);
    if ('kind' in targets || targets.length === 0) {
      const failure = 'kind' in targets ? targets : noViableCandidateFailure(sawModel, requestedModel);
      const { http, outcome } = renderOpenAIResponsesFailure(failure);
      return { http, openaiResponsesCompact: outcome };
    }
    const compactTargets = targets.map(({ payload: projected, ...target }) => ({
      ...target,
      payload: { ...projected, ...(payload.prompt_cache_options === null ? { prompt_cache_options: null } : {}) },
    }));
    return await scope.next({ ...facts, requestedModel, compactTargets });
  },
});
