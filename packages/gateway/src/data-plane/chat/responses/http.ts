import { responsesInputErrorResult } from './errors.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { respondResponses, respondResponsesFailure } from './respond.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { createGatewayCtxFromHono, runGatewayResponse, type GatewayCtx, type RegisterGatewayCtx } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { completeRequestBodyBytes, readRequestBody, transferRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { CanonicalResponsesPayload, ResponsesRequestPayload } from '@floway-dev/protocols/responses';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { canonicalizeResponsesPayload, TranslatorInputError } from '@floway-dev/translate';

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
// `requestedModel` stamped, and the throwing-candidate telemetry stamped
// in serve.ts survives onto the error row); a fresh ctx is minted only
// for pre-parse failures where no payload was available to read model from.
const respondWithInternalError = async (
  c: AuthedContext,
  error: unknown,
  requestBody: RequestBody,
  ctx: GatewayCtx | undefined,
  registerCtx: RegisterGatewayCtx,
): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) {
    ctx?.dump?.failed(error);
    return verbatim;
  }
  const effectiveCtx = ctx ?? registerCtx(transferRequestBody(requestBody, owned => createGatewayCtxFromHono(c, { wantsStream: false, requestBody: owned, backgroundScheduler: backgroundSchedulerFromContext(c) })));
  const result = internalErrorResult(502, toInternalDebugError(error), effectiveCtx.attempt.telemetry);
  return respondResponsesFailure(result, effectiveCtx);
};

// Pre-stream throw dispatcher. `PreviousResponseNotFoundError` and the
// translator-input case render protocol-shaped 400s; anything else falls
// through to the internal-error 502 path.
const respondToThrow = async (
  c: AuthedContext,
  error: unknown,
  requestBody: RequestBody,
  ctx: GatewayCtx | undefined,
  registerCtx: RegisterGatewayCtx,
): Promise<Response> => {
  if (error instanceof PreviousResponseNotFoundError) {
    const response = previousResponseNotFoundResponse(error.previousResponseId);
    ctx?.dump?.error('gateway');
    return response;
  }
  if (error instanceof TranslatorInputError) {
    const effectiveCtx = ctx ?? registerCtx(transferRequestBody(requestBody, owned => createGatewayCtxFromHono(c, { wantsStream: false, requestBody: owned, backgroundScheduler: backgroundSchedulerFromContext(c) })));
    return respondResponsesFailure(responsesInputErrorResult(error, effectiveCtx.attempt.telemetry), effectiveCtx);
  }
  return await respondWithInternalError(c, error, requestBody, ctx, registerCtx);
};

const parsePayload = (requestBody: RequestBody): CanonicalResponsesPayload =>
  canonicalizeResponsesPayload(JSON.parse(new TextDecoder().decode(completeRequestBodyBytes(requestBody))) as ResponsesRequestPayload);

export const responsesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    return await runGatewayResponse(
      async registerCtx => {
        const payload = parsePayload(requestBody);
        const wantsStream = payload.stream === true;
        const ctx: ChatGatewayCtx = registerCtx(transferRequestBody(requestBody, owned => createChatGatewayCtxFromHono(c, { wantsStream, requestBody: owned, model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, (apiKey, requestStartedAt) => createResponsesHttpStore(apiKey, requestStartedAt, payload.store ?? undefined))));
        const result = await responsesServe.generate({ payload, ctx, headers: inboundHeaders(c) });
        return await respondResponses(c, result, wantsStream, ctx, payload);
      },
      async (error, ctx, registerCtx) => await respondToThrow(c, error, requestBody, ctx, registerCtx),
    );
  },

  compact: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    return await runGatewayResponse(
      async registerCtx => {
        const payload = parsePayload(requestBody);
        const ctx: ChatGatewayCtx = registerCtx(transferRequestBody(requestBody, owned => createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody: owned, model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, (apiKey, requestStartedAt) => createResponsesHttpStore(apiKey, requestStartedAt, payload.store ?? undefined))));
        const result = await responsesServe.compact({ payload, ctx, headers: inboundHeaders(c) });
        if (result.type === 'result') {
          // Compact drains the upstream stream into a single compaction
          // resource with no per-token stamps; recordPerformance therefore
          // lands in the neutral bucket (request counted, no TTFT/TPOT sample).
          // `status` is not a `CompactResource` key — it survives the spread
          // from the upstream turn — and it is authoritative for failure: a
          // compact that surfaced as `response.failed` must be recorded as such
          // so it shows up in the error column instead of masquerading as a
          // success.
          const failed = result.result.status === 'failed';
          if (failed) {
            ctx.dump?.failed('compact envelope status=failed');
          } else {
            ctx.dump?.success(result.modelIdentity, result.usage);
          }
          settle(
            ctx,
            result.performance,
            result.modelIdentity,
            result.usage,
            failed,
          );
          return Response.json(result.result);
        }
        return await respondResponses(c, result, false, ctx, payload);
      },
      async (error, ctx, registerCtx) => await respondToThrow(c, error, requestBody, ctx, registerCtx),
    );
  },
};
