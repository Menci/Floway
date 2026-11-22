import { edgeHttpStage, gatewayApiErrorOutcome, type DownstreamHttpOutcome } from './edge.ts';
import { failoverRouteCandidates, routeCandidateModelIdentity, routeCandidatePerformanceContext } from './failover.ts';
import { filterInboundHeaderEntries, forwardedResponseHeaderEntries } from './headers.ts';
import type { GatewayPipelineServices } from './services.ts';
import type { TokenUsage } from '../../repo/types.ts';
import type { PassthroughServeApiName } from '../shared/api-names.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { recordFailedRequest } from '../shared/telemetry/performance.ts';
import { settle } from '../shared/telemetry/settle.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import type { ModelKind } from '@floway-dev/protocols/common';
import { readManagedBytes } from '@floway-dev/provider';
import type {
  HttpOutcome,
  PerformanceOperation,
  ProviderPipelineOpenAIEmbeddingsInput,
  ProviderPipelineOpenAIImagesEditsInput,
  ProviderPipelineOpenAIImagesGenerationsInput,
  ProviderPipelineServices,
  RouteCandidate,
} from '@floway-dev/provider';

export interface PassthroughPipelineInput<TPayload> {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.model': string;
  readonly 'request.payload': TPayload;
}

export type PassthroughProviderKey = 'openaiEmbeddings' | 'openaiImagesGenerations' | 'openaiImagesEdits';

export type ProviderPipelineInputFor<TKey extends PassthroughProviderKey> =
  TKey extends 'openaiEmbeddings' ? ProviderPipelineOpenAIEmbeddingsInput
    : TKey extends 'openaiImagesGenerations' ? ProviderPipelineOpenAIImagesGenerationsInput
      : ProviderPipelineOpenAIImagesEditsInput;

interface PassthroughConfig<TPayload, TProviderKey extends PassthroughProviderKey> {
  readonly name: string;
  readonly sourceApi: PassthroughServeApiName;
  readonly operation: PerformanceOperation;
  readonly kind: ModelKind;
  readonly endpointKey: TProviderKey;
  readonly modelServesEndpoint: (candidate: RouteCandidate) => boolean;
  readonly buildProviderInput: (
    facts: Readonly<PassthroughPipelineInput<TPayload> & { readonly 'route.candidate': RouteCandidate }>,
    filteredHeaders: readonly HeaderEntry[],
  ) => ProviderPipelineInputFor<TProviderKey>;
  readonly extractBilling: (body: unknown) => TokenUsage | null;
  readonly defaultContentType?: string | null;
}

interface PassthroughAttempt {
  readonly candidate: RouteCandidate;
  readonly http: HttpOutcome;
}

const erasureSpread = <TPayload>(config: PassthroughConfig<TPayload, PassthroughProviderKey>) => config;
const editableConfig = <TPayload, TProviderKey extends PassthroughProviderKey>(
  config: PassthroughConfig<TPayload, TProviderKey>,
): PassthroughConfig<TPayload, TProviderKey> => ({ ...config });

const candidatesStage = <TPayload>(name: string, config: PassthroughConfig<TPayload, PassthroughProviderKey>) =>
  defineStage<
    PassthroughPipelineInput<TPayload>,
    { readonly 'route.candidates': readonly RouteCandidate[] },
    DownstreamHttpOutcome,
    DownstreamHttpOutcome,
    never,
    GatewayPipelineServices
  >({
    name: `${name}.resolveCandidates`,
    provides: ['route.candidates'],
    execute: async (facts, next, env) => {
      const model = facts['request.model'];
      const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(model, config.kind);
      if (candidates.length === 0) {
        env.attribution.recordError('gateway');
        return sawModel
          ? gatewayApiErrorOutcome(
              appendFailedUpstreams(`Model ${model} does not support the ${config.sourceApi} endpoint.`, failedUpstreams),
              400,
            )
          : gatewayApiErrorOutcome(
              appendFailedUpstreams(`Model ${model} is not available on any configured upstream.`, failedUpstreams),
              404,
            );
      }

      const viable = Object.freeze(candidates.filter(config.modelServesEndpoint));
      if (viable.length === 0) {
        env.attribution.recordError('gateway');
        return gatewayApiErrorOutcome(
          appendFailedUpstreams(`Model ${model} does not support the ${config.sourceApi} endpoint.`, failedUpstreams),
          400,
        );
      }
      return await next({ 'route.candidates': viable });
    },
  });

