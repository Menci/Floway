import { tokenUsageFromOpenAICompletionsUsage } from './usage.ts';
import {
  edgeHttpStage,
  encodeManagedSseStream,
  failoverRouteCandidates,
  filterInboundHeaderEntries,
  forwardedResponseHeaderEntries,
  gatewayApiErrorOutcome,
  gatewayJsonOutcome,
  routeCandidateModelIdentity,
  routeCandidatePerformanceContext,
  serializeSseFrame,
  type DownstreamHttpOutcome,
  type GatewayPipelineServices,
} from '../pipeline/index.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { isOpenAIErrorPayload, openaiSseFailure } from '../shared/openai-errors.ts';
import { recordFailedRequest } from '../shared/telemetry/performance.ts';
import { recordSseOutcome, settle } from '../shared/telemetry/settle.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import {
  doneFrame,
  eventFrame,
  isOpenAIUsageOnlyEventShape,
  parseSSEStream,
  parseTargetStreamFrames,
  type ProtocolFrame,
} from '@floway-dev/protocols/common';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import { asyncIterableToReadableStream, hasEnabledFlag, readManagedBytes } from '@floway-dev/provider';
import type { HttpOutcome, RouteCandidate } from '@floway-dev/provider';

export interface OpenAICompletionsPipelineInput {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.model': string;
  readonly 'request.payload': OpenAICompletionsPayload;
  readonly 'request.wantsStream': boolean;
  readonly 'request.wantsUsageChunk': boolean;
}

type PreparedPayload = Omit<OpenAICompletionsPayload, 'model'>;

type CandidateFacts = OpenAICompletionsPipelineInput & {
  readonly 'request.upstreamPayload': PreparedPayload;
  readonly 'route.candidate': RouteCandidate;
};

const resolveCandidates = defineStage<
  OpenAICompletionsPipelineInput,
  { readonly 'route.candidates': readonly RouteCandidate[] },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  GatewayPipelineServices
>({
  name: 'gateway.openai-completions.resolveCandidates',
  provides: ['route.candidates'],
  execute: async (facts, next, env) => {
    const model = facts['request.model'];
    const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(model, 'chat');
    if (candidates.length === 0) {
      env.attribution.recordError('gateway');
      return sawModel
        ? gatewayApiErrorOutcome(
            appendFailedUpstreams(`Model ${model} does not support the /completions endpoint.`, failedUpstreams),
            400,
          )
        : gatewayApiErrorOutcome(
            appendFailedUpstreams(`Model ${model} is not available on any configured upstream.`, failedUpstreams),
            404,
          );
    }

    const viable = Object.freeze(candidates.filter(candidate =>
      candidate.endpoints.openaiCompletions !== undefined));
    if (viable.length === 0) {
      env.attribution.recordError('gateway');
      return gatewayApiErrorOutcome(
        appendFailedUpstreams(`Model ${model} does not support the /completions endpoint.`, failedUpstreams),
        400,
      );
    }
    return await next({ 'route.candidates': viable });
  },
});

const preparePayload = defineStage<
  OpenAICompletionsPipelineInput & { readonly 'route.candidates': readonly RouteCandidate[] },
  { readonly 'request.upstreamPayload': PreparedPayload },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  GatewayPipelineServices
>({
  name: 'gateway.openai-completions.preparePayload',
  provides: ['request.upstreamPayload'],
  execute: async (facts, next) => {
    const { model: _model, ...payload } = facts['request.payload'];
    const streamOptions = facts['request.payload'].stream_options as Record<string, unknown> | null | undefined;
    return await next({
      'request.upstreamPayload': facts['request.wantsStream']
        ? { ...payload, stream_options: { ...(streamOptions ?? {}), include_usage: true } }
        : payload,
    });
  },
});

