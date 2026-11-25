import { encodeResponse, renderJsonResult } from '../../../pipeline/encode-response.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { encodeProtocolSse } from '../../../shared/encode-protocol-sse.ts';
import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { collectChatOutcome } from '../../pipeline/collect.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, openaiChatCompletionsProtocolFrameToSSEFrame } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError } from '@floway-dev/provider';

export const encodeOpenAIChatCompletions = encodeResponse('response.openaiChatCompletions', async (outcome, http, delivery, scope) => {
  if (delivery.kind !== 'openaiChatCompletions') throw new TypeError('Expected OpenAI Chat Completions delivery');
  if (outcome.kind === 'result') return renderJsonResult(outcome, http);
  if (delivery.stream) {
    return encodeProtocolSse(http, outcome.stream, scope,
      event => openaiChatCompletionsProtocolFrameToSSEFrame(eventFrame(event), delivery),
      openaiChatCompletionsProtocolFrameToSSEFrame(doneFrame(), delivery)!);
  }

  const result = await collectChatOutcome(outcome.stream, scope, collectOpenAIChatCompletionsProtocolEventsToResult,
    (_message, cause) => openaiInternalErrorPayload(toInternalDebugError(cause)));
  return result.kind === 'result'
    ? renderJsonResult(result, http)
    : jsonResponseBody(responseHead(502), result.error);
});
