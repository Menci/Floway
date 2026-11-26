import { localResponseHead } from '../../../pipeline/encode.ts';
import { defineStage } from '../../../pipeline/facts.ts';
import { completeOpenAIResponsesCompaction } from '../compaction-resource.ts';
import { syntheticEventsFromCompaction, wrapOpenAIResponsesClientOutput } from '../items/output.ts';
import { createOpenAIResponsesResponseId } from '../response-id.ts';
import { hydrateOpenAIResponsesInput } from '../stateful-input.ts';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';

export const openAIResponsesCompactClientOutput = defineStage({
  name: 'openaiResponsesCompact.client-output',
  through: {
    request: {
      needs: ['request.openaiResponsesCompact', 'serve.startedAt'],
      provides: ['request.openaiResponsesCompact'],
      consumes: [],
    },
    response: {
      needs: ['response.http', 'response.openaiResponsesCompact'],
      provides: ['response.http', 'response.openaiResponsesCompact'],
      consumes: [],
    },
  },
  return: { provides: ['response.http', 'response.openaiResponsesCompact'] },
  async execute(facts, scope) {
    const request = facts['request.openaiResponsesCompact'];
    const startedAt = facts['serve.startedAt'];
    const store = scope.services.openaiResponsesStore(startedAt, request.store ?? undefined);
    const input = await hydrateOpenAIResponsesInput(request, store);
    if ('outcome' in input) return { 'response.http': input.http, 'response.openaiResponsesCompact': input.outcome };

    const answer = await scope.next({ ...facts, 'request.openaiResponsesCompact': input.payload });
    const outcome = answer['response.openaiResponsesCompact'];
    if (outcome.kind !== 'result') return answer;
    if (outcome.result.usage == null) {
      return {
        ...answer,
        'response.http': { ...localResponseHead(502), headers: answer['response.http']?.headers ?? [], body: null },
        'response.openaiResponsesCompact': {
          kind: 'error',
          source: 'upstream',
          error: {
            error: {
              type: 'internal_error',
              message: 'OpenAI Responses compaction upstream reported no token usage; the compaction resource requires it',
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
      'response.openaiResponsesCompact': {
        kind: 'result',
        result: completeOpenAIResponsesCompaction(persisted, Math.floor(startedAt / 1000)),
      },
    };
  },
});
