import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { measureAudioTranscriptionUsage } from './usage.ts';
import { observeJsonResponse } from '../shared/json-response.ts';
import { passthroughApiError } from '../shared/passthrough-serve.ts';
import type { PassthroughResponseStrategyContext } from '../shared/passthrough-serve.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/sse.ts';
import { settleUsageMeasurement } from '../shared/telemetry/settle.ts';
import { requestOnlyUsageMeasurement } from '../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { isAudioTranscriptionDoneEvent } from '@floway-dev/protocols/audio';
import { eventFrame, isEventStreamMediaType, isJsonMediaType, parseSSEStream, sseCommentFrame } from '@floway-dev/protocols/common';

const respondNonStreaming = ({ ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext): Response => {
  if (!isJsonMediaType(response.headers.get('content-type'))) {
    const measurement = requestOnlyUsageMeasurement();
    ctx.dump?.success(identity, null);
    settleUsageMeasurement(ctx, performance, identity, measurement, false);
    return forwardUpstreamResponse(response, { defaultContentType: null });
  }
  return observeJsonResponse({
    ctx,
    sourceApi,
    response,
    performance,
    identity,
    observedFields: ['usage', 'duration'],
    defaultContentType: null,
    extractBilling: () => null,
    settleFields: (fields, outcome) => {
      const measurement = outcome.failed ? requestOnlyUsageMeasurement() : measureAudioTranscriptionUsage(fields, sourceApi);
      if (outcome.failed) ctx.dump?.failed(outcome.error ?? `${sourceApi} response body did not complete`);
      else ctx.dump?.success(identity, measurement.dumpTokenUsage);
      settleUsageMeasurement(ctx, performance, identity, measurement, outcome.failed);
    },
  });
};

const respondStreaming = ({ c, ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext): Response => {
  const upstreamBody = response.body;
  if (!upstreamBody) {
    ctx.dump?.failed(`${sourceApi} streaming upstream returned no body`);
    settleUsageMeasurement(ctx, performance, identity, requestOnlyUsageMeasurement(), true);
    forwardUpstreamHeaders(c, response.headers);
    return passthroughApiError(c, 'Upstream returned a streaming response with no body.', 502);
  }
  forwardUpstreamHeaders(c, response.headers);
  c.status(response.status as ContentfulStatusCode);
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    let streamError: unknown;
    let protocolError: unknown;
    let terminalEventSeen = false;
    let measurement = requestOnlyUsageMeasurement();
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
          if (isAudioTranscriptionDoneEvent(event)) {
            terminalEventSeen = true;
            measurement = measureAudioTranscriptionUsage(event, sourceApi);
            yield frame;
            return;
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
      const failed = streamError !== undefined || protocolError !== undefined || completion === 'error' || !terminalEventSeen;
      if (failed) ctx.dump?.failed(streamError ?? protocolError ?? `${sourceApi} stream ended with completion=${completion}`);
      else ctx.dump?.success(identity, measurement.dumpTokenUsage);
      settleUsageMeasurement(ctx, performance, identity, measurement, failed);
    }
  });
};

export const respondAudioTranscription = async (context: PassthroughResponseStrategyContext): Promise<Response> => {
  const { ctx, response, performance, identity } = context;
  if (!response.ok) {
    settleUsageMeasurement(ctx, performance, identity, requestOnlyUsageMeasurement(), true);
    ctx.dump?.error('upstream', identity.upstream);
    return forwardUpstreamResponse(response, { defaultContentType: null });
  }
  return isEventStreamMediaType(response.headers.get('content-type'))
    ? respondStreaming(context)
    : respondNonStreaming(context);
};
