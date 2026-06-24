// POST /v1/completions and /completions — OpenAI text completions
// (passthrough). The endpoint sits outside the LLM source/target executor
// because there is no protocol translation, no interceptor chain, and no
// cross-protocol traversal: the request body is forwarded to the chosen
// provider's /completions verbatim and the response (single-shot JSON or
// streaming SSE depending on the client's `stream` flag) flows back through
// the shared passthroughServe scaffold.
//
// Billing / usage:
//   1. The handler parses the body, captures `wantsStream` and the
//      caller's `stream_options.include_usage` intent before any mutation.
//   2. For streaming requests we force `stream_options.include_usage = true`
//      upstream so the gateway always sees the usage chunk. The
//      caller-owned transformFrame closure detects that chunk
//      (isOpenAIUsageOnlyEventShape) and either forwards or drops it from
//      the client-facing stream based on the original client intent.
//   3. The usage accumulator settles into the shared telemetry pipeline
//      after the stream ends (or directly from the JSON body in the
//      non-streaming case), so billing is symmetric across both shapes.

import type { Context } from 'hono';

import { billingFromCompletionsUsageAndTier, tokenUsageFromCompletionsBody } from './usage.ts';
import type { TokenUsage } from '../../repo/types.ts';
import { createGatewayCtxFromHono } from '../llm/shared/gateway-ctx.ts';
import { readRequestBody } from '../llm/shared/request-body.ts';
import type { PassthroughResponseHandling } from '../shared/passthrough-serve.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame } from '@floway-dev/protocols/common';

interface CompletionsRequestBody {
  model?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown } | null;
  [key: string]: unknown;
}

type PreparedRequest =
  | { type: 'ok'; body: Record<string, unknown>; model: string; wantsStream: boolean; clientWantsUsageChunk: boolean }
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

const sseResponseHandling = (clientWantsUsageChunk: boolean): Extract<PassthroughResponseHandling, { format: 'sse' }> => {
  // Track the usage block (only on the usage-only chunk per OpenAI spec)
  // and service_tier independently — `service_tier` can ride on any
  // event root in the chat-completions shape, and a future upstream may
  // extend /v1/completions streaming to follow suit. Settling them
  // together at the end lets the tier override land regardless of which
  // chunk it travelled on.
  let usageBlock: unknown = null;
  let serviceTier: string | null | undefined = undefined;
  const transformFrame = (frame: ProtocolFrame<unknown>): ProtocolFrame<unknown> | null => {
    if (frame.type !== 'event') return frame;
    const eventRoot = frame.event as { service_tier?: string | null; usage?: unknown };
    if (eventRoot.service_tier !== undefined) serviceTier = eventRoot.service_tier;
    if (!isOpenAIUsageOnlyEventShape(frame.event)) return frame;
    if (eventRoot.usage !== undefined) usageBlock = eventRoot.usage;
    return clientWantsUsageChunk ? frame : null;
  };
  const settleUsage = (): TokenUsage | null =>
    usageBlock === null ? null : billingFromCompletionsUsageAndTier(usageBlock, serviceTier);
  return { format: 'sse', transformFrame, settleUsage };
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
    ? { ...upstreamBodyBase, stream_options: { ...(upstreamBodyBase.stream_options as Record<string, unknown> | null ?? {}), include_usage: true } }
    : upstreamBodyBase;

  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: 'completions',
    model: request.model,
    bindingServesEndpoint: binding => binding.upstreamModel.endpoints.completions !== undefined,
    call: (binding, opts) =>
      binding.provider.callCompletions(binding.upstreamModel, upstreamBody, request.wantsStream ? ctx.abortSignal : undefined, opts),
    response: request.wantsStream
      ? sseResponseHandling(request.clientWantsUsageChunk)
      : { format: 'json', extractBilling: tokenUsageFromCompletionsBody },
    noBindingMessage: modelId => `Model ${modelId} does not support the /completions endpoint.`,
  });
  return (ctx.dump?.finalize(response) ?? response);
};
