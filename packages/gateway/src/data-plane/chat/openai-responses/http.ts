import { createOpenAIResponsesHttpStore } from './items/store.ts';
import {
  internalOpenAIResponsesErrorPayload,
  openaiResponsesCompactPipeline,
  openaiResponsesGeneratePipeline,
  type OpenAIResponsesPipelineInput,
} from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { buildDownstreamWireUrl, inboundHeaderEntriesFromHono } from '../../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { providerModelsUnavailableResponse } from '../../shared/upstream-response.ts';
import { createChatPipelineServices, runGatewayChatHttpPipeline } from '../pipeline/index.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/provider';

const internalErrorResponse = (
  c: AuthedContext,
  error: unknown,
  requestBody: RequestBody,
  ctx?: ChatGatewayCtx,
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
  return finalizeGatewayResponse(
    effectiveCtx,
    Response.json(internalOpenAIResponsesErrorPayload(toInternalDebugError(error)), { status: 502 }),
  );
};

const payloadFrom = (requestBody: RequestBody) => canonicalizeOpenAIResponsesPayload(
  JSON.parse(new TextDecoder().decode(requestBody.bytes)) as OpenAIResponsesRequestPayloadEx,
);

const invalidPayloadResponse = (error: { readonly message: string; readonly param?: string; readonly code?: string }): Response =>
  Response.json({
    error: {
      message: error.message,
      type: 'invalid_request_error',
      ...(error.param === undefined ? {} : { param: error.param }),
      ...(error.code === undefined ? {} : { code: error.code }),
    },
  }, { status: 400 });

const run = async (c: AuthedContext, action: 'generate' | 'compact'): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  let ctx: ChatGatewayCtx | undefined;
  try {
    const payload = payloadFrom(requestBody);
    if (!('input' in payload)) {
      const errorCtx = createGatewayCtxFromHono(c, {
        wantsStream: false,
        requestBody: takeRequestBody(requestBody),
        backgroundScheduler: backgroundSchedulerFromContext(c),
      });
      recordFailedRequest(errorCtx, undefined);
      errorCtx.dump?.error('gateway');
      return finalizeGatewayResponse(errorCtx, invalidPayloadResponse(payload.error));
    }

    const wantStream = action === 'generate' && payload.stream === true;
    ctx = createChatGatewayCtxFromHono(c, {
      wantsStream: wantStream,
      requestBody: takeRequestBody(requestBody),
      model: payload.model,
      backgroundScheduler: backgroundSchedulerFromContext(c),
    }, (apiKey, requestStartedAt) => createOpenAIResponsesHttpStore(apiKey, requestStartedAt, payload.store ?? undefined));
    const inboundHeaders = inboundHeaderEntriesFromHono(c);
    const input: OpenAIResponsesPipelineInput = {
      'request.http': {
        method: c.req.method,
        url: buildDownstreamWireUrl(c.req.url),
        headers: inboundHeaders,
        body: { kind: 'json', value: payload },
        protocol: action === 'compact' ? 'openai-responses-compact' : 'openai-responses',
      },
      'request.inboundHeaders': inboundHeaders,
      'request.payload': payload,
      'request.action': action,
      'request.wantsStream': wantStream,
      ...(c.req.header('user-agent') === undefined ? {} : { 'request.userAgent': c.req.header('user-agent')! }),
    };
    const pipe = action === 'compact' ? openaiResponsesCompactPipeline : openaiResponsesGeneratePipeline;
    return await runGatewayChatHttpPipeline(c, ctx, pipe, input, {
      services: createChatPipelineServices(ctx),
    });
  } catch (error) {
    return internalErrorResponse(c, error, requestBody, ctx);
  }
};

export const openaiResponsesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => await run(c, 'generate'),
  compact: async (c: AuthedContext): Promise<Response> => await run(c, 'compact'),
};
