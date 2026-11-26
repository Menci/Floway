import { projectOpenAIResponsesCollaboration } from '../collaboration.ts';
import { defineOpenAIResponsesStage, openAIResponsesCompactGenerationPayload } from '../pipeline-facts.ts';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

export const openAIResponsesCompactCollaboration = defineOpenAIResponsesStage({
  name: 'openaiResponsesCompact.apply-collaboration-namespace',
  through: {
    request: { needs: ['request.openaiResponsesCompact', 'provider.model'], provides: ['request.openaiResponsesCompact'], consumes: [] },
    response: { needs: ['response.openaiResponsesCompact'], provides: ['response.openaiResponsesCompact'], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts['provider.model'].enabledFlags.includes('openai-responses-collaboration-shim')) return await scope.next(facts);
    const request = facts['request.openaiResponsesCompact'];
    const projection = projectOpenAIResponsesCollaboration(openAIResponsesCompactGenerationPayload(request));
    if (projection === undefined) return await scope.next(facts);
    const answer = await scope.next({
      ...facts,
      'request.openaiResponsesCompact': {
        ...projection.payload,
        ...(request.prompt_cache_options === null ? { prompt_cache_options: null } : {}),
      },
    });
    const outcome = answer['response.openaiResponsesCompact'];
    if (outcome.kind !== 'result') return answer;
    // Both resource shapes carry the same tool identities inside their output list.
    const event = projection.restoreEvent({ type: 'response.completed', response: outcome.result as unknown as OpenAIResponsesResultEx });
    if (event.type !== 'response.completed') throw new TypeError('Expected a projected compaction resource');
    return { ...answer, 'response.openaiResponsesCompact': { kind: 'result', result: event.response } };
  },
});
