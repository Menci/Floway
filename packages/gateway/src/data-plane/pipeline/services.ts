import { isEqual, uniqWith } from 'es-toolkit';

import { checkMany } from '../../access-control/check.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { createModelsRefreshScheduler, type ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, ModelAliasRecord, UsageRecord, User } from '../../repo/types.ts';
import { createNonOpenAIResponsesSourceStore, type OpenAIResponsesStatefulStore } from '../chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../chat/shared/affinity/carrier.ts';
import { resolveLegacyOpaqueBlobCompatibilityIdentity } from '../chat/shared/affinity/legacy.ts';
import { createSidecarCodecFactory, type SidecarCodecFactory } from '../chat/shared/sidecar-codec.ts';
import { readUpstreamModelsSnapshotAndScheduleRefresh } from '../providers/models-cache.ts';
import { createProvider, type GatewayProvider } from '../providers/registry.ts';
import type { PerformanceRecord } from '../shared/telemetry/performance-record.ts';
import { loadWebSearchConfig } from '../tools/web-search/config.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import type { ConfiguredWebSearchProvider, WebSearchConfig } from '../tools/web-search/types.ts';
import { type ErrorSnapshot, snapshotError } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';
import { toProviderModelFacts, type ProviderModelFacts, type ProviderServices } from '@floway-dev/provider';

export interface GatewayRouteFacts {
  readonly 'request.auth.apiKeyId': string;
  readonly 'request.auth.user': Pick<User, 'id' | 'isAdmin'>;
  readonly 'request.route.upstreamIds': readonly string[] | null;
  readonly 'request.route.randomizeUpstreams': boolean;
  readonly 'request.route.runtimeLocation': string;
}

export interface RouteCandidate {
  readonly upstreamId: string;
  readonly upstreamName: string;
  readonly kind: GatewayProvider['kind'];
  readonly modelId: string;
  readonly upstreamModelId: string;
  readonly endpoints: ProviderModelFacts['endpoints'];
  readonly limits: ProviderModelFacts['limits'];
  readonly providerModel: ProviderModelFacts;
  readonly rules?: ModelAliasRecord['targets'][number]['rules'];
}

interface EnumeratedCandidates {
  readonly candidates: readonly RouteCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}

export interface GatewayProviders {
  readonly resolve: (upstreamId: string) => GatewayProvider;
  readonly enumerate: (facts: GatewayRouteFacts, model: string, kind: ModelKind) => Promise<EnumeratedCandidates>;
}

export type { PerformanceRecord } from '../shared/telemetry/performance-record.ts';

interface WebSearchProviderPort {
  (): Promise<ConfiguredWebSearchProvider>;
  readonly alphaSearch: () => Promise<WebSearchConfig['passthroughOpenAiSearch']>;
}

export interface GatewayServices extends ProviderServices {
  readonly providers: GatewayProviders;
  readonly affinityCodec: Pick<AffinityCodec, 'wrap' | 'unwrap'>;
  readonly sidecarCodecs: SidecarCodecFactory;
  readonly responsesStore: OpenAIResponsesStatefulStore;
  readonly usageStore: { readonly record: (row: UsageRecord) => Promise<void | { readonly lastUsedAtError: ErrorSnapshot }> };
  readonly performanceStore: { readonly record: (record: PerformanceRecord) => Promise<void> };
  readonly webSearchProvider: WebSearchProviderPort;
}

const shuffled = <T>(items: readonly T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
};

const enumerateProvider = (provider: GatewayProvider, modelId: string, kind: ModelKind, scheduleRefresh: ModelsRefreshScheduler) => {
  const prefix = provider.modelPrefix;
  const lookupIds = prefix === null ? [modelId] : prefix.addressable.flatMap(form => {
    if (form === 'unprefixed') return [modelId];
    return modelId.startsWith(prefix.prefix) ? [modelId.slice(prefix.prefix.length)] : [];
  });
  if (lookupIds.length === 0) return { candidates: [], sawModel: false, modelsError: false };

  const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(provider, scheduleRefresh);
  const disabled = new Set(provider.disabledPublicModelIds);
  const candidates: RouteCandidate[] = [];
  let sawModel = false;
  for (const id of lookupIds) {
    const match = snapshot.models.find(model => model.id === id && !disabled.has(model.id));
    if (match === undefined) continue;
    sawModel = true;
    if (match.kind !== kind) continue;
    const providerModel = toProviderModelFacts(match);
    candidates.push({
      upstreamId: provider.upstreamId,
      upstreamName: provider.name,
      kind: provider.kind,
      modelId: providerModel.id,
      upstreamModelId: providerModel.upstreamModelId,
      endpoints: providerModel.endpoints,
      limits: providerModel.limits,
      providerModel,
    });
  }
  return { candidates, sawModel, modelsError: snapshot.lastError !== null };
};

const enumerateReal = async (
  facts: GatewayRouteFacts, providers: readonly GatewayProvider[], modelId: string, kind: ModelKind, scheduleRefresh: ModelsRefreshScheduler,
): Promise<EnumeratedCandidates> => {
  const allowed = await checkMany(facts['request.auth.user'], providers.map(provider => ({
    target: { kind: 'upstreamModel', upstreamId: provider.upstreamId, model: { kind: 'exact', value: modelId } },
    requirement: { permission: 'Model.Use' },
  })));
  const groups: RouteCandidate[][] = [];
  const failedUpstreams: string[] = [];
  let sawModel = false;
  for (const [index, provider] of providers.entries()) {
    if (!allowed[index]) continue;
    const result = enumerateProvider(provider, modelId, kind, scheduleRefresh);
    if (result.candidates.length > 0) groups.push(result.candidates);
    if (result.modelsError) failedUpstreams.push(provider.name);
    sawModel ||= result.sawModel;
  }
  return {
    candidates: (facts['request.route.randomizeUpstreams'] ? shuffled(groups) : groups).flat(),
    sawModel,
    failedUpstreams,
  };
};

