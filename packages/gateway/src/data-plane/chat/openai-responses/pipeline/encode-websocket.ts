import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { captureChatFrame, recordChatError } from '../../pipeline/encode.ts';
import { openAIResponsesFailureEvents } from '../../pipeline/stream-error.ts';
import { eventFrame } from '@floway-dev/protocols/common';

export const encodeOpenAIResponsesWebSocket = defineDeliveryStage({
  name: 'openaiResponses.encode-websocket',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiResponses', 'candidate?'], provides: ['openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { openaiResponses } = answer;
    if (openaiResponses.kind === 'error') recordChatError(scope.services.dump, openaiResponses, answer.candidate);
    if (openaiResponses.kind !== 'stream') return answer;

    const stream = scope.wrapStream(openaiResponses.stream, async function* (source, producer) {
      const capture = captureChatFrame(producer.services.dump, 'openaiResponses', answer.http?.startedAt);
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          producer.discard(source);
          if (item.error.kind !== 'abort') {
            const { notification, failed } = openAIResponsesFailureEvents(item.error);
            if (notification !== undefined) capture?.(eventFrame(notification));
            if (failed !== undefined) capture?.(eventFrame(failed));
            producer.services.dump?.failed(item.error.cause);
          }
          yield item;
          return;
        }
        capture?.(eventFrame(item.value));
        yield item;
      }
    });
    return { ...answer, openaiResponses: { ...openaiResponses, stream } };
  },
});
