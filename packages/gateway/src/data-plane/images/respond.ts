import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { TokenUsage } from '../../repo/types.ts';
import { passthroughApiError } from '../shared/passthrough-serve.ts';
import type { PassthroughResponseStrategyContext } from '../shared/passthrough-serve.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/sse.ts';
import { settle } from '../shared/telemetry/settle.ts';
import { tokenUsageFromImagesBody } from '../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { eventFrame, isEventStreamMediaType, parseSSEStream, sseCommentFrame } from '@floway-dev/protocols/common';

// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L51068-L51135
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L51248-L51316
const completedEventType = (sourceApi: PassthroughResponseStrategyContext['sourceApi']): string => {
  switch (sourceApi) {
  case '/images/generations': return 'image_generation.completed';
  case '/images/edits': return 'image_edit.completed';
  default: throw new Error(`Images response strategy does not support ${sourceApi}`);
  }
};

const eventType = (event: unknown): unknown =>
  event !== null && typeof event === 'object' && !Array.isArray(event)
    ? (event as { type?: unknown }).type
    : undefined;

const respondNonStreaming = async ({ ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext): Promise<Response> => {
  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch (error) {
    console.warn(
      `images: failed to parse 2xx upstream body for ${sourceApi}; usage row will be request-only`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const usage = parsed === undefined ? null : tokenUsageFromImagesBody(parsed);
  ctx.dump?.success(identity, usage);
  settle(ctx, performance, identity, usage, false);
  return forwardUpstreamResponse(response);
};

const respondStreaming = ({ c, ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext): Response => {
  const upstreamBody = response.body;
  if (!upstreamBody) {
    ctx.dump?.failed(`${sourceApi} streaming upstream returned no body`);
    settle(ctx, performance, identity, null, true);
    forwardUpstreamHeaders(c, response.headers);
    return passthroughApiError(c, 'Upstream returned a streaming response with no body.', 502);
  }

  const expectedCompletedEvent = completedEventType(sourceApi);
  forwardUpstreamHeaders(c, response.headers);
  c.status(response.status as ContentfulStatusCode);
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    let streamError: unknown;
    let protocolError: unknown;
    let terminalEventSeen = false;
    let usage: TokenUsage | null = null;
    try {
      const frames = (async function* () {
        for await (const frame of parseSSEStream(upstreamBody, { signal: ctx.abortSignal })) {
          let event: unknown;
          try {
            event = JSON.parse(frame.data) as unknown;
          } catch (error) {
            protocolError ??= new Error(`Malformed upstream ${sourceApi} SSE JSON: ${frame.data}`, { cause: error });
            ctx.dump?.frame(eventFrame(frame.data));
            yield frame;
            continue;
          }
          ctx.dump?.frame(eventFrame(event));
          const type = eventType(event);
          if (type === 'error') {
            protocolError ??= new Error(`Upstream ${sourceApi} emitted an error event.`);
          } else if (type === expectedCompletedEvent) {
            if (terminalEventSeen) protocolError ??= new Error(`Upstream ${sourceApi} emitted duplicate completed events.`);
            terminalEventSeen = true;
            usage = tokenUsageFromImagesBody(event);
          }
          yield frame;
        }
      })();
      completion = await writeSSEFrames(stream, frames, {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        downstreamAbortController: ctx.downstreamAbortController,
      });
    } catch (error) {
      streamError = error;
    } finally {
      const failed = streamError !== undefined || protocolError !== undefined || completion !== 'eof' || !terminalEventSeen;
      if (failed) ctx.dump?.failed(streamError ?? protocolError ?? `${sourceApi} stream ended with completion=${completion}`);
      else ctx.dump?.success(identity, usage);
      settle(ctx, performance, identity, usage, failed);
    }
  });
};

export const respondImages = async (context: PassthroughResponseStrategyContext): Promise<Response> => {
  const { ctx, response, performance, identity } = context;
  if (!response.ok) {
    settle(ctx, performance, identity, null, true);
    ctx.dump?.error('upstream', identity.upstream);
    return forwardUpstreamResponse(response);
  }
  return isEventStreamMediaType(response.headers.get('content-type'))
    ? respondStreaming(context)
    : await respondNonStreaming(context);
};
