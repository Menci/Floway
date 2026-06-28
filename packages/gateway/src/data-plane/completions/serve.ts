// POST /v1/completions and /completions — OpenAI text completions
// passthrough. The endpoint sits outside the chat source/target executor:
// no protocol translation, no interceptor chain, no cross-protocol
// traversal. The request body is forwarded to the chosen provider's
// /completions verbatim; the response (single-shot JSON or streaming SSE
// depending on the client's `stream` flag) flows back through the shared
// passthroughServe scaffold.

import type { Context } from 'hono';

import { tokenUsageFromCompletionsUsage } from './usage.ts';
import type { TokenUsage } from '../../repo/types.ts';
import { createGatewayCtxFromHono } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody } from '../chat/shared/request-body.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame } from '@floway-dev/protocols/common';

interface CompletionsRequestBody {
  model?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown } | null;
  [key: string]: unknown;
}

type PreparedRequest =
  | {
    type: 'ok';
    body: Record<string, unknown>;
    model: string;
    wantsStream: boolean;
    clientWantsUsageChunk: boolean;
  }
  | { type: 'invalid'; message: string };

// `model` must be a non-empty string because gateway routing depends on
// it; every other field on the body flows through to the upstream
// unchanged.
const prepareCompletionsRequest = (bytes: Uint8Array): PreparedRequest => {
  let request: CompletionsRequestBody;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { type: 'invalid', message: 'Completions request body must be an object.' };
    }
    request = parsed as CompletionsRequestBody;
  } catch {
    return { type: 'invalid', message: 'Completions request body must be valid JSON.' };
  }

  if (typeof request.model !== 'string' || request.model.length === 0) {
    return { type: 'invalid', message: 'Completions request body must include a model string.' };
  }

  const wantsStream = request.stream === true;
  const clientWantsUsageChunk = request.stream_options?.include_usage === true;
  return { type: 'ok', body: request, model: request.model, wantsStream, clientWantsUsageChunk };
};

export const completions = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareCompletionsRequest(requestBody.bytes);
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: request.type === 'ok' ? request.wantsStream : false,
    requestBody,
  });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    const response = passthroughApiError(c, request.message, 400);
    return (ctx.dump?.finalize(response) ?? response);
  }

  ctx.dump?.requestedModel(request.model);
  // Strip the inbound model; the provider re-stamps the upstream-resolved
  // model id. For streaming requests we force `stream_options.include_usage`
  // on so billing always sees the usage chunk — sibling keys on
  // stream_options (if any) ride through unchanged.
  const { model: _model, ...upstreamBodyBase } = request.body;
  const upstreamBody = request.wantsStream
    ? { ...upstreamBodyBase, stream_options: { ...(request.body.stream_options ?? {}), include_usage: true } }
    : upstreamBodyBase;

  // Streaming closure: track the usage block (only on the usage-only
  // chunk per OpenAI spec) and service_tier independently — service_tier
  // can ride on any event root, so settling them together at the end
  // lets the tier override land regardless of which chunk carried it.
  let streamingUsageBlock: unknown = null;
  let streamingServiceTier: string | null | undefined;
  const transformFrame = (frame: ProtocolFrame<unknown>): ProtocolFrame<unknown> | null => {
    if (frame.type !== 'event') return frame;
    const eventRoot = frame.event as { service_tier?: string | null; usage?: unknown };
    if (eventRoot.service_tier !== undefined) streamingServiceTier = eventRoot.service_tier;
    if (!isOpenAIUsageOnlyEventShape(frame.event)) return frame;
    streamingUsageBlock = eventRoot.usage;
    return request.clientWantsUsageChunk ? frame : null;
  };
  const settleUsage = (): TokenUsage | null =>
    streamingUsageBlock === null ? null : tokenUsageFromCompletionsUsage(streamingUsageBlock, streamingServiceTier);

  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/completions',
    model: request.model,
    kind: 'chat',
    modelServesEndpoint: model => model.endpoints.completions !== undefined,
    call: (provider, model, opts) =>
      provider.provider.callCompletions(model, upstreamBody, ctx.abortSignal, opts),
    response: request.wantsStream
      ? { format: 'sse', transformFrame, settleUsage }
      : {
          format: 'json',
          extractBilling: (body: unknown) => {
            if (!body || typeof body !== 'object') return null;
            const { usage, service_tier: tier } = body as { usage?: unknown; service_tier?: string | null };
            return tokenUsageFromCompletionsUsage(usage, tier);
          },
        },
  });
  return (ctx.dump?.finalize(response) ?? response);
};