const createRequestDirectory = (runtimeLocation: string, scheduleRefresh: ModelsRefreshScheduler) => {
  const providers = new Map<string, GatewayProvider>();
  const load = async () => {
    const upstreams = await getRepo().upstreams.list();
    const enabled = upstreams.filter(upstream => upstream.enabled);
    return {
      enabled,
      upstreamById: new Map(enabled.map(upstream => [upstream.id, upstream] as const)),
      fetcher: await createPerRequestFetcher(runtimeLocation, upstreams),
    };
  };
  let loading: ReturnType<typeof load> | undefined;
  let directory: Awaited<ReturnType<typeof load>> | undefined;
  const loadDirectory = () => loading ??= load().then(loaded => {
    directory = loaded;
    return loaded;
  });
  const requireDirectory = () => {
    if (directory === undefined) throw new Error('Gateway provider directory was used before candidate resolution loaded it');
    return directory;
  };
  const resolve: GatewayProviders['resolve'] = upstreamId => {
    const { upstreamById } = requireDirectory();
    const cached = providers.get(upstreamId);
    if (cached !== undefined) return cached;
    const upstream = upstreamById.get(upstreamId);
    if (upstream === undefined) throw new Error(`Unknown or disabled upstream ${upstreamId}`);
    const provider = createProvider(upstream);
    providers.set(upstreamId, provider);
    return provider;
  };
  const list = async (upstreamIds: readonly string[] | null): Promise<readonly GatewayProvider[]> => {
    const loaded = await loadDirectory();
    const upstreams = upstreamIds === null ? loaded.enabled : upstreamIds.flatMap(id => {
      const upstream = loaded.upstreamById.get(id);
      return upstream === undefined ? [] : [upstream];
    });
    return upstreams.map(upstream => resolve(upstream.id));
  };
  const enumerate: GatewayProviders['enumerate'] = async (facts, model, kind) => {
    const listed = await list(facts['request.route.upstreamIds']);
    const alias = await getRepo().modelAliases.getByName(model);
    if (alias === null) return await enumerateReal(facts, listed, model, kind, scheduleRefresh);

    const targets = alias.selection === 'first-available' ? alias.targets : shuffled(alias.targets);
    const candidates: RouteCandidate[] = [];
    const failed = new Set<string>();
    let sawModel = false;
    for (const target of targets) {
      const result = await enumerateReal(facts, listed, target.target_model_id, kind, scheduleRefresh);
      sawModel ||= result.sawModel;
      for (const upstream of result.failedUpstreams) failed.add(upstream);
      for (const candidate of result.candidates) candidates.push({ ...candidate, rules: target.rules });
    }
    return {
      candidates: uniqWith(candidates, (a, b) => a.modelId === b.modelId && a.upstreamId === b.upstreamId && isEqual(a.rules, b.rules)),
      sawModel,
      failedUpstreams: [...failed],
    };
  };
  return {
    providers: { enumerate, resolve },
    fetcher: (upstreamId: string) => requireDirectory().fetcher(upstreamId),
  };
};

export const createGatewayServices = (options: {
  readonly apiKey: ApiKey;
  readonly runtimeLocation: string;
  readonly scheduler: BackgroundScheduler;
  readonly responsesStore?: OpenAIResponsesStatefulStore;
}): GatewayServices => {
  const { apiKey, runtimeLocation, scheduler, responsesStore } = options;
  let searchConfig: ReturnType<typeof loadWebSearchConfig> | undefined;
  const loadSearchConfig = () => searchConfig ??= loadWebSearchConfig();
  const webSearchProvider = Object.assign(
    async () => resolveConfiguredWebSearchProvider(await loadSearchConfig()),
    { alphaSearch: async () => (await loadSearchConfig()).passthroughOpenAiSearch },
  );
  return Object.freeze<GatewayServices>({
    ...createRequestDirectory(runtimeLocation, createModelsRefreshScheduler(runtimeLocation, scheduler)),
    affinityCodec: new AffinityCodec(apiKey.serverSecret, resolveLegacyOpaqueBlobCompatibilityIdentity),
    sidecarCodecs: createSidecarCodecFactory(apiKey.serverSecret),
    responsesStore: responsesStore ?? createNonOpenAIResponsesSourceStore(apiKey.id),
    usageStore: {
      record: async row => {
        const repo = getRepo();
        await repo.usage.record(row);
        try {
          await repo.apiKeys.update(row.keyId, { lastUsedAt: new Date().toISOString() });
        } catch (error) {
          return { lastUsedAtError: snapshotError(error) };
        }
      },
    },
    performanceStore: {
      record: async record => {
        const { performance } = getRepo();
        switch (record.kind) {
        case 'neutral': return await performance.recordNeutral(record.dimensions);
        case 'zero-output-error': return await performance.recordZeroOutputError(record.dimensions);
        case 'sample': return await performance.recordSample(record.sample);
        }
      },
    },
    webSearchProvider,
  });
};
