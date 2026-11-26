import { prepareOpenAIResponsesHostedTools } from '../hosted-tools.ts';
import { defineOpenAIResponsesStage, openAIResponsesCompactGenerationPayload } from '../pipeline-facts.ts';

export const openAIResponsesCompactHostedHistory = defineOpenAIResponsesStage({
  name: 'openaiResponsesCompact.prepare-hosted-history',
  through: {
    request: { needs: ['request.openaiResponsesCompact', 'provider.model'], provides: ['request.openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponsesCompact'] },
  async execute(facts, scope) {
    const request = facts['request.openaiResponsesCompact'];
    const prepared = await prepareOpenAIResponsesHostedTools({
      'request.openaiResponses': openAIResponsesCompactGenerationPayload(request),
      'provider.model': facts['provider.model'],
    }, scope);
    if (prepared.kind === 'error') return { 'response.http': prepared.http, 'response.openaiResponsesCompact': prepared.outcome };
    if (prepared.kind === 'unchanged') return await scope.next(facts);
    return await scope.next({
      ...facts,
      'request.openaiResponsesCompact': {
        ...prepared.request,
        ...(request.prompt_cache_options === null ? { prompt_cache_options: null } : {}),
      },
    });
  },
});
