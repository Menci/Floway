import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { appendFailedUpstreams } from '../../../shared/failed-upstreams.ts';
import { inputErrorFields } from '../../shared/errors.ts';
import { geminiGenerateContentRpcErrorPayload, gatewayErrorStatus } from '../errors.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentCountTokensPayload, GeminiGenerateContentPayload, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';
import { parseJsonBody } from '@floway-dev/provider';
import type { TranslateInputError } from '@floway-dev/translate';

const { defineStage } = gatewayFactSpace<{}>();
const requestKey = 'request.geminiGenerateContent';

export const geminiGenerateContentInputError = (error: TranslateInputError) => {
  const fields = inputErrorFields(error);
  return {
    error: {
      code: 400,
      message: error.message,
      status: gatewayErrorStatus(400),
      ...(fields === undefined ? {} : { details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: fields }] }),
    },
  };
};

const protocolError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.geminiGenerateContent': move({ kind: 'error', source: 'local', error: geminiGenerateContentRpcErrorPayload(status, message) } as const),
});

export const geminiGenerateContentAffinityUnavailable = (message: string) => protocolError(400, message);

export const geminiGenerateContentModelUnavailable = (operation: 'generate' | 'countTokens') => (
  model: string,
  { sawModel, failedUpstreams }: { readonly sawModel: boolean; readonly failedUpstreams: readonly string[] },
) => protocolError(sawModel ? 400 : 404, appendFailedUpstreams(sawModel
  ? `Model ${model} does not support ${operation === 'countTokens' ? 'countTokens' : 'the Gemini generateContent endpoint'}.`
  : `Model ${model} is not available on any configured upstream.`, failedUpstreams));

export const geminiGenerateContentHttpError = (status: number, message: string) => ({
  'response.http': move(jsonResponseBody(responseHead(status), geminiGenerateContentRpcErrorPayload(status, message))),
});

export const parseGeminiGenerateContent = (operation: 'generate' | 'countTokens') => defineStage({
  name: operation === 'generate' ? 'geminiGenerateContent.parse-request' : 'geminiGenerateContentCountTokens.parse-request',
  through: {
    request: { needs: ['request.http', 'serve.model'], provides: [requestKey], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return geminiGenerateContentHttpError(400, 'Gemini generateContent request body must be valid JSON.');
    const decoded = parseJsonBody(raw.value);
    if (!decoded.ok) return geminiGenerateContentHttpError(400, 'Gemini generateContent request body must be valid JSON.');
    if (!isJsonObject(decoded.value)) return geminiGenerateContentHttpError(400, 'Gemini generateContent request body must be an object.');

    const body = decoded.value;
    if (operation === 'generate') {
      if (!Array.isArray(body.contents)) return geminiGenerateContentHttpError(400, 'Gemini generateContent request body must include a contents array.');
      return await scope.next({ ...facts, [requestKey]: move(body as unknown as GeminiGenerateContentPayload) });
    }

    const nested = body.generateContentRequest;
    if (nested !== undefined && !isJsonObject(nested)) return geminiGenerateContentHttpError(400, 'Gemini countTokens generateContentRequest must be an object.');
    const model = facts['serve.model'];
    const generateContentRequest = nested === undefined
      ? { contents: body.contents ?? [], model }
      : { ...nested, model };
    const payload: GeminiGenerateContentCountTokensPayload = { generateContentRequest: generateContentRequest as GeminiGenerateContentRequest };
    return await scope.next({ ...facts, [requestKey]: move(payload) });
  },
});
