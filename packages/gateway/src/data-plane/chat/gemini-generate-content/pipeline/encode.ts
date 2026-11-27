import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { chatSse, clientFrame, jsonChatResponse, localChatHead, recordChatError } from '../../pipeline/encode.ts';
import { geminiGenerateContentInternalErrorPayload, isGeminiGenerateContentErrorResponse } from '../errors.ts';
import { eventFrame, sseRawFrame } from '@floway-dev/protocols/common';
import { geminiGenerateContentProtocolFrameToSSEFrame } from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError } from '@floway-dev/upstream';

export const encodeGeminiGenerateContent = defineDeliveryStage({
  name: 'geminiGenerateContent.encode',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'geminiGenerateContent', 'candidate?'], provides: ['http'], consumes: ['geminiGenerateContent'] },
  },
  async execute(facts, scope) {
    const { http, geminiGenerateContent: outcome, ...answer } = await scope.next(facts);
    if (outcome.kind === 'error') {
      recordChatError(scope.services.dump, outcome, answer.candidate);
      let head = http ?? localChatHead(outcome.source === 'upstream' ? 500 : 499);
      let error = outcome.error;
      if (outcome.source === 'local' && isGeminiGenerateContentErrorResponse(error) && error.error.status === 'INTERNAL') {
        if (head.status !== 500) head = { ...head, status: 500, statusText: '' };
        error = { ...error, error: { ...error.error, code: 500 } };
      }
      return { ...answer, http: jsonChatResponse(head, error) };
    }
    const head = http ?? localChatHead(200);
    if (outcome.kind === 'result') return { ...answer, http: jsonChatResponse(head, outcome.result) };
    return {
      ...answer,
      http: chatSse(head, outcome.stream, scope, {
        protocol: 'geminiGenerateContent',
        event(event) {
          const wire = geminiGenerateContentProtocolFrameToSSEFrame(eventFrame(event));
          return wire === null ? null : clientFrame(event, wire);
        },
        error(failure) {
          const event = failure.kind === 'protocol' && isGeminiGenerateContentErrorResponse(failure.event)
            ? failure.event
            : geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(failure.cause));
          return [clientFrame(event, sseRawFrame(JSON.stringify(event)))];
        },
      }),
    };
  },
});
