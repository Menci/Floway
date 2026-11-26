import { geminiGenerateContentInternalErrorPayload, geminiGenerateContentRpcErrorPayload } from '../chat/gemini-generate-content/errors.ts';
import { geminiModelAction, parseGeminiModelAction } from '../chat/gemini-generate-content/parse.ts';
import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { GeminiCountTokensPayload } from '@floway-dev/protocols/gemini-generate-content';
import { parseJsonBody, toInternalDebugError } from '@floway-dev/provider';

export const parseGeminiGenerateContentCountTokens = defineStage({
  name: 'geminiGenerateContentCountTokens.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.geminiGenerateContentCountTokens', 'request.model'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const invalid = (status: number, error: unknown) => ({
      'response.http': jsonResponse(localResponseHead(status), error),
      'response.outcome': scope.createDeferred(async () => 'local' as const),
    });
    const { url, body } = facts['request.http'];
    const target = parseGeminiModelAction(url);
    if (target?.action !== 'countTokens') {
      const action = target?.action ?? geminiModelAction(url);
      const message = action === undefined ? 'Missing Gemini model action.' : `Unknown Gemini model action: ${action}`;
      return invalid(404, geminiGenerateContentRpcErrorPayload(404, message));
    }

    const parsed = parseJsonBody(body ?? new Uint8Array());
    if (!parsed.ok || !isJsonObject(parsed.value)) {
      const error = parsed.ok ? new TypeError('Expected a Gemini countTokens request object') : parsed.error;
      return invalid(500, geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error)));
    }
    const { generateContentRequest, contents } = parsed.value as GeminiCountTokensPayload;
    const payload: GeminiCountTokensPayload = generateContentRequest === undefined
      ? { contents: contents ?? [] }
      : { generateContentRequest };
    return await scope.next({ ...facts, 'request.geminiGenerateContentCountTokens': payload, 'request.model': target.model });
  },
});
