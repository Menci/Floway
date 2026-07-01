import { translatorInputErrorResult } from './errors.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { respondResponses } from './respond.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { inboundHeadersForUpstream } from '../../shared/inbound-headers.ts';
import { createChatGatewayCtxFromHono, createGatewayCtxFromHono, finalizeGatewayResponse, type ChatGatewayCtx, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { readRequestBody, type RequestBody } from '../shared/request-body.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';
import { canonicalizeResponsesPayload, type CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

// OpenAI's verbatim previous_response_not_found envelope. Codex compares this
// body byte-for-byte against upstream — see the cross-references on
// `PreviousResponseNotFoundError` in serve-prep.ts.
const previousResponseNotFoundResponse = (id: string): Response =>
  Response.json(
    {
      error: {
        message: `Previous response with id '${id}' not found.`,
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found',
      },
    },
    { status: 400 },
  );

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Responses-shaped 502 with the same internal-error envelope the
// in-flow `internal-error` ExecuteResult produces. A
// `ProviderModelsUnavailableError` carrying an upstream HTTP body relays
// that body verbatim — the upstream's `/models` 401 IS the diagnostic. The
// caller passes its outer `ctx` when one was already constructed (so the
// dump row preserves the model attribution the request-time
// `requestedModel` stamped); a fresh ctx is minted only for pre-parse
// failures where no payload was available to read model from.
const respondWithInternalError = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
  const result = internalErrorResult(502, toInternalDebugError(error));
  const { response } = await respondResponses(c, result, false, effectiveCtx);
  return finalizeGatewayResponse(effectiveCtx, response);
};

// Pre-stream throw dispatcher. `PreviousResponseNotFoundError` and the
// translator-input case render protocol-shaped 400s; anything else falls
// through to the internal-error 502 path.
const respondToThrow = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  if (error instanceof PreviousResponseNotFoundError) {
    const response = previousResponseNotFoundResponse(error.previousResponseId);
    ctx?.dump?.error('gateway');
    return ctx ? finalizeGatewayResponse(ctx, response) : response;
  }
  if (error instanceof TranslatorInputError) {
    const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
    const { response } = await respondResponses(c, translatorInputErrorResult(error), false, effectiveCtx);
    return finalizeGatewayResponse(effectiveCtx, response);
  }
  return await respondWithInternalError(c, error, requestBody, ctx);
};

const parsePayload = (requestBody: RequestBody): CanonicalResponsesPayload =>
  canonicalizeResponsesPayload(JSON.parse(new TextDecoder().decode(requestBody.bytes)) as ResponsesPayload);

export const responsesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody);
      const wantsStream = payload.stream === true;
      ctx = createChatGatewayCtxFromHono(c, { wantsStream, requestBody, model: payload.model }, apiKeyId => createResponsesHttpStore(apiKeyId, payload.store ?? undefined));
      const result = await responsesServe.generate({ payload, ctx, headers: inboundHeadersForUpstream(c) });
      const { response } = await respondResponses(c, result, wantsStream, ctx);
      return finalizeGatewayResponse(ctx, response);
    } catch (error) {
      return await respondToThrow(c, error, requestBody, ctx);
    }
  },

  compact: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody);
      ctx = createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody, model: payload.model }, apiKeyId => createResponsesHttpStore(apiKeyId, payload.store ?? undefined));
      const result = await responsesServe.compact({ payload, ctx, headers: inboundHeadersForUpstream(c) });
      if (result.type === 'result') {
        ctx.dump?.success(result.modelIdentity, result.usage);
        const compactResponse = Response.json(result.result);
        return finalizeGatewayResponse(ctx, compactResponse);
      }
      const { response } = await respondResponses(c, result, false, ctx);
      return finalizeGatewayResponse(ctx, response);
    } catch (error) {
      return await respondToThrow(c, error, requestBody, ctx);
    }
  },
};
