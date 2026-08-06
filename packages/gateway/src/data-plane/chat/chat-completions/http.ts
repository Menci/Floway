import { translatorInputErrorResult } from './errors.ts';
import { respondChatCompletions } from './respond.ts';
import { chatCompletionsServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { createGatewayCtxFromHono, runGatewayResponse, type GatewayCtx, type RegisterGatewayCtx } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { completeRequestBodyBytes, readRequestBody, transferRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Chat Completions-shaped 502 with the same internal-error
// envelope the in-flow `internal-error` ExecuteResult produces. A
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
  return await respondChatCompletions(c, result, false, false, effectiveCtx);
};

// Pre-stream caller-input failure raised by a translator → Chat
// Completions-shaped 400 invalid_request_error envelope. Anything else
// falls through to the internal-error 502 path.
const respondToThrow = async (
  c: AuthedContext,
  error: unknown,
  requestBody: RequestBody,
  ctx: GatewayCtx | undefined,
  registerCtx: RegisterGatewayCtx,
): Promise<Response> => {
  if (!(error instanceof TranslatorInputError)) return await respondWithInternalError(c, error, requestBody, ctx, registerCtx);
  const effectiveCtx = ctx ?? registerCtx(transferRequestBody(requestBody, owned => createGatewayCtxFromHono(c, { wantsStream: false, requestBody: owned, backgroundScheduler: backgroundSchedulerFromContext(c) })));
  return await respondChatCompletions(c, translatorInputErrorResult(error, effectiveCtx.attempt.telemetry), false, false, effectiveCtx);
};

export const chatCompletionsHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    return await runGatewayResponse(
      async registerCtx => {
        const payload = JSON.parse(new TextDecoder().decode(completeRequestBodyBytes(requestBody))) as ChatCompletionsPayload;
        const wantsStream = payload.stream === true;
        // Read the caller's intent BEFORE any interceptor mutates
        // `payload.stream_options.include_usage`. Capturing it here means the
        // downstream renderer never needs to consult per-request Hono context
        // slots — the value lives in this http-entry closure for the duration of
        // the request.
        const includeUsageChunk = payload.stream_options?.include_usage === true;
        const ctx: ChatGatewayCtx = registerCtx(transferRequestBody(requestBody, owned => createChatGatewayCtxFromHono(c, { wantsStream, requestBody: owned, model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonResponsesSourceStore(apiKey.id))));
        const result = await chatCompletionsServe.generate({ payload, ctx, headers: inboundHeaders(c) });
        return await respondChatCompletions(c, result, wantsStream, includeUsageChunk, ctx);
      },
      async (error, ctx, registerCtx) => await respondToThrow(c, error, requestBody, ctx, registerCtx),
    );
  },
};
