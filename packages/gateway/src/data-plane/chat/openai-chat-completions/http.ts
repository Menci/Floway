import { openaiChatCompletionsPipeline, type OpenAIChatCompletionsPipelineInput } from './pipeline.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { buildDownstreamWireUrl, inboundHeaderEntriesFromHono } from '../../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-errors.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { providerModelsUnavailableResponse } from '../../shared/upstream-response.ts';
import { createNonOpenAIResponsesSourceStore } from '../openai-responses/items/store.ts';
import { createChatPipelineServices, runGatewayChatHttpPipeline } from '../pipeline/index.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError } from '@floway-dev/provider';

const respondWithInternalError = (
  c: AuthedContext,
  error: unknown,
  requestBody: RequestBody,
  ctx: ChatGatewayCtx | undefined,
): Response => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) {
    if (ctx === undefined) return verbatim;
    ctx.dump?.error('upstream');
    return finalizeGatewayResponse(ctx, verbatim);
  }
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  recordFailedRequest(effectiveCtx, effectiveCtx.attempt.telemetry);
  effectiveCtx.dump?.failed(error);
  return finalizeGatewayResponse(effectiveCtx, Response.json(openaiInternalErrorPayload(toInternalDebugError(error)), { status: 502 }));
};

export const openaiChatCompletionsHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as OpenAIChatCompletionsPayloadEx;
      const nullableField = payload.prompt_cache_options === null
        ? 'prompt_cache_options'
        : payload.user === null
          ? 'user'
          : undefined;
      if (nullableField !== undefined) {
        return c.json({
          error: {
            message: `Invalid '${nullableField}': expected ${nullableField === 'user' ? 'a string' : 'an object'} when present.`,
            type: 'invalid_request_error',
            param: nullableField,
            code: null,
          },
        }, 400);
      }

      const inboundHeaders = inboundHeaderEntriesFromHono(c);
      ctx = createChatGatewayCtxFromHono(c, {
        wantsStream: payload.stream === true,
        requestBody: takeRequestBody(requestBody),
        model: payload.model,
        backgroundScheduler: backgroundSchedulerFromContext(c),
      }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
      const input: OpenAIChatCompletionsPipelineInput = {
        'request.http': {
          method: c.req.method,
          url: buildDownstreamWireUrl(c.req.url),
          headers: inboundHeaders,
          body: { kind: 'json', value: payload },
          protocol: 'openai-chat-completions',
        },
        'request.inboundHeaders': inboundHeaders,
        'request.payload': payload,
        'request.wantsStream': payload.stream === true,
        'request.includeUsageChunk': payload.stream_options?.include_usage === true,
        'request.expectedChoices': payload.n ?? 1,
      };
      return await runGatewayChatHttpPipeline(c, ctx, openaiChatCompletionsPipeline, input, {
        services: createChatPipelineServices(ctx),
      });
    } catch (error) {
      return respondWithInternalError(c, error, requestBody, ctx);
    }
  },
};
