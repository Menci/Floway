import type { Context } from 'hono';

import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { openaiInternalErrorPayload, openaiSseFailure } from '../../shared/openai-errors.ts';
import { serializeSseFrame, serveSse } from '../../shared/sse.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { forwardBufferedUpstreamResponse } from '../../shared/upstream-response.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { eventResultMetadata, jsonResponseInit, observeChatFrames, settleChatSse } from '../shared/respond.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiChatCompletionsProtocolFrameToSSEFrame, collectOpenAIChatCompletionsProtocolEventsToResult, openaiChatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/openai-chat-completions';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';

export const respondOpenAIChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> | PlainResult,
  wantsStream: boolean,
  includeUsageChunk: boolean,
  ctx: GatewayCtx,
  expectedChoices = 1,
): Promise<Response> => {
  if (result.type === 'api-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.error(result.source, result.upstreamId);
    return forwardBufferedUpstreamResponse(result);
  }

  if (result.type === 'internal-error') {
    recordFailedRequest(ctx, result.performance);
    ctx.dump?.failed(result.error.message);
    return internalOpenAIChatCompletionsErrorResponse(result.http, result.error);
  }

  if (result.type === 'plain') {
    if (result.http.status >= 400) {
      ctx.dump?.error(result.upstreamId !== undefined ? 'upstream' : 'gateway', result.upstreamId);
    }
    return forwardBufferedUpstreamResponse(result);
  }

  const frames = wrapOpenAIChatCompletionsAffinityEgress(observeChatFrames(result.events, ctx), affinityEgressOptions(ctx));

  if (!wantsStream) {
    try {
      const response = await collectOpenAIChatCompletionsProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = tokenUsageFromBillableUsage(metadata.billableUsage);
      ctx.dump?.success(metadata.modelIdentity, usage);
      settle(ctx, metadata.performance, metadata.modelIdentity, usage, false);
      return Response.json(response, jsonResponseInit(result.http));
    } catch (error) {
      recordFailedRequest(ctx, result.performance);
      ctx.dump?.failed(error);
      return internalOpenAIChatCompletionsErrorResponse({ status: 502 }, toInternalDebugError(error));
    }
  }

  const finishedChoices = new Set<number>();
  return serveSse(c, {
    http: result.http,
    events: frames,
    downstreamAbortController: ctx.downstreamAbortController,
    protocol: {
      encode: frame => {
        const output = openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
        const wire = output === null ? null : serializeSseFrame(output);
        if (frame.type === 'done') return { wire, end: { type: 'completed' } };
        if (openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) return { wire, end: { type: 'protocol-error' } };
        for (const { index, finish_reason: reason } of frame.event.choices) {
          if (reason != null && Number.isInteger(index) && index >= 0 && index < expectedChoices) finishedChoices.add(index);
        }
        return { wire };
      },
      eof: () => finishedChoices.size === expectedChoices
        ? { type: 'completed' }
        : { type: 'premature-eof', error: new Error('OpenAI Chat Completions stream ended before all choices finished.') },
      failure: error => openaiSseFailure(ctx, error),
    },
    settle: outcome => settleChatSse(ctx, result, outcome),
  });
};

const internalOpenAIChatCompletionsErrorResponse = (http: ResponseInit, error: InternalDebugError): Response => Response.json(openaiInternalErrorPayload(error), http);
