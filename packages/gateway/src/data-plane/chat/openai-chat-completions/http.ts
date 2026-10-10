import { translatorInputErrorResult } from './errors.ts';
import { respondOpenAIChatCompletions } from './respond.ts';
import { openaiChatCompletionsServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type GatewayCtx } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { createNonOpenAIResponsesSourceStore } from '../openai-responses/items/store.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as an OpenAI Chat Completions-shaped 502 with the same internal-error
// envelope the in-flow `internal-error` ExecuteResult produces. A
// `ProviderModelsUnavailableError` carrying an upstream HTTP body relays
// that body verbatim — the upstream's `/models` 401 IS the diagnostic. The
// caller passes its outer `ctx` when one was already constructed (so the
// dump row preserves the model attribution the request-time
// `requestedModel` stamped, and the throwing-candidate telemetry stamped
// in serve.ts survives onto the error row); a fresh ctx is minted only
// for pre-parse failures where no payload was available to read model from.
const respondWithInternalError = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  const result = internalErrorResult(502, toInternalDebugError(error), effectiveCtx.attempt.telemetry);
  const response = await respondOpenAIChatCompletions(c, result, false, {}, effectiveCtx);
  return finalizeGatewayResponse(effectiveCtx, response);
};

// Pre-stream caller-input failure raised by a translator → an OpenAI Chat
// Completions-shaped 400 invalid_request_error envelope. Anything else
// falls through to the internal-error 502 path.
const respondToThrow = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  if (!(error instanceof TranslatorInputError)) return await respondWithInternalError(c, error, requestBody, ctx);
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  const response = await respondOpenAIChatCompletions(c, translatorInputErrorResult(error, effectiveCtx.attempt.telemetry), false, {}, effectiveCtx);
  return finalizeGatewayResponse(effectiveCtx, response);
};

export const openaiChatCompletionsHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as OpenAIChatCompletionsPayloadEx;
      const wantsStream = payload.stream === true;
      // Upstream interceptors enable usage for accounting; downstream preferences
      // must retain the original request's opt-in flags.
      const streamOptions = { ...payload.stream_options };
      ctx = createChatGatewayCtxFromHono(c, { wantsStream, requestBody: takeRequestBody(requestBody), model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
      const result = await openaiChatCompletionsServe.generate({ payload, ctx, headers: inboundHeaders(c) });
      const response = await respondOpenAIChatCompletions(c, result, wantsStream, streamOptions, ctx);
      return finalizeGatewayResponse(ctx, response);
    } catch (error) {
      return await respondToThrow(c, error, requestBody, ctx);
    }
  },
};
