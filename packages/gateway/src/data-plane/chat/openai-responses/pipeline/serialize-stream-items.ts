import type { ChatRequestFacts, ChatResponseFacts } from '../../pipeline/facts.ts';
import { openAIResponsesFailureEvents } from '../../pipeline/stream-error.ts';
import { serializeProtocolItems } from '../../pipeline/stream-transform.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const { defineStage } = factSpace<Pick<ChatRequestFacts, 'model'>, Pick<ChatResponseFacts, 'openaiResponses'>>();

export const serializeOpenAIResponsesItems = defineStage({
  name: 'openaiResponses.serialize-stream-items',
  through: {
    request: { needs: ['model'], provides: [], consumes: [] },
    response: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const outcome = answer.openaiResponses;
    if (outcome.kind !== 'stream' || !facts.model.enabledFlags.includes('serialize-stream-items')) return answer;

    const stream = scope.wrapStream(outcome.stream, (source, producer) => {
      let sequence = 0;
      const project = (event: OpenAIResponsesStreamEventEx): OpenAIResponsesStreamEventEx => {
        const sequenceNumber = sequence++;
        return event.sequence_number === sequenceNumber ? event : { ...event, sequence_number: sequenceNumber };
      };
      return serializeProtocolItems(source, producer, event => {
        if (!('output_index' in event)) return undefined;
        return {
          index: event.output_index,
          kind: event.type === 'response.output_item.added' ? 'start' : event.type === 'response.output_item.done' ? 'end' : 'delta',
        };
      }, project, error => {
        if (error.kind !== 'protocol') return error;
        const { notification, failed } = openAIResponsesFailureEvents(error);
        return {
          ...error,
          event: {
            ...error.event,
            ...(notification === undefined ? {} : { notification: project(notification) }),
            ...(failed === undefined ? {} : { failed: project(failed) }),
          },
        };
      });
    });
    return { ...answer, openaiResponses: { kind: 'stream', stream } };
  },
});
