import { streamSSE } from 'hono/streaming';

import { measureAudioTranscriptionUsage } from './usage.ts';
import { passthroughApiError } from '../shared/passthrough-serve.ts';
import type { PassthroughResponseStrategyContext } from '../shared/passthrough-serve.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/sse.ts';
import { settleUsageMeasurement } from '../shared/telemetry/settle.ts';
import { requestOnlyUsageMeasurement } from '../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { isAudioTranscriptionDoneEvent } from '@floway-dev/protocols/audio';
import { eventFrame, parseSSEStream, sseCommentFrame } from '@floway-dev/protocols/common';

const respondNonStreaming = async ({ ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext): Promise<Response> => {
  let measurement = requestOnlyUsageMeasurement();
  const contentType = response.headers.get('content-type')?.replace(/;.*$/u, '').trim().toLowerCase();
  const jsonMediaType = contentType === 'application/json' || contentType?.endsWith('+json') === true;
  if (jsonMediaType) {
    let parsed: unknown;
    try {
      parsed = await response.clone().json();
    } catch (error) {
      console.warn(
        `audio-transcription: failed to parse 2xx upstream body for ${sourceApi}; usage row will be request-only`,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (parsed !== undefined) {
      measurement = measureAudioTranscriptionUsage(parsed, sourceApi);
    }
  }
  ctx.dump?.success(identity, measurement.dumpTokenUsage);
  settleUsageMeasurement(ctx, performance, identity, measurement, false);
  return forwardUpstreamResponse(response, { defaultContentType: null });
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
  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    let streamError: unknown;
    let terminalEventSeen = false;
    let measurement = requestOnlyUsageMeasurement();
    try {
      const frames = (async function* () {
        for await (const frame of parseSSEStream(upstreamBody, { signal: ctx.abortSignal })) {
          let event: unknown;
          try {
            event = JSON.parse(frame.data) as unknown;
          } catch (error) {
            throw new Error(`Malformed upstream ${sourceApi} SSE JSON: ${frame.data}`, { cause: error });
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
      const failed = streamError !== undefined || completion === 'error' || !terminalEventSeen;
      if (failed) ctx.dump?.failed(streamError ?? `${sourceApi} stream ended with completion=${completion}`);
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
  const contentType = response.headers.get('content-type')?.replace(/;.*$/u, '').trim().toLowerCase();
  return contentType === 'text/event-stream'
    ? respondStreaming(context)
    : await respondNonStreaming(context);
};
