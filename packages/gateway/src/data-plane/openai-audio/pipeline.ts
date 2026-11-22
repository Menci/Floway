import { measureOpenAIAudioTranscriptionUsage } from './usage.ts';
import {
  edgeHttpStage,
  encodeManagedSseStream,
  failoverRouteCandidates,
  filterInboundHeaderEntries,
  forwardedResponseHeaderEntries,
  gatewayApiErrorOutcome,
  gatewayJsonOutcome,
  headerEntryValue,
  routeCandidateModelIdentity,
  routeCandidatePerformanceContext,
  serializeSseFrame,
  type DownstreamHttpOutcome,
  type GatewayPipelineServices,
} from '../pipeline/index.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { isOpenAIErrorPayload, openaiSseFailure } from '../shared/openai-errors.ts';
import { recordSseOutcome, settleUsageMeasurement } from '../shared/telemetry/settle.ts';
import { requestOnlyUsageMeasurement } from '../shared/telemetry/usage.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import { isEventStreamMediaType, isJsonMediaType, parseSSEStream } from '@floway-dev/protocols/common';
import type { SseReadableFrame } from '@floway-dev/protocols/common';
import { isOpenAIAudioTranscriptionDoneEvent } from '@floway-dev/protocols/openai-audio';
import { asyncIterableToReadableStream, readManagedBytes } from '@floway-dev/provider';
import type { HttpOutcome, MultipartField, RouteCandidate } from '@floway-dev/provider';

export interface OpenAIAudioTranscriptionsPipelineInput {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.model': string;
  readonly 'request.entries': readonly MultipartField[];
}

type CandidateFacts = OpenAIAudioTranscriptionsPipelineInput & {
  readonly 'route.candidate': RouteCandidate;
};

const resolveCandidatesStage = defineStage<
  OpenAIAudioTranscriptionsPipelineInput,
  { readonly 'route.candidates': readonly RouteCandidate[] },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  GatewayPipelineServices
>({
  name: 'gateway.openai-audio.resolveCandidates',
  provides: ['route.candidates'],
  execute: async (facts, next, env) => {
    const model = facts['request.model'];
    const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(model, 'transcription');
    if (candidates.length === 0) {
      env.attribution.recordError('gateway');
      return sawModel
        ? gatewayApiErrorOutcome(
            appendFailedUpstreams(`Model ${model} does not support the /audio/transcriptions endpoint.`, failedUpstreams),
            400,
          )
        : gatewayApiErrorOutcome(
            appendFailedUpstreams(`Model ${model} is not available on any configured upstream.`, failedUpstreams),
            404,
          );
    }

    const viable = Object.freeze(candidates.filter(candidate =>
      candidate.endpoints.openaiAudioTranscriptions !== undefined));
    if (viable.length === 0) {
      env.attribution.recordError('gateway');
      return gatewayApiErrorOutcome(
        appendFailedUpstreams(`Model ${model} does not support the /audio/transcriptions endpoint.`, failedUpstreams),
        400,
      );
    }
    return await next({ 'route.candidates': viable });
  },
});

const failoverStage = defineStage<
  OpenAIAudioTranscriptionsPipelineInput & { readonly 'route.candidates': readonly RouteCandidate[] },
  { readonly 'route.candidate': RouteCandidate },
  HttpOutcome,
  DownstreamHttpOutcome,
  'route.candidates',
  GatewayPipelineServices
