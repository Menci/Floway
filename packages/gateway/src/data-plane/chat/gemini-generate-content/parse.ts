import { geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload } from './errors.ts';
import { jsonResponse, localResponseHead } from '../../pipeline/encode.ts';
import type { GatewayPipelineFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { parseJsonBody, toInternalDebugError } from '@floway-dev/provider';

export interface GeminiGenerateContentDelivery {
  stream: boolean;
}

const { defineStage } = factSpace<GatewayPipelineFacts & { 'request.delivery': GeminiGenerateContentDelivery; 'request.model': string }, GatewayServices>();

export const geminiModelAction = (url: string): string | undefined => {
  const path = new URL(url).pathname;
  const match = /^\/v1(?:beta)?\/models\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]!) : undefined;
};

export const parseGeminiModelAction = (url: string): { model: string; action: string } | null => {
  const modelAction = geminiModelAction(url);
  if (modelAction === undefined) return null;
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return null;
  return { model: modelAction.slice(0, separator).replace(/^models\//, ''), action: modelAction.slice(separator + 1) };
};

export const parseGeminiGenerateContent = defineStage({
  name: 'geminiGenerateContent.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.geminiGenerateContent', 'request.delivery', 'request.model'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const { url, body } = facts['request.http'];
    const target = parseGeminiModelAction(url);
    if (target?.action !== 'generateContent' && target?.action !== 'streamGenerateContent') {
      const modelAction = target?.action ?? geminiModelAction(url);
      const message = modelAction === undefined ? 'Missing Gemini model action.' : `Unknown Gemini model action: ${modelAction}`;
      return { 'response.http': jsonResponse(localResponseHead(404), geminiGenerateContentRpcErrorPayload(404, message)) };
    }
    const parsed = parseJsonBody(body ?? new Uint8Array());
    if (!parsed.ok || !isJsonObject(parsed.value)) {
      const error = parsed.ok ? new TypeError('Expected a Gemini generateContent request object') : parsed.error;
      return { 'response.http': jsonResponse(localResponseHead(500), geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error))) };
    }
    return await scope.next({
      ...facts,
      'request.geminiGenerateContent': parsed.value as unknown as GeminiGenerateContentPayload,
      'request.delivery': { stream: target.action === 'streamGenerateContent' },
      'request.model': target.model,
    });
  },
});
