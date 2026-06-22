import type { Context } from 'hono';

import { createResponsesHttpStore } from './items/store.ts';
import { respondResponses } from './respond.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import { CODEX_AUTO_REVIEW_ALIAS, CODEX_AUTO_REVIEW_TARGET } from '../../codex/auto-review-alias.ts';
import { isCodexClientRequest } from '../../codex/client-detection.ts';
import { inboundHeadersForUpstream } from '../../shared/inbound-headers.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';

// Codex sends auto-review requests over the Responses wire API as a
// `codex-auto-review` model id; rewrite at the entry so downstream routing,
// performance telemetry, and usage accounting all see the real model name
// (and the `low` reasoning effort the alias implies — generate only;
// compact carries no `reasoning` field).
const rewriteResponsesEntryModelAlias = (payload: ResponsesPayload, stampReasoningEffort: boolean): ResponsesPayload => {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload;
  if (!stampReasoningEffort) return { ...payload, model: CODEX_AUTO_REVIEW_TARGET };
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? {}), effort: 'low' },
  };
};

const shouldPreserveCodexStoreFalse = (c: Context, payload: ResponsesPayload): boolean =>
  payload.store === false && isCodexClientRequest(c);

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
// that body verbatim — the upstream's `/models` 401 IS the diagnostic.
const respondWithInternalError = async (c: Context, error: unknown): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false });
  const result = internalErrorResult(502, toInternalDebugError(error, 'responses'));
  const { response } = await respondResponses(c, result, false, ctx);
  return response;
};

export const responsesHttp = {
  generate: async (c: Context): Promise<Response> => {
    try {
      const payload = rewriteResponsesEntryModelAlias(await c.req.json<ResponsesPayload>(), true);
      const wantsStream = payload.stream === true;
      const ctx = createGatewayCtxFromHono(c, { wantsStream });
      // Codex sends `store:false` when it fails to classify the endpoint as
      // Azure-style, but still chains turns through Floway-minted
      // `previous_response_id`. Preserve gateway replay state for that client
      // without rewriting the upstream wire body.
      const preserveCodexStoreFalse = shouldPreserveCodexStoreFalse(c, payload);
      const store = createResponsesHttpStore(ctx.apiKeyId, preserveCodexStoreFalse ? true : payload.store ?? undefined);
      const result = await responsesServe.generate({
        payload,
        ctx,
        store,
        snapshotMode: payload.store === false && !preserveCodexStoreFalse ? 'none' : 'append',
        headers: inboundHeadersForUpstream(c),
      });
      const { response } = await respondResponses(c, result, wantsStream, ctx);
      return response;
    } catch (error) {
      if (error instanceof PreviousResponseNotFoundError) return previousResponseNotFoundResponse(error.previousResponseId);
      return await respondWithInternalError(c, error);
    }
  },

  compact: async (c: Context): Promise<Response> => {
    try {
      const payload = rewriteResponsesEntryModelAlias(await c.req.json<ResponsesPayload>(), false);
      const ctx = createGatewayCtxFromHono(c, { wantsStream: false });
      const store = createResponsesHttpStore(ctx.apiKeyId, payload.store ?? undefined);
      const result = await responsesServe.compact({ payload, ctx, store, headers: inboundHeadersForUpstream(c) });
      if (result.type === 'result') return Response.json(result.result);
      const { response } = await respondResponses(c, result, false, ctx);
      return response;
    } catch (error) {
      if (error instanceof PreviousResponseNotFoundError) return previousResponseNotFoundResponse(error.previousResponseId);
      return await respondWithInternalError(c, error);
    }
  },
};
