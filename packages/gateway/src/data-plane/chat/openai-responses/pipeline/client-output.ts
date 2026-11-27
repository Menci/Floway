import { mapOpenAIResponsesFailedResource } from './client-stream-error.ts';
import { OpenAIResponsesInterruption, trackOpenAIResponsesOutput } from './interruption.ts';
import { MAX_CHAT_COLLECTION_BYTES } from '../../pipeline/collect.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { wrapOpenAIResponsesClientOutput } from '../items/output.ts';
import { createOpenAIResponsesResponseId } from '../response-id.ts';
import { completeResponseResource, wrapResponseResourceCompletion } from '../response-resource.ts';
import { isCausedBy } from '@floway-dev/http';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const encoder = new TextEncoder();

export const openAIResponsesClientOutput = defineStage({
  name: 'openaiResponses.client-output',
  through: {
    request: { needs: ['openaiResponses', 'delivery', 'serve.startedAt', 'ws.responseId?'], provides: [], consumes: [] },
    response: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    if (answer.openaiResponses.kind !== 'stream') return answer;
    const { createdAt, store: storePreference } = facts.delivery;
    if (createdAt === undefined) throw new TypeError('OpenAI Responses delivery requires createdAt');
    const store = scope.services.openaiResponsesStore(facts['serve.startedAt'], storePreference);
    const websocketId = facts['ws.responseId'];
    const responseId = websocketId ?? createOpenAIResponsesResponseId();
    const sources = { request: facts.openaiResponses, stored: store.writesState, createdAt };
    const stream = scope.wrapStream(answer.openaiResponses.stream, async function* (source, producer) {
      const progress = websocketId === undefined ? undefined : trackOpenAIResponsesOutput(websocketId);
      let failure: ProtocolStreamError | undefined;
      const frames = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
        let terminal: OpenAIResponsesStreamEventEx | undefined;
        for await (const item of producer.read(source)) {
          if (!item.ok) {
            producer.discard(source);
            const reason: unknown = producer.signal.reason;
            if (progress !== undefined && reason instanceof OpenAIResponsesInterruption
              && item.error.kind === 'abort' && isCausedBy(item.error.cause, reason)) {
              for (const event of progress.interrupt()) yield eventFrame(event);
            } else {
              failure = item.error;
            }
            return;
          }
          if (isOpenAIResponsesTerminalEvent(item.value)) {
            if (encoder.encode(JSON.stringify(item.value)).byteLength > MAX_CHAT_COLLECTION_BYTES) {
              throw new RangeError(`OpenAI Responses terminal resource exceeds the ${MAX_CHAT_COLLECTION_BYTES}-byte limit`);
            }
            terminal = item.value;
          } else {
            progress?.observe(item.value);
            yield eventFrame(item.value);
          }
        }
        if (terminal !== undefined) yield eventFrame(terminal);
      };

      const stored = wrapOpenAIResponsesClientOutput(frames(), { store, responseId });
      for await (const frame of wrapResponseResourceCompletion(stored, sources)) {
        if (frame.type === 'event') yield { ok: true, value: frame.event };
      }
      if (failure !== undefined) {
        const error = await mapOpenAIResponsesFailedResource(failure, event => {
          if (event.type !== 'response.failed') return event;
          const response = completeResponseResource({ ...event.response, id: responseId }, sources, true);
          return { ...event, response };
        });
        yield { ok: false, error };
      }
    });
    return { ...answer, openaiResponses: { kind: 'stream', stream } };
  },
});
