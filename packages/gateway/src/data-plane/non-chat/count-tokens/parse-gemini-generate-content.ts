import { defineStage } from './facts.ts';
import { geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload } from '../../chat/gemini-generate-content/errors.ts';
import { jsonResponse, localHead } from '../shared/http.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentCountTokensPayload } from '@floway-dev/protocols/gemini-generate-content';
import { parseJsonBody, toInternalDebugError } from '@floway-dev/upstream';

const modelAction = (url: string): string | undefined => {
  const path = new URL(url).pathname;
  const match = /^\/v1(?:beta)?\/models\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
};

export const parseGeminiGenerateContentCountTokens = defineStage({
  name: 'geminiGenerateContentCountTokens.parse',
  through: {
    request: { needs: ['http', 'serve.startedAt'], provides: ['geminiGenerateContentCountTokens', 'requestedModel'], consumes: ['serve.startedAt'] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute({ 'serve.startedAt': _startedAt, ...facts }, scope) {
    const invalid = (status: number, error: unknown) => ({ http: jsonResponse(localHead(status), error) });
    const { url, body } = facts.http;
    const action = modelAction(url);
    const match = action === undefined ? null : /^(.+):countTokens$/.exec(action);
    if (match === null) {
      const message = action === undefined ? 'Missing Gemini model action.' : `Unknown Gemini model action: ${action}`;
      return invalid(404, geminiGenerateContentRpcErrorPayload(404, message));
    }

    const parsed = body instanceof Uint8Array ? parseJsonBody(body) : undefined;
    if (!parsed?.ok || !isJsonObject(parsed.value)) {
      const error = parsed && !parsed.ok ? parsed.error : new TypeError('Expected a Gemini countTokens request object');
      return invalid(500, geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error)));
    }
    const model = match[1].replace(/^models\//, '');
    const { generateContentRequest, contents } = parsed.value as GeminiGenerateContentCountTokensPayload;
    const payload = generateContentRequest === undefined ? { contents: contents ?? [] } : { generateContentRequest };
    scope.services.dump?.requestedModel(model);
    return await scope.next({ ...facts, geminiGenerateContentCountTokens: payload, requestedModel: model });
  },
});
