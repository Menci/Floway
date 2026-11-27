import { collectChatStream, type ChatCollectionError } from '../../pipeline/collect.ts';
import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { geminiGenerateContentInternalErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from '../errors.ts';
import { createGeminiGenerateContentEventAccumulator } from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/upstream';

const failure = (error: ProtocolStreamError): ChatCollectionError => {
  const event = error.kind === 'protocol' ? error.event : undefined;
  const rpc = isGeminiGenerateContentErrorResponse(event);
  const status = rpc ? googleRpcHttpStatusCode(event.error.code) : 500;
  return {
    status,
    outcome: {
      kind: 'error',
      source: error.kind === 'abort' ? 'local' : 'upstream',
      error: rpc ? event : geminiGenerateContentInternalErrorPayload(status, toInternalDebugError(error.cause)),
    },
  };
};

export const collectGeminiGenerateContent = defineDeliveryStage({
  name: 'geminiGenerateContent.collect',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'geminiGenerateContent'], provides: ['http', 'geminiGenerateContent'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { geminiGenerateContent } = answer;
    if (facts.delivery.stream || geminiGenerateContent.kind !== 'stream') return answer;
    const accumulator = createGeminiGenerateContentEventAccumulator();
    const collected = await collectChatStream('Gemini Generate Content', answer.http, geminiGenerateContent.stream, scope, {
      accept(event) {
        if (isGeminiGenerateContentErrorResponse(event)) {
          return failure({ kind: 'protocol', cause: new Error(event.error.message), event: { ...event } });
        }
        accumulator.accept(event);
      },
      finish: () => ({ kind: 'result', result: accumulator.result() }),
    }, failure);
    return { ...answer, http: collected.http, geminiGenerateContent: collected.outcome };
  },
});
