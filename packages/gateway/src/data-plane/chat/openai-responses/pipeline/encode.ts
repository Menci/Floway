import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { chatSse, jsonChatResponse, localChatHead, recordChatError } from '../../pipeline/encode.ts';
import { openAIResponsesSseFrames } from '../http-stream-frames.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from '../response-headers.ts';
import { setHeader } from '@floway-dev/http';

export const encodeOpenAIResponses = defineDeliveryStage({
  name: 'openaiResponses.encode',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiResponses', 'candidate?'], provides: ['http'], consumes: ['openaiResponses'] },
  },
  async execute(facts, scope) {
    const { http, openaiResponses: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      recordChatError(scope.services.dump, outcome, answer.candidate);
      return { ...answer, http: jsonChatResponse(http ?? localChatHead(outcome.source === 'upstream' ? 502 : 499), outcome.error) };
    }
    const head = http ?? localChatHead(200);
    if (outcome.kind === 'result') {
      const headers = setHeader(head.headers, OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE);
      return { ...answer, http: jsonChatResponse({ ...head, headers }, outcome.result) };
    }
    return {
      ...answer,
      http: chatSse(head, outcome.stream, scope, {
        protocol: 'openaiResponses',
        ...openAIResponsesSseFrames(),
        headers: [[OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE]],
      }),
    };
  },
});
