import { OpenAIResponsesInterruption, openAIResponsesInterruptibleOutput } from './interruption.ts';
import { openAIResponsesClientEvent } from './items/output.ts';
import { defineOpenAIResponsesStage } from './pipeline-facts.ts';
import { createOpenAIResponsesResponseId } from './response-id.ts';
import { completeOpenAIResponsesEvent } from './response-resource.ts';
import { hydrateOpenAIResponsesInput } from './stateful-input.ts';
import { mapOpenAIResponsesFailedResource } from './stream-error.ts';
import { isCausedBy } from '@floway-dev/http';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const openAIResponsesClientOutput = defineOpenAIResponsesStage({
  name: 'openaiResponses.client-output',
  through: {
    request: {
      needs: ['request.openaiResponses', 'request.delivery', 'serve.startedAt', 'request.ws.responseId?'],
      provides: ['request.openaiResponses'],
      consumes: [],
    },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const request = facts['request.openaiResponses'];
    const store = scope.services.openaiResponsesStore(facts['serve.startedAt'], request.store ?? undefined);
    const ready = await hydrateOpenAIResponsesInput(request, store);
    if ('outcome' in ready) return { 'response.http': ready.http, 'response.openaiResponses': ready.outcome };

    const answer = await scope.next({ ...facts, 'request.openaiResponses': ready.payload });
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind !== 'stream') return answer;

    const websocketId = facts['request.ws.responseId'];
    const responseId = websocketId ?? createOpenAIResponsesResponseId();
    const sources = { request, stored: store.writesState, createdAt: facts['request.delivery'].createdAt };
    const stream = scope.wrapStream(outcome.stream, async function* (inner, producer) {
      const statefulEvent = openAIResponsesClientEvent({ store, responseId });
      const interruptible = websocketId === undefined ? undefined : openAIResponsesInterruptibleOutput(websocketId);
      let terminal: OpenAIResponsesStreamEventEx | undefined;
      for await (const item of producer.read(inner)) {
        if (item.ok) {
          if (isOpenAIResponsesTerminalEvent(item.value)) {
            terminal = item.value;
            continue;
          }
          interruptible?.observe(item.value);
          yield { ok: true, value: completeOpenAIResponsesEvent(await statefulEvent(item.value), sources) };
          continue;
        }

        producer.discard(inner);
        const reason: unknown = producer.signal.reason;
        if (interruptible && item.error.kind === 'abort' && reason instanceof OpenAIResponsesInterruption && isCausedBy(item.error.cause, reason)) {
          for (const event of interruptible.interrupt()) {
            yield { ok: true, value: completeOpenAIResponsesEvent(await statefulEvent(event), sources) };
          }
        } else {
          yield {
            ok: false,
            error: await mapOpenAIResponsesFailedResource(item.error, async event => completeOpenAIResponsesEvent(await statefulEvent(event), sources)),
          };
        }
        return;
      }
      if (terminal !== undefined) {
        yield { ok: true, value: completeOpenAIResponsesEvent(await statefulEvent(terminal), sources) };
      }
    });
    return { ...answer, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});
