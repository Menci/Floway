import { defineStage } from './facts.ts';
import { compactGenerationPayload } from './generation-payload.ts';
import { prepareOpenAIResponsesHostedTools } from '../../chat/openai-responses/pipeline/hosted-tools.ts';

export const prepareOpenAIResponsesCompactHostedHistory = defineStage({
  name: 'openaiResponsesCompact.prepare-hosted-history',
  through: {
    request: { needs: ['openaiResponsesCompact', 'model'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponsesCompact'] },
  async execute(facts, scope) {
    const { model, openaiResponsesCompact } = facts;
    const prepared = await prepareOpenAIResponsesHostedTools({
      openaiResponses: compactGenerationPayload(openaiResponsesCompact), model, 'chat.target': 'openaiResponses',
    }, scope);
    if (prepared.kind === 'error') return { http: prepared.http, openaiResponsesCompact: prepared.outcome };
    if (prepared.kind === 'unchanged') return await scope.next(facts);
    const payload = {
      ...prepared.request,
      ...(openaiResponsesCompact.prompt_cache_options === null ? { prompt_cache_options: null } : {}),
    };
    return await scope.next({ ...facts, openaiResponsesCompact: payload });
  },
});
