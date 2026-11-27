import { buildChatAttemptTargets } from '../../pipeline/attempt-targets.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { noViableCandidateFailure } from '../../shared/errors.ts';
import { analyzeOpenAIResponsesAffinity } from '../affinity/ingress.ts';
import { renderOpenAIResponsesFailure } from '../errors.ts';

export const buildOpenAIResponsesAttemptTargets = defineStage({
  name: 'openaiResponses.build-attempt-targets',
  through: {
    request: {
      needs: ['openaiResponses', 'candidates', 'chat.modelExists', 'requestedModel'],
      provides: ['chat.targets.openaiResponses'],
      consumes: ['candidates', 'chat.modelExists'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const { candidates, 'chat.modelExists': exists, ...request } = facts;
    const analysis = await analyzeOpenAIResponsesAffinity(request.openaiResponses, scope.services.affinity);
    const targets = buildChatAttemptTargets('openaiResponses', candidates, analysis);
    if ('kind' in targets || targets.length === 0) {
      const failure = 'kind' in targets ? targets : noViableCandidateFailure(exists, request.requestedModel);
      const { http, outcome } = renderOpenAIResponsesFailure(failure);
      return { http, openaiResponses: outcome };
    }
    return await scope.next({ ...request, 'chat.targets.openaiResponses': targets });
  },
});