const readUsage = (
  bytes: Uint8Array,
  declaredExclusive: boolean,
  servingIdentity: string,
): ReturnType<typeof tokenUsageFromOpenAICompletionsUsage> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    console.warn(
      `pipeline.openai-completions: failed to parse 2xx upstream body for /completions; usage row will be skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { usage, service_tier: serviceTier } = parsed as { usage?: unknown; service_tier?: string | null };
  return tokenUsageFromOpenAICompletionsUsage(usage, serviceTier, declaredExclusive, servingIdentity);
};

const failover = defineStage<
  OpenAICompletionsPipelineInput
    & { readonly 'request.upstreamPayload': PreparedPayload }
    & { readonly 'route.candidates': readonly RouteCandidate[] },
  { readonly 'route.candidate': RouteCandidate },
  HttpOutcome,
  DownstreamHttpOutcome,
  'route.candidates',
  GatewayPipelineServices
>({
  name: 'gateway.openai-completions.failover',
  consumes: ['route.candidates'],
  provides: ['route.candidate'],
  execute: async (facts, next, env) => {
    const result = await failoverRouteCandidates<{ readonly candidate: RouteCandidate; readonly http: HttpOutcome }>({
      candidates: facts['route.candidates'],
      invocationLabel: 'gateway.openai-completions',
      operation: 'text_completion',
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
    const performance = routeCandidatePerformanceContext(env, candidate, 'text_completion');
    const declaredExclusive = hasEnabledFlag(candidate.providerModel, 'usage-exclusive-cached-tokens');
    const servingIdentity = `${candidate.upstreamId}/${candidate.providerModel.id}`;

    if (http.status < 200 || http.status >= 300) {
      recordFailedRequest(env.ctx, performance);
      env.attribution.recordError('upstream', identity.upstream);
      const body = await readManagedBytes(http.body);
      return {
        status: http.status,
        statusText: http.statusText,
        headers: forwardedResponseHeaderEntries(http.headers, 'application/json'),
        body,
      };
    }

    if (!facts['request.wantsStream']) {
      const body = await readManagedBytes(http.body);
      const usage = readUsage(body, declaredExclusive, servingIdentity);
      env.attribution.recordSuccess(identity, usage);
      settle(env.ctx, performance, identity, usage, false);
      return {
        status: http.status,
        statusText: http.statusText,
        headers: forwardedResponseHeaderEntries(http.headers, 'application/json'),
        body,
      };
    }

    if (http.body === null) {
      env.attribution.recordFailure('/completions streaming upstream returned no body');
      recordFailedRequest(env.ctx, performance);
      return gatewayJsonOutcome(
        502,
        { error: { message: 'Upstream returned a streaming response with no body.', type: 'api_error' } },
        forwardedResponseHeaderEntries(http.headers, null),
      );
    }

    let streamingUsageBlock: unknown = null;
    let streamingServiceTier: string | null | undefined;
    const protocolFrames = env.wrapStream<Uint8Array, ProtocolFrame<unknown>>(http.body, {
      label: 'downstream.protocol.events',
      transform: (source, signal) => (async function* () {
        for await (const parsed of parseTargetStreamFrames<unknown>(
          parseSSEStream(asyncIterableToReadableStream(source), { signal }),
          { protocol: '/completions' },
        )) {
          if (parsed.type === 'done') {
            yield doneFrame();
            return;
          }
          yield eventFrame(parsed.data);
        }
      })(),
    });

    const body = encodeManagedSseStream(env, protocolFrames, {
      label: 'downstream.sse.bytes',
      protocol: {
        encode: frame => {
          env.attribution.recordFrame(frame);
          if (frame.type === 'done') {
            return {
              wire: serializeSseFrame({ type: 'sse', data: '[DONE]' }),
              end: { type: 'completed' as const },
            };
          }
          if (isOpenAIErrorPayload(frame.event)) {
            return {
              wire: serializeSseFrame({ type: 'sse', data: JSON.stringify(frame.event) }),
              end: { type: 'protocol-error' as const },
            };
          }
          const root = frame.event as { service_tier?: string | null; usage?: unknown };
          if (root.service_tier !== undefined) streamingServiceTier = root.service_tier;
          if (isOpenAIUsageOnlyEventShape(frame.event)) {
            streamingUsageBlock = root.usage;
            if (!facts['request.wantsUsageChunk']) return { wire: null };
          }
          return { wire: serializeSseFrame({ type: 'sse', data: JSON.stringify(frame.event) }) };
        },
        eof: () => ({
          type: 'premature-eof',
          error: new Error('OpenAI Completions stream ended without a [DONE] sentinel.'),
        }),
        failure: error => openaiSseFailure(env.ctx, error),
      },
      onSettle: outcome => {
        const usage = streamingUsageBlock === null
          ? null
          : tokenUsageFromOpenAICompletionsUsage(
              streamingUsageBlock,
              streamingServiceTier,
              declaredExclusive,
              servingIdentity,
            );
        const failed = recordSseOutcome(env.ctx, outcome, identity, usage);
        settle(env.ctx, performance, identity, usage, failed);
      },
    });

    return {
      status: http.status,
      statusText: http.statusText,
      headers: forwardedResponseHeaderEntries(http.headers, 'text/event-stream'),
      body,
      sse: {},
    };
  },
});

export const openaiCompletionsPipeline: Pipeline<
  OpenAICompletionsPipelineInput,
  DownstreamHttpOutcome,
  GatewayPipelineServices
> = pipeline<OpenAICompletionsPipelineInput>('gateway.openai-completions')
  .use(edgeHttpStage<OpenAICompletionsPipelineInput>('gateway.openai-completions.edge'))
  .use(resolveCandidates)
  .use(preparePayload)
  .use(failover)
  .end(dispatch<CandidateFacts, HttpOutcome, GatewayPipelineServices>({
    name: 'gateway.openai-completions.dispatch',
    select: (facts, env) => {
      const provider = env.providerFor(facts['route.candidate'].upstreamId);
      const target = provider.pipelines?.openaiCompletions;
      if (target === undefined) {
        throw new Error(`Provider ${facts['route.candidate'].upstreamId} has no openaiCompletions pipeline`);
      }
      return handoff(target, {
        'route.candidate': facts['route.candidate'],
        'provider.model': facts['route.candidate'].providerModel,
        'request.inboundHeaders': filterInboundHeaderEntries(
          facts['request.inboundHeaders'],
          provider.inboundHeaderAllowlist,
        ),
        'request.payload': facts['request.upstreamPayload'],
      });
    },
  }));
