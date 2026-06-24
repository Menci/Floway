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

import { completionsUsageFromStreamEvent, tokenUsageFromCompletionsUsage } from './usage.ts';
import type { TokenUsage } from '../../repo/types.ts';
import { createGatewayCtxFromHono } from '../llm/shared/gateway-ctx.ts';
import { readRequestBody } from '../llm/shared/request-body.ts';
import type { PassthroughResponseHandling } from '../shared/passthrough-serve.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CompletionsUsage } from '@floway-dev/protocols/completions';

interface CompletionsRequestBody {
  model?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown } | null;
  [key: string]: unknown;
}

interface PreparedRequest {
  type: 'ok';
  body: Record<string, unknown>;
  model: string;
  wantsStream: boolean;
  clientWantsUsageChunk: boolean;
}

interface InvalidRequest {
  type: 'invalid';
  message: string;
}

// Parse + lightly validate the request body without taking ownership of
// shape decisions the upstream owns. We require `model` as a non-empty
// string (gateway routing depends on it) and validate that the streaming
// flags carry the expected primitive types when present; everything else
// flows through unchanged.
const prepareCompletionsRequest = (bytes: Uint8Array): PreparedRequest | InvalidRequest => {
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

// Force-on `stream_options.include_usage` so the upstream always emits the
// usage-only chunk we need for billing. Preserves any sibling keys the
// caller already set on stream_options.
const withIncludeUsageStreamOption = (body: Record<string, unknown>): Record<string, unknown> => {
  const existing = body.stream_options;
  const merged = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>), include_usage: true }
    : { include_usage: true };
  return { ...body, stream_options: merged };
};

const sseResponseHandling = (clientWantsUsageChunk: boolean): Extract<PassthroughResponseHandling, { format: 'sse' }> => {
  let accumulatedUsage: CompletionsUsage | null = null;
  const transformFrame = (frame: ProtocolFrame<unknown>): ProtocolFrame<unknown> | null => {
    if (frame.type !== 'event') return frame;
    if (!isOpenAIUsageOnlyEventShape(frame.event)) return frame;
    const usage = completionsUsageFromStreamEvent(frame.event);
    if (usage) accumulatedUsage = usage;
    return clientWantsUsageChunk ? frame : null;
  };
  const settleUsage = (): TokenUsage | null =>
    accumulatedUsage ? tokenUsageFromCompletionsUsage(accumulatedUsage) : null;
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
  const upstreamBody = (() => {
    const { model: _model, ...rest } = request.body;
    return request.wantsStream ? withIncludeUsageStreamOption(rest) : rest;
  })();

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
      : { format: 'json', extractUsage: tokenUsageFromCompletionsUsage },
    noBindingMessage: modelId => `Model ${modelId} does not support the /completions endpoint.`,
  });
  return (ctx.dump?.finalize(response) ?? response);
};
