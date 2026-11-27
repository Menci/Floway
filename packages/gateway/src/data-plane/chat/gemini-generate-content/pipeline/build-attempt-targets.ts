import { buildChatAttemptTargets } from '../../pipeline/attempt-targets.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { noViableCandidateFailure } from '../../shared/errors.ts';
import { analyzeGeminiGenerateContentAffinity } from '../affinity/ingress.ts';
import { geminiGenerateContentRoutingError } from '../errors.ts';

export const buildGeminiGenerateContentAttemptTargets = defineStage({
  name: 'geminiGenerateContent.build-attempt-targets',
  through: {
    request: {
      needs: ['geminiGenerateContent', 'candidates', 'chat.modelExists', 'requestedModel'],
      provides: ['chat.targets.geminiGenerateContent'],
      consumes: ['candidates', 'chat.modelExists'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'geminiGenerateContent'] },
  async execute(facts, scope) {
    const { candidates, 'chat.modelExists': exists, ...request } = facts;
    const analysis = await analyzeGeminiGenerateContentAffinity(request.geminiGenerateContent, scope.services.affinity);
    const targets = buildChatAttemptTargets('geminiGenerateContent', candidates, analysis);
    if ('kind' in targets || targets.length === 0) {
      const failure = 'kind' in targets ? targets : noViableCandidateFailure(exists, request.requestedModel);
      const { http, outcome } = geminiGenerateContentRoutingError(failure);
      return { http, geminiGenerateContent: outcome };
    }
    return await scope.next({ ...request, 'chat.targets.geminiGenerateContent': targets });
  },
});
