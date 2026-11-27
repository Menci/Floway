import { buildChatAttemptTargets } from '../../pipeline/attempt-targets.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { noViableCandidateFailure } from '../../shared/errors.ts';
import { analyzeAnthropicMessagesAffinity } from '../affinity/ingress.ts';
import { anthropicMessagesRoutingError } from '../errors.ts';

export const buildAnthropicMessagesAttemptTargets = defineStage({
  name: 'anthropicMessages.build-attempt-targets',
  through: {
    request: {
      needs: ['anthropicMessages', 'candidates', 'chat.modelExists', 'requestedModel'],
      provides: ['chat.targets.anthropicMessages'],
      consumes: ['candidates', 'chat.modelExists'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'anthropicMessages'] },
  async execute(facts, scope) {
    const { candidates, 'chat.modelExists': exists, ...request } = facts;
    const analysis = await analyzeAnthropicMessagesAffinity(request.anthropicMessages, scope.services.affinity);
    const targets = buildChatAttemptTargets('anthropicMessages', candidates, analysis);
    if ('kind' in targets || targets.length === 0) {
      const failure = 'kind' in targets ? targets : noViableCandidateFailure(exists, request.requestedModel);
      const { http, outcome } = anthropicMessagesRoutingError(failure);
      return { http, anthropicMessages: outcome };
    }
    return await scope.next({ ...request, 'chat.targets.anthropicMessages': targets });
  },
});
