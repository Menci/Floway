import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { chatSse, clientFrame, jsonChatResponse, localChatHead, recordChatError } from '../../pipeline/encode.ts';
import { doneFrame, eventFrame, sseFrame } from '@floway-dev/protocols/common';
import { openaiChatCompletionsProtocolFrameToSSEFrame } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError } from '@floway-dev/upstream';

export const encodeOpenAIChatCompletions = defineDeliveryStage({
  name: 'openaiChatCompletions.encode',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiChatCompletions', 'candidate?'], provides: ['http'], consumes: ['openaiChatCompletions'] },
  },
  async execute(facts, scope) {
    const { http, openaiChatCompletions: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      recordChatError(scope.services.dump, outcome, answer.candidate);
      return { ...answer, http: jsonChatResponse(http ?? localChatHead(outcome.source === 'upstream' ? 502 : 499), outcome.error) };
    }
    const head = http ?? localChatHead(200);
    if (outcome.kind === 'result') return { ...answer, http: jsonChatResponse(head, outcome.result) };
    return {
      ...answer,
      http: chatSse(head, outcome.stream, scope, {
        protocol: 'openaiChatCompletions',
        event(event) {
          const wire = openaiChatCompletionsProtocolFrameToSSEFrame(eventFrame(event), { includeUsageChunk: facts.delivery.includeUsageChunk === true });
          return wire === null ? null : clientFrame(event, wire);
        },
        error(failure) {
          const event = failure.kind === 'protocol' && failure.event !== undefined
            ? failure.event
            : openaiInternalErrorPayload(toInternalDebugError(failure.cause));
          return [clientFrame(event, sseFrame(JSON.stringify(event)))];
        },
        done: () => [{ frame: doneFrame(), wire: sseFrame('[DONE]') }],
      }),
    };
  },
});
