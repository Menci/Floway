import type { Context } from 'hono';

import { apiKeyUpstreamIdsFromContext } from '../../../../../middleware/auth.ts';
import { ProviderModelsUnavailableError } from '../../../../providers/models-store.ts';
import { resolveModelForRequest } from '../../../../providers/registry.ts';
import { stripUnsupportedPartFieldsFromPayload } from '../interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from '../interceptors/strip-unsupported-tools.ts';
import { geminiInternalRpcErrorResponse, geminiRpcErrorResponse } from '../respond.ts';
import type { GeminiContent, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini';
import { translateGeminiViaMessages } from '@floway-dev/translate';

interface GeminiCountTokensRequest {
  contents?: GeminiContent[];
  generateContentRequest?: GeminiGenerateContentRequest;
}

const countTokensRequestToGenerateContentRequest = (request: GeminiCountTokensRequest): GeminiGenerateContentRequest => request.generateContentRequest ?? { contents: request.contents };

// count_tokens reuses Gemini source request normalization, but cannot run the
// full streaming source-interceptor pipeline. Apply the same payload mutations
// directly so its translated request shape matches `generateContent`.
const normalizeCountTokensRequest = (payload: GeminiGenerateContentRequest): void => {
  stripUnsupportedPartFieldsFromPayload(payload);
  stripUnsupportedToolsFromPayload(payload);
  delete payload.safetySettings;
};

const totalTokensFromUpstream = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') return null;
  const payload = value as { input_tokens?: unknown; total_tokens?: unknown };
  if (typeof payload.input_tokens === 'number') return payload.input_tokens;
  if (typeof payload.total_tokens === 'number') return payload.total_tokens;
  return null;
};

export const countGeminiTokens = async (c: Context, model: string): Promise<Response> => {
  try {
    const request = await c.req.json<GeminiCountTokensRequest>();
    const generateContentRequest = countTokensRequestToGenerateContentRequest(request);
    normalizeCountTokensRequest(generateContentRequest);

    const { id: modelId, model: resolvedModel } = await resolveModelForRequest(model, apiKeyUpstreamIdsFromContext(c));

    if (!resolvedModel) {
      return geminiRpcErrorResponse(404, `Model ${modelId} is not available on any configured upstream.`);
    }

    let response: Response | undefined;
    for (const binding of resolvedModel.providers) {
      if (!binding.upstreamModel.upstreamEndpoints.includes('messages_count_tokens')) continue;

      // count_tokens only needs the translated Messages payload; the events
      // translator returned by the trip never runs because nothing here streams
      // back to the source. Pass through the source request via the standard
      // trip so the request-shape stays in lockstep with `generateContent`.
      // The trip always emits `stream: true` (translation assumes streaming
      // upstream); count_tokens is non-streaming, so strip it before sending.
      const { target } = await translateGeminiViaMessages(generateContentRequest, { model: modelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens });
      const { model: _model, stream: _stream, ...body } = target;
      const result = await binding.provider.callMessagesCountTokens(binding.upstreamModel, body);
      response = result.response;
      break;
    }

    if (!response) {
      return geminiRpcErrorResponse(400, `Model ${modelId} does not support countTokens.`);
    }

    if (!response.ok) {
      const body = await response.text();
      return geminiRpcErrorResponse(response.status, body || 'Upstream token counting request failed.');
    }

    const parsed = (await response.json()) as unknown;
    const totalTokens = totalTokensFromUpstream(parsed);
    if (totalTokens === null) {
      return geminiInternalRpcErrorResponse(502, new Error('Invalid upstream token counting response.'));
    }

    return Response.json({ totalTokens });
  } catch (error) {
    if (error instanceof ProviderModelsUnavailableError && error.httpResponse) {
      return geminiRpcErrorResponse(error.httpResponse.status, error.httpResponse.body);
    }

    return geminiInternalRpcErrorResponse(500, error);
  }
};
