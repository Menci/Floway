import { buildChatAttemptTargets } from '../../pipeline/attempt-targets.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { noViableCandidateFailure } from '../../shared/errors.ts';
import { analyzeOpenAIChatCompletionsAffinity } from '../affinity/ingress.ts';
import { openaiChatCompletionsRoutingError } from '../errors.ts';

export const buildOpenAIChatCompletionsAttemptTargets = defineStage({
  name: 'openaiChatCompletions.build-attempt-targets',
  through: {
    request: {
      needs: ['openaiChatCompletions', 'candidates', 'chat.modelExists', 'requestedModel'],
      provides: ['chat.targets.openaiChatCompletions'],
      consumes: ['candidates', 'chat.modelExists'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiChatCompletions'] },
  async execute(facts, scope) {
    const { candidates, 'chat.modelExists': exists, ...request } = facts;
    const analysis = await analyzeOpenAIChatCompletionsAffinity(request.openaiChatCompletions, scope.services.affinity);
    const targets = buildChatAttemptTargets('openaiChatCompletions', candidates, analysis);
    if ('kind' in targets || targets.length === 0) {
      const failure = 'kind' in targets ? targets : noViableCandidateFailure(exists, request.requestedModel);
      const { http, outcome } = openaiChatCompletionsRoutingError(failure);
      return { http, openaiChatCompletions: outcome };
    }
    return await scope.next({ ...request, 'chat.targets.openaiChatCompletions': targets });
  },
});
