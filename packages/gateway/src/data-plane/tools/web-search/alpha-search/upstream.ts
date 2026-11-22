import type { User } from '../../../../repo/types.ts';
import { filterInboundHeaderEntries } from '../../../pipeline/headers.ts';
import type { GatewayRequestDirectory } from '../../../pipeline/services.ts';
import { enumerateModelCandidates } from '../../../providers/resolution.ts';
import type { WebSearchConfig } from '../types.ts';
import { runPipeline } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import {
  toProviderModelFacts,
  headersFromEntries,
  asyncIterableToReadableStream,
} from '@floway-dev/provider';
import type { RouteCandidate } from '@floway-dev/provider';

export type AlphaSearchDispatcher = (body: Record<string, unknown>, signal: AbortSignal | undefined, headers: Headers) => Promise<Response>;

export class AlphaSearchModelNotFoundError extends Error {
  constructor() {
    super('Search model not found.');
    this.name = 'AlphaSearchModelNotFoundError';
  }
}

export const resolveAlphaSearchRouteCandidate = async (
  directory: GatewayRequestDirectory,
  config: Pick<WebSearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>,
): Promise<RouteCandidate> => {
  const { candidates } = await directory.enumerateCandidates(config.model, 'chat');
  const candidate = candidates.find(value => value.upstreamId === config.upstreamId);
  if (candidate === undefined) throw new AlphaSearchModelNotFoundError();
  if (candidate.kind !== 'chatgpt' && candidate.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return candidate;
};

const resolveLiveCandidate = async ({
  config,
  subject,
  upstreamIds,
  scheduler,
  runtimeLocation,
}: {
  config: Pick<WebSearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>;
  subject: User;
  upstreamIds: readonly string[] | null;
  scheduler: BackgroundScheduler;
  runtimeLocation: string;
}) => {
  if (upstreamIds !== null && !upstreamIds.includes(config.upstreamId)) {
    throw new AlphaSearchModelNotFoundError();
  }
  const { candidates } = await enumerateModelCandidates({
    subject,
    upstreamIds: [config.upstreamId],
    randomizeUpstreams: false,
    model: config.model,
    kind: 'chat',
    scheduler,
    runtimeLocation,
  });
  const candidate = candidates.find(value => value.provider.upstreamId === config.upstreamId);
  if (candidate === undefined) throw new AlphaSearchModelNotFoundError();
  if (candidate.provider.kind !== 'chatgpt' && candidate.provider.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return candidate;
};

const routeCandidateFrom = (candidate: Awaited<ReturnType<typeof resolveLiveCandidate>>): RouteCandidate => {
  const providerModel = candidate.model.providerModels?.[candidate.provider.upstreamId];
  if (providerModel === undefined) {
    throw new Error(`invariant broken: alpha-search candidate ${candidate.provider.upstreamId}/${candidate.model.id} has no provider model`);
  }
  return Object.freeze({
    upstreamId: candidate.provider.upstreamId,
    upstreamName: candidate.provider.name,
    kind: candidate.provider.kind,
    modelId: candidate.model.id,
    upstreamModelId: providerModel.upstreamModelId,
    endpoints: Object.freeze({ ...candidate.model.endpoints }),
    limits: Object.freeze({ ...candidate.model.limits }),
    providerModel: toProviderModelFacts(providerModel),
    ...(candidate.rules === undefined ? {} : { rules: candidate.rules }),
  });
};

type AlphaSearchResolutionContext = Parameters<typeof resolveLiveCandidate>[0];

export const resolveAlphaSearchDispatcher = async ({
  config,
  subject,
  upstreamIds,
  scheduler,
  runtimeLocation,
}: AlphaSearchResolutionContext): Promise<AlphaSearchDispatcher> => {
  const live = await resolveLiveCandidate({ config, subject, upstreamIds, scheduler, runtimeLocation });
  const candidate = routeCandidateFrom(live);
  const pipeline = live.provider.pipelines?.alphaSearch;
  if (pipeline === undefined) {
    throw new Error(`Provider ${candidate.upstreamId} has no alphaSearch pipeline`);
  }

  return async (body, signal, headers) => {
    const { model: _callerModel, ...request } = body;
    const http = await runPipeline(pipeline, {
      'route.candidate': candidate,
      'provider.model': candidate.providerModel,
      'request.inboundHeaders': filterInboundHeaderEntries(
        [...headers.entries()].map(([name, value]) => [name, value] as const),
        live.provider.inboundHeaderAllowlist,
      ),
      'request.payload': request,
    }, {
      services: {
        fetcherFor: () => live.fetcher,
        onUpstreamDispatch: undefined,
      } as never,
      ...(signal === undefined ? {} : { signal }),
    });
    return new Response(http.body === null ? null : asyncIterableToReadableStream(http.body), {
      status: http.status,
      statusText: http.statusText,
      headers: headersFromEntries(http.headers),
    });
  };
};
