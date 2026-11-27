import { defineStage } from './facts.ts';
import { completeOpenAIResponsesCompaction } from '../../chat/openai-responses/compaction-resource.ts';
import { syntheticEventsFromCompaction, wrapOpenAIResponsesClientOutput } from '../../chat/openai-responses/items/output.ts';
import { hydrateOpenAIResponsesInput } from '../../chat/openai-responses/pipeline/stateful-input.ts';
import { createOpenAIResponsesResponseId } from '../../chat/openai-responses/response-id.ts';
import { localHead } from '../shared/http.ts';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';

export const openAIResponsesCompactClientOutput = defineStage({
  name: 'openaiResponsesCompact.client-output',
  through: {
    request: { needs: ['openaiResponsesCompact', 'serve.startedAt'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: ['http', 'openaiResponsesCompact'], provides: ['http', 'openaiResponsesCompact'], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponsesCompact'] },
  async execute(facts, scope) {
    const { openaiResponsesCompact: request, 'serve.startedAt': startedAt } = facts;
    const store = scope.services.openaiResponsesStore(startedAt, request.store ?? undefined);
    const input = await hydrateOpenAIResponsesInput(request, store);
    if ('openaiResponses' in input) return { http: input.http, openaiResponsesCompact: input.openaiResponses };

    const answer = await scope.next({ ...facts, openaiResponsesCompact: input.payload });
    const { http, openaiResponsesCompact: outcome } = answer;
    if (outcome.kind !== 'result') return answer;
    if (outcome.result.usage == null) {
      return {
        ...answer,
        http: { ...localHead(502), headers: http?.headers ?? [] },
        openaiResponsesCompact: {
          kind: 'error', source: 'upstream', error: {
            error: {
              type: 'internal_error', message: 'OpenAI Responses compaction upstream reported no token usage; the compaction resource requires it',
            },
          },
        },
      };
    }

    const frames = wrapOpenAIResponsesClientOutput(syntheticEventsFromCompaction(outcome.result), {
      store,
      responseId: createOpenAIResponsesResponseId(),
    });
    const persisted = await collectOpenAIResponsesProtocolEventsToResult(frames);
    return {
      ...answer,
      openaiResponsesCompact: { kind: 'result', result: completeOpenAIResponsesCompaction(persisted, Math.floor(startedAt / 1000)) },
    };
  },
});
