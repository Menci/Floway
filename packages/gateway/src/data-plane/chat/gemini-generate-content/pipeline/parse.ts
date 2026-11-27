import { tryDecodeURIComponent } from 'hono/utils/url';

import { defineDeliveryStage, parseChatRequestBody } from '../../pipeline/delivery.ts';
import { jsonChatResponse, localChatHead } from '../../pipeline/encode.ts';
import { geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload } from '../errors.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { toInternalDebugError } from '@floway-dev/upstream';

export const parseGeminiGenerateContent = defineDeliveryStage({
  name: 'geminiGenerateContent.parse',
  through: {
    request: {
      needs: ['http'], provides: ['geminiGenerateContent', 'delivery', 'requestedModel'], consumes: ['ws.message', 'ws.eventId', 'ws.responseId'],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const { url, body } = facts.http;
    const route = parseGeminiModelAction(url);
    if ('error' in route) {
      scope.services.dump?.error('gateway');
      return { http: jsonChatResponse(localChatHead(404), geminiGenerateContentRpcErrorPayload(404, route.error)) };
    }
    scope.services.dump?.requestedModel(route.model);
    const parsedBody = parseChatRequestBody(body);
    if (!parsedBody.ok) {
      scope.services.dump?.failed(parsedBody.error);
      return { http: jsonChatResponse(localChatHead(500), geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(parsedBody.error))) };
    }
    return await scope.next({
      ...facts,
      geminiGenerateContent: parsedBody.value as unknown as GeminiGenerateContentPayload,
      delivery: { stream: route.stream },
      requestedModel: route.model,
    });
  },
});

const parseGeminiModelAction = (url: string): { model: string; stream: boolean } | { error: string } => {
  const raw = /^\/v1(?:beta)?\/models\/(.+)$/.exec(new URL(url).pathname)?.[1];
  if (raw === undefined) return { error: 'Missing Gemini model action.' };
  const modelAction = tryDecodeURIComponent(raw);
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return { error: `Unknown Gemini model action: ${modelAction}` };
  const action = modelAction.slice(separator + 1);
  if (action !== 'generateContent' && action !== 'streamGenerateContent') return { error: `Unknown Gemini model action: ${action}` };
  return { model: modelAction.slice(0, separator).replace(/^models\//, ''), stream: action === 'streamGenerateContent' };
};
