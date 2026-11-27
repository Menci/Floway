import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { collectChatStream, type ChatCollectionError } from '../../pipeline/collect.ts';
import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { createOpenAIChatCompletionsEventAccumulator, openaiChatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/upstream';

const failure = (error: ProtocolStreamError): ChatCollectionError => ({
  status: error.kind === 'abort' ? 499 : 502,
  outcome: {
    kind: 'error',
    source: error.kind === 'abort' ? 'local' : 'upstream',
    error: error.kind === 'protocol' && error.event !== undefined ? error.event : openaiInternalErrorPayload(toInternalDebugError(error.cause)),
  },
});

export const collectOpenAIChatCompletions = defineDeliveryStage({
  name: 'openaiChatCompletions.collect',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiChatCompletions'], provides: ['http', 'openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { openaiChatCompletions } = answer;
    if (facts.delivery.stream || openaiChatCompletions.kind !== 'stream') return answer;
    const accumulator = createOpenAIChatCompletionsEventAccumulator();
    const collected = await collectChatStream('OpenAI Chat Completions', answer.http, openaiChatCompletions.stream, scope, {
      accept(event) {
        const message = openaiChatCompletionsErrorPayloadMessage(event);
        if (message !== null) return failure({ kind: 'protocol', cause: new Error(message), event: { ...event } });
        accumulator.accept(event);
      },
      finish: () => ({ kind: 'result', result: accumulator.result() }),
    }, failure);
    return { ...answer, http: collected.http, openaiChatCompletions: collected.outcome };
  },
});
