import { collectChatStream, type ChatCollectionError } from '../../pipeline/collect.ts';
import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { anthropicMessagesDebugError } from '../errors.ts';
import { createAnthropicMessagesEventAccumulator } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const failure = (error: ProtocolStreamError): ChatCollectionError => ({
  status: error.kind === 'abort' ? 499 : 502,
  outcome: {
    kind: 'error',
    source: error.kind === 'abort' ? 'local' : 'upstream',
    error: error.kind === 'protocol' && error.event !== undefined ? error.event : anthropicMessagesDebugError(error.cause),
  },
});

export const collectAnthropicMessages = defineDeliveryStage({
  name: 'anthropicMessages.collect',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'anthropicMessages'], provides: ['http', 'anthropicMessages'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { anthropicMessages } = answer;
    if (facts.delivery.stream || anthropicMessages.kind !== 'stream') return answer;
    const accumulator = createAnthropicMessagesEventAccumulator();
    let started = false;
    const collected = await collectChatStream('Anthropic Messages', answer.http, anthropicMessages.stream, scope, {
      accept(event) {
        if (event.type === 'message_start') started = true;
        if (event.type === 'message_delta' && !started) {
          return failure({ kind: 'protocol', cause: new Error('Messages message_delta arrived before message_start') });
        }
        if (event.type === 'error') {
          return failure({ kind: 'protocol', cause: new Error(event.error.message), event: { ...event } });
        }
        accumulator.accept(event);
      },
      finish() {
        return started
          ? { kind: 'result', result: accumulator.result() }
          : failure({ kind: 'protocol', cause: new Error('Messages stream ended without message_start') });
      },
    }, failure);
    return { ...answer, http: collected.http, anthropicMessages: collected.outcome };
  },
});
