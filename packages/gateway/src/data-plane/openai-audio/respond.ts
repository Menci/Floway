import { measureOpenAIAudioTranscriptionUsage } from './usage.ts';
import { isOpenAIErrorPayload, openaiSseFailure } from '../shared/openai-errors.ts';
import { passthroughApiError } from '../shared/passthrough-serve.ts';
import type { PassthroughResponseStrategyContext } from '../shared/passthrough-serve.ts';
import { serializeSseFrame, serveSse } from '../shared/sse.ts';
import { recordSseOutcome, settleUsageMeasurement } from '../shared/telemetry/settle.ts';
import { requestOnlyUsageMeasurement } from '../shared/telemetry/usage.ts';
import { forwardUpstreamHeaders, forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { eventFrame, isEventStreamMediaType, isJsonMediaType, parseSSEStream } from '@floway-dev/protocols/common';
import { isOpenAIAudioTranscriptionDoneEvent } from '@floway-dev/protocols/openai-audio';

const respondNonStreaming = async ({ ctx, sourceApi, response, performance, identity }: PassthroughResponseStrategyContext): Promise<Response> => {
  let measurement = requestOnlyUsageMeasurement();
  if (isJsonMediaType(response.headers.get('content-type'))) {
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
      measurement = measureOpenAIAudioTranscriptionUsage(parsed, sourceApi);
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
  let measurement = requestOnlyUsageMeasurement();
  forwardUpstreamHeaders(c, response.headers);
  return serveSse(c, {
    events: parseSSEStream(upstreamBody, { signal: ctx.abortSignal }),
    downstreamAbortController: ctx.downstreamAbortController,
    protocol: {
      encode: frame => {
        let event: unknown;
        try {
          event = JSON.parse(frame.data);
        } catch (error) {
          throw new Error(`Malformed upstream ${sourceApi} SSE JSON: ${frame.data}`, { cause: error });
        }
        const wire = serializeSseFrame(frame);
        ctx.dump?.frame(eventFrame(event));
        if (isOpenAIErrorPayload(event)) return { wire, end: { type: 'protocol-error' } };
        if (!isOpenAIAudioTranscriptionDoneEvent(event)) return { wire };
        measurement = measureOpenAIAudioTranscriptionUsage(event, sourceApi);
        return { wire, end: { type: 'completed' } };
      },
      eof: () => ({ type: 'premature-eof', error: new Error('OpenAI Transcriptions stream ended without a transcript.text.done event.') }),
      failure: error => openaiSseFailure(ctx, error),
    },
    settle: outcome => {
      const failed = recordSseOutcome(ctx, outcome, identity, measurement.dumpTokenUsage);
      settleUsageMeasurement(ctx, performance, identity, measurement, failed);
    },
  });
};

export const respondOpenAIAudioTranscription = async (context: PassthroughResponseStrategyContext): Promise<Response> => {
  const { ctx, response, performance, identity } = context;
  if (!response.ok) {
    settleUsageMeasurement(ctx, performance, identity, requestOnlyUsageMeasurement(), true);
    ctx.dump?.error('upstream', identity.upstream);
    return forwardUpstreamResponse(response, { defaultContentType: null });
  }
  return isEventStreamMediaType(response.headers.get('content-type'))
    ? respondStreaming(context)
    : await respondNonStreaming(context);
};
