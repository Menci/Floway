import { translatorInputErrorResult } from './errors.ts';
import { respondMessages } from './respond.ts';
import { messagesServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { createGatewayCtxFromHono, runGatewayResponse, type GatewayCtx, type RegisterGatewayCtx } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { completeRequestBodyBytes, readRequestBody, transferRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';

// Reject `anthropic_beta` / `betas` in the body; the Messages protocol carries
// them via the `anthropic-beta` HTTP header.
const rejectBodyBetaResponse = (payload: MessagesPayload): Response | null => {
  const record = payload as unknown as Record<string, unknown>;
  const param = Object.hasOwn(record, 'anthropic_beta')
    ? 'anthropic_beta'
    : Object.hasOwn(record, 'betas')
      ? 'betas'
      : null;
  if (!param) return null;
  return Response.json(
    {
      error: {
        message: `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );
};

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Messages-shaped 502 with the same internal-error envelope the
// in-flow `internal-error` ExecuteResult produces. The caller passes its
// outer `ctx` when one was already constructed (so the dump row preserves
// the model attribution the request-time `requestedModel` stamped, and the
// throwing-candidate telemetry stamped in serve.ts survives onto the error
// row); a fresh ctx is minted when the failure happened before a chat context
// was successfully constructed.
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
  return await respondMessages(c, result, false, effectiveCtx);
};

// Pre-stream caller-input failure raised by a translator → Messages-shaped
// 400 invalid_request_error envelope. Anything else falls through to the
// internal-error 502 path.
const respondToThrow = async (
  c: AuthedContext,
  error: unknown,
  requestBody: RequestBody,
  ctx: GatewayCtx | undefined,
  registerCtx: RegisterGatewayCtx,
): Promise<Response> => {
  if (!(error instanceof TranslatorInputError)) return await respondWithInternalError(c, error, requestBody, ctx, registerCtx);
  const effectiveCtx = ctx ?? registerCtx(transferRequestBody(requestBody, owned => createGatewayCtxFromHono(c, { wantsStream: false, requestBody: owned, backgroundScheduler: backgroundSchedulerFromContext(c) })));
  return await respondMessages(c, translatorInputErrorResult(error, effectiveCtx.attempt.telemetry), false, effectiveCtx);
};

const parsePayload = (requestBody: RequestBody): MessagesPayload =>
  JSON.parse(new TextDecoder().decode(completeRequestBodyBytes(requestBody))) as MessagesPayload;

export const messagesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    return await runGatewayResponse(
      async registerCtx => {
        const payload = parsePayload(requestBody);
        const rejected = rejectBodyBetaResponse(payload);
        if (rejected) return rejected;

        const wantsStream = payload.stream === true;
        const ctx: ChatGatewayCtx = registerCtx(transferRequestBody(requestBody, owned => createChatGatewayCtxFromHono(c, { wantsStream, requestBody: owned, model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonResponsesSourceStore(apiKey.id))));
        const result = await messagesServe.generate({ payload, ctx, headers: inboundHeaders(c) });
        return await respondMessages(c, result, wantsStream, ctx);
      },
      async (error, ctx, registerCtx) => await respondToThrow(c, error, requestBody, ctx, registerCtx),
    );
  },

  countTokens: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    return await runGatewayResponse(
      async registerCtx => {
        const payload = parsePayload(requestBody);
        const rejected = rejectBodyBetaResponse(payload);
        if (rejected) return rejected;

        const ctx: ChatGatewayCtx = registerCtx(transferRequestBody(requestBody, owned => createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody: owned, model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonResponsesSourceStore(apiKey.id))));
        const result = await messagesServe.countTokens({ payload, ctx, headers: inboundHeaders(c) });
        return await respondMessages(c, result, false, ctx);
      },
      async (error, ctx, registerCtx) => await respondToThrow(c, error, requestBody, ctx, registerCtx),
    );
  },
};
