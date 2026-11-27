import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { chatSse, clientFrame, jsonChatResponse, localChatHead, recordChatError } from '../../pipeline/encode.ts';
import { anthropicMessagesDebugError } from '../errors.ts';
import { anthropicMessagesProtocolFrameToSSEFrame } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';

export const encodeAnthropicMessages = defineDeliveryStage({
  name: 'anthropicMessages.encode',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'anthropicMessages', 'candidate?'], provides: ['http'], consumes: ['anthropicMessages'] },
  },
  async execute(facts, scope) {
    const { http, anthropicMessages: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      recordChatError(scope.services.dump, outcome, answer.candidate);
      return { ...answer, http: jsonChatResponse(http ?? localChatHead(outcome.source === 'upstream' ? 502 : 499), outcome.error) };
    }
    const head = http ?? localChatHead(200);
    if (outcome.kind === 'result') return { ...answer, http: jsonChatResponse(head, outcome.result) };
    return {
      ...answer,
      http: chatSse(head, outcome.stream, scope, {
        protocol: 'anthropicMessages',
        event(event) {
          const wire = anthropicMessagesProtocolFrameToSSEFrame(eventFrame(event));
          return wire === null ? null : clientFrame(event, wire);
        },
        error(failure) {
          const event = failure.kind === 'protocol' && failure.event !== undefined
            ? failure.event
            : anthropicMessagesDebugError(failure.cause, 'api_error');
          return [clientFrame(event, sseFrame(JSON.stringify(event), 'error'))];
        },
        keepAlive: sseFrame(JSON.stringify({ type: 'ping' }), 'ping'),
      }),
    };
  },
});
