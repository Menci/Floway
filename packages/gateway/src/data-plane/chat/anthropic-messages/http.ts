import { internalAnthropicMessagesErrorPayload } from './respond.ts';
import { anthropicMessagesCountTokensPipeline, anthropicMessagesGeneratePipeline, anthropicMessagesServeFacts } from './serve-pipeline.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { inboundHeaderEntriesFromHeaders } from '../../pipeline/headers.ts';
import { headerEntryValue } from '../../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { inboundHeaders } from '../../shared/inbound-headers.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../../shared/request-body.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { providerModelsUnavailableResponse } from '../../shared/upstream-response.ts';
import { createNonOpenAIResponsesSourceStore } from '../openai-responses/items/store.ts';
import { runGatewayChatHttpPipeline } from '../pipeline/index.ts';
import { createChatGatewayCtxFromHono, type ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { parseAnthropicBetaHeader, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { toInternalDebugError } from '@floway-dev/provider';

// Reject `anthropic_beta` / `betas` in the body; the Anthropic Messages protocol carries
// them via the `anthropic-beta` HTTP header.
const rejectBodyBetaResponse = (payload: AnthropicMessagesPayload): Response | null => {
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
        message: `${param} in the Anthropic Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );
};

const parsePayload = (requestBody: RequestBody): AnthropicMessagesPayload =>
  JSON.parse(new TextDecoder().decode(requestBody.bytes)) as AnthropicMessagesPayload;

export const anthropicMessagesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody);
      const rejected = rejectBodyBetaResponse(payload);
      if (rejected) return rejected;

      const wantsStream = payload.stream === true;
      ctx = createChatGatewayCtxFromHono(c, { wantsStream, requestBody: takeRequestBody(requestBody), model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
      const headers = inboundHeaders(c);
      const headerEntries = inboundHeaderEntriesFromHeaders(headers);
      const response = await runGatewayChatHttpPipeline(
        c,
        ctx,
        anthropicMessagesGeneratePipeline,
        anthropicMessagesServeFacts(c, payload, headerEntries, parseAnthropicBetaHeader(headerEntryValue(headerEntries, 'anthropic-beta'))),
      );
      return response;
    } catch (error) {
      return internalResponse(c, error, requestBody, ctx);
    }
  },

  countTokens: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody);
      const rejected = rejectBodyBetaResponse(payload);
      if (rejected) return rejected;

      ctx = createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), model: payload.model, backgroundScheduler: backgroundSchedulerFromContext(c) }, apiKey => createNonOpenAIResponsesSourceStore(apiKey.id));
      const headers = inboundHeaders(c);
      const headerEntries = inboundHeaderEntriesFromHeaders(headers);
      const response = await runGatewayChatHttpPipeline(
        c,
        ctx,
        anthropicMessagesCountTokensPipeline,
        anthropicMessagesServeFacts(c, payload, headerEntries, parseAnthropicBetaHeader(headerEntryValue(headerEntries, 'anthropic-beta'))),
      );
      return response;
    } catch (error) {
      return internalResponse(c, error, requestBody, ctx);
    }
  },
};

const internalResponse = (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: ChatGatewayCtx): Response => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const effective = ctx ?? createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  recordFailedRequest(effective, effective.attempt.telemetry);
  effective.dump?.failed(error);
  return finalizeGatewayResponse(
    effective,
    Response.json(internalAnthropicMessagesErrorPayload(toInternalDebugError(error)), { status: 502 }),
  );
};