>({
  name: 'gateway.openai-audio.failover',
  consumes: ['route.candidates'],
  provides: ['route.candidate'],
  execute: async (facts, next, env) => {
    const result = await failoverRouteCandidates<{
      readonly candidate: RouteCandidate;
      readonly http: HttpOutcome;
    }>({
      candidates: facts['route.candidates'],
      invocationLabel: 'gateway.openai-audio',
      operation: 'audio_transcription',
      env,
      run: async candidate => ({
        candidate,
        http: await next({ 'route.candidate': candidate }),
      }),
      inspect: attempt => ({
        success: attempt.http.status >= 200 && attempt.http.status < 300,
        headers: attempt.http.headers,
        discardStream: attempt.http.body,
      }),
    });
    const { candidate, http } = result;
    const identity = routeCandidateModelIdentity(candidate, http.modelKey ?? candidate.upstreamModelId);
    const performance = routeCandidatePerformanceContext(env, candidate, 'audio_transcription');

    if (http.status < 200 || http.status >= 300) {
      settleUsageMeasurement(env.ctx, performance, identity, requestOnlyUsageMeasurement(), true);
      env.attribution.recordError('upstream', identity.upstream);
      const bytes = await readManagedBytes(http.body);
      return {
        status: http.status,
        statusText: http.statusText,
        headers: forwardedResponseHeaderEntries(http.headers, null),
        body: bytes,
      };
    }

    const contentType = headerEntryValue(http.headers, 'content-type');
    if (!isEventStreamMediaType(contentType)) {
      const bytes = await readManagedBytes(http.body);
      let measurement = requestOnlyUsageMeasurement();
      if (isJsonMediaType(contentType)) {
        try {
          measurement = measureOpenAIAudioTranscriptionUsage(
            JSON.parse(new TextDecoder().decode(bytes)) as unknown,
            '/audio/transcriptions',
          );
        } catch (error) {
          console.warn(
            'audio-transcription: failed to parse 2xx upstream body for /audio/transcriptions; usage row will be request-only',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      env.attribution.recordSuccess(identity, measurement.dumpTokenUsage);
      settleUsageMeasurement(env.ctx, performance, identity, measurement, false);
      return {
        status: http.status,
        statusText: http.statusText,
        headers: forwardedResponseHeaderEntries(http.headers, null),
        body: bytes,
      };
    }

    if (http.body === null) {
      env.attribution.recordFailure('/audio/transcriptions streaming upstream returned no body');
      settleUsageMeasurement(env.ctx, performance, identity, requestOnlyUsageMeasurement(), true);
      return gatewayJsonOutcome(
        502,
        { error: { message: 'Upstream returned a streaming response with no body.', type: 'api_error' } },
        forwardedResponseHeaderEntries(http.headers, null),
      );
    }

    const frames = env.wrapStream<Uint8Array, SseReadableFrame>(http.body, {
      label: 'audio.sse.frames',
      transform: (source, signal) => parseSSEStream(asyncIterableToReadableStream(source), { signal }),
    });
    let measurement = requestOnlyUsageMeasurement();
    const bytes = encodeManagedSseStream(env, frames, {
      label: 'audio.sse.bytes',
      protocol: {
        encode: frame => {
          let event: unknown;
          try {
            event = JSON.parse(frame.data);
          } catch (error) {
            throw new Error(`Malformed upstream /audio/transcriptions SSE JSON: ${frame.data}`, { cause: error });
          }
          const wire = serializeSseFrame(frame);
          if (isOpenAIErrorPayload(event)) return { wire, end: { type: 'protocol-error' } as const };
          if (!isOpenAIAudioTranscriptionDoneEvent(event)) return { wire };
          measurement = measureOpenAIAudioTranscriptionUsage(event, '/audio/transcriptions');
          return { wire, end: { type: 'completed' } as const };
        },
        eof: () => ({
          type: 'premature-eof',
          error: new Error('OpenAI Transcriptions stream ended without a transcript.text.done event.'),
        }),
        failure: error => openaiSseFailure(env.ctx, error),
      },
      onSettle: outcome => {
        const failed = recordSseOutcome(env.ctx, outcome, identity, measurement.dumpTokenUsage);
        settleUsageMeasurement(env.ctx, performance, identity, measurement, failed);
      },
    });
    return {
      status: http.status,
      statusText: http.statusText,
      headers: forwardedResponseHeaderEntries(http.headers, 'text/event-stream'),
      body: bytes,
      sse: {},
    };
  },
});

export const openaiAudioTranscriptionsPipeline: Pipeline<
  OpenAIAudioTranscriptionsPipelineInput,
  DownstreamHttpOutcome,
  GatewayPipelineServices
> = pipeline<OpenAIAudioTranscriptionsPipelineInput>('gateway.openai-audio-transcriptions')
  .use(edgeHttpStage<OpenAIAudioTranscriptionsPipelineInput>('gateway.openai-audio.edge'))
  .use(resolveCandidatesStage)
  .use(failoverStage)
  .end(dispatch<CandidateFacts, HttpOutcome, GatewayPipelineServices>({
    name: 'gateway.openai-audio.dispatch',
    select: (facts, env) => {
      const provider = env.providerFor(facts['route.candidate'].upstreamId);
      const target = provider.pipelines?.openaiAudioTranscriptions;
      if (target === undefined) {
        throw new Error(`Provider ${facts['route.candidate'].upstreamId} has no openaiAudioTranscriptions pipeline`);
      }
      const filteredHeaders = filterInboundHeaderEntries(
        facts['request.inboundHeaders'],
        provider.inboundHeaderAllowlist,
      );
      return handoff(target, {
        'route.candidate': facts['route.candidate'],
        'provider.model': facts['route.candidate'].providerModel,
        'request.inboundHeaders': filteredHeaders,
        'request.payload': { entries: facts['request.entries'] },
      });
    },
  }));