const failoverStage = <TPayload>(name: string, config: PassthroughConfig<TPayload, PassthroughProviderKey>) =>
  defineStage<
    PassthroughPipelineInput<TPayload> & { readonly 'route.candidates': readonly RouteCandidate[] },
    { readonly 'route.candidate': RouteCandidate },
    HttpOutcome,
    DownstreamHttpOutcome,
    'route.candidates',
    GatewayPipelineServices
  >({
    name: `${name}.failover`,
    consumes: ['route.candidates'],
    provides: ['route.candidate'],
    execute: async (facts, next, env) => {
      const result = await failoverRouteCandidates<PassthroughAttempt>({
        candidates: facts['route.candidates'],
        invocationLabel: config.name,
        operation: config.operation,
        env,
        run: async candidate => {
          const http = await next({ 'route.candidate': candidate });
          return { candidate, http };
        },
        inspect: result => ({
          success: result.http.status >= 200 && result.http.status < 300,
          headers: result.http.headers,
          discardStream: result.http.body,
        }),
      });
      const { candidate, http } = result;
      const identity = routeCandidateModelIdentity(candidate, http.modelKey ?? candidate.upstreamModelId);
      const performance = routeCandidatePerformanceContext(env, candidate, config.operation);
      const defaultContentType = config.defaultContentType === undefined ? 'application/json' : config.defaultContentType;

      if (http.status < 200 || http.status >= 300) {
        recordFailedRequest(env.ctx, performance);
        env.attribution.recordError('upstream', identity.upstream);
        const body = await readManagedBytes(http.body);
        return {
          status: http.status,
          statusText: http.statusText,
          headers: forwardedResponseHeaderEntries(http.headers, defaultContentType),
          body,
        };
      }

      const bytes = await readManagedBytes(http.body);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch (error) {
        console.warn(`pipeline.passthrough: failed to parse 2xx upstream body for ${config.sourceApi}; usage row will be skipped`, error instanceof Error ? error.message : String(error));
        parsed = undefined;
      }
      const usage = parsed === undefined ? null : config.extractBilling(parsed);
      env.attribution.recordSuccess(identity, usage);
      settle(env.ctx, performance, identity, usage, false);
      return {
        status: http.status,
        statusText: http.statusText,
        headers: forwardedResponseHeaderEntries(http.headers, defaultContentType),
        body: bytes,
      };
    },
  });

export const createJsonPassthroughPipeline = <
  TPayload,
  TProviderKey extends PassthroughProviderKey,
>(
  config: PassthroughConfig<TPayload, TProviderKey>,
): Pipeline<PassthroughPipelineInput<TPayload>, DownstreamHttpOutcome, GatewayPipelineServices> => {
  const stageConfig = editableConfig(config);
  const composed = pipeline<PassthroughPipelineInput<TPayload>>(config.name)
    .use(edgeHttpStage<PassthroughPipelineInput<TPayload>>(`${config.name}.edge`))
    .use(candidatesStage(config.name, erasureSpread(stageConfig)))
    .use(failoverStage(config.name, erasureSpread(stageConfig)))
    .end(dispatch<
      PassthroughPipelineInput<TPayload> & { readonly 'route.candidate': RouteCandidate },
      HttpOutcome,
      GatewayPipelineServices
    >({
      name: `${config.name}.dispatch`,
      select: (facts, env) => {
        const target = env.providerFor(facts['route.candidate'].upstreamId).pipelines?.[config.endpointKey];
        if (target === undefined) {
          throw new Error(`Provider ${facts['route.candidate'].upstreamId} has no ${config.endpointKey} pipeline`);
        }
        const filteredHeaders = filterInboundHeaderEntries(
          facts['request.inboundHeaders'],
          env.providerFor(facts['route.candidate'].upstreamId).inboundHeaderAllowlist,
        );
        return handoff(
          target as Pipeline<never, HttpOutcome, ProviderPipelineServices>,
          config.buildProviderInput(facts, filteredHeaders) as never,
        );
      },
    }));
  return composed;
};
