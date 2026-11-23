import { isEqual, uniqWith } from 'es-toolkit';

import { checkMany } from '../../access-control/check.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { type ModelsRefreshTarget, refreshModels } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import { shouldScheduleModelsRefresh } from '../../repo/models-cache-contract.ts';
import { modelsRefreshInputHash } from '../../repo/models-refresh-inputs.ts';
import type { ApiKey, ModelAliasRecord, StoredUpstreamRecord, UsageRecord, User, WebSearchUsageRecord } from '../../repo/types.ts';
import { createNonOpenAIResponsesSourceStore, createOpenAIResponsesHttpStore, type OpenAIResponsesStatefulStore } from '../chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../chat/shared/affinity/carrier.ts';
import { resolveLegacyOpaqueBlobCompatibilityIdentity } from '../chat/shared/affinity/legacy.ts';
import { createSidecarCodecFactory, type SidecarCodecFactory } from '../chat/shared/sidecar-codec.ts';
import { readUpstreamModelsSnapshot } from '../providers/models-cache.ts';
import { providerRuntimeServices, type ProviderRuntimeServices, toUpstreamFacts, type UpstreamFacts } from '../providers/upstreams.ts';
import type { PerformanceRecord } from '../shared/telemetry/performance-record.ts';
import { loadWebSearchConfig } from '../tools/web-search/config.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import type { ConfiguredWebSearchProvider, WebSearchConfig } from '../tools/web-search/types.ts';
import { type ErrorSnapshot, snapshotError } from '@floway-dev/pipeline';
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
  readonly kind: UpstreamFacts['kind'];
  readonly upstream: UpstreamFacts;
  readonly modelId: string;
  readonly upstreamModelId: string;
  readonly endpoints: ProviderModelFacts['endpoints'];
  readonly limits: ProviderModelFacts['limits'];
  readonly providerModel: ProviderModelFacts;
  readonly rules?: ModelAliasRecord['targets'][number]['rules'];
}

export interface EnumeratedCandidates {
  readonly candidates: readonly RouteCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
  readonly staleRefreshes: readonly ModelsRefreshTarget[];
}

export interface GatewayProviders {
  readonly enumerate: (facts: GatewayRouteFacts, model: string, kind: ModelKind) => Promise<EnumeratedCandidates>;
}

export type ResponsesStoreMode =
  | { readonly kind: 'http'; readonly store: boolean | undefined }
  | { readonly kind: 'foreign' };

export type OpenResponsesStore = (mode: ResponsesStoreMode) => OpenAIResponsesStatefulStore;

export type { PerformanceRecord } from '../shared/telemetry/performance-record.ts';

interface WebSearchProviderPort {
  (): Promise<ConfiguredWebSearchProvider>;
  readonly alphaSearch: () => Promise<WebSearchConfig['passthroughOpenAiSearch']>;
}

export type UsageWriteOutcome = 'written' | { readonly error: ErrorSnapshot };

export interface UsageWriteReceipt {
  readonly usage: UsageWriteOutcome;
  readonly lastUsedAt: UsageWriteOutcome;
}

export interface GatewayServices extends ProviderServices, ProviderRuntimeServices {
  readonly providers: GatewayProviders;
  readonly modelsRefresh: (target: ModelsRefreshTarget) => Promise<
    { readonly refreshed: true } | { readonly refreshed: false; readonly error: ErrorSnapshot }
  >;
  readonly affinityCodec: Pick<AffinityCodec, 'wrap' | 'unwrap'>;
  readonly sidecarCodecs: SidecarCodecFactory;
  readonly responsesStore: OpenResponsesStore;
  readonly usageStore: { readonly record: (row: UsageRecord) => Promise<UsageWriteReceipt> };
  readonly performanceStore: { readonly record: (record: PerformanceRecord) => Promise<void> };
  readonly searchUsageStore: { readonly record: (row: WebSearchUsageRecord) => Promise<void> };
  readonly webSearchProvider: WebSearchProviderPort;
}

export const createUsageStore = (
  writeUsage: (row: UsageRecord) => Promise<void>, touchKey: (keyId: string) => Promise<void>,
): GatewayServices['usageStore'] => {
  const write = async (effect: () => Promise<void>): Promise<UsageWriteOutcome> => {
    try {
      await effect();
      return 'written';
    } catch (error) {
      return { error: snapshotError(error) };
    }
  };
  return {
    async record(row) {
      const [usage, lastUsedAt] = await Promise.all([write(() => writeUsage(row)), write(() => touchKey(row.keyId))]);
      return { usage, lastUsedAt };
    },
  };
};

const shuffled = <T>(items: readonly T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
};

const enumerateProvider = (record: StoredUpstreamRecord, modelId: string, kind: ModelKind, now: number) => {
  const prefix = record.modelPrefix;
  const lookupIds = prefix === null ? [modelId] : prefix.addressable.flatMap(form => {
    if (form === 'unprefixed') return [modelId];
    return modelId.startsWith(prefix.prefix) ? [modelId.slice(prefix.prefix.length)] : [];
  });
  if (lookupIds.length === 0) return { candidates: [], sawModel: false, modelsError: false, stale: false };

  const snapshot = readUpstreamModelsSnapshot(record.modelsCache);
  const disabled = new Set(record.disabledPublicModelIds);
  const candidates: RouteCandidate[] = [];
  let sawModel = false;
  let upstream: UpstreamFacts | undefined;
  for (const id of lookupIds) {
    const match = snapshot.models.find(model => model.id === id && !disabled.has(model.id));
    if (match === undefined) continue;
    sawModel = true;
    if (match.kind !== kind) continue;
    const providerModel = toProviderModelFacts(match);
    upstream ??= toUpstreamFacts(record);
    candidates.push({
      upstreamId: record.id,
      upstreamName: record.name,
      kind: record.kind,
      upstream,
      modelId: providerModel.id,
      upstreamModelId: providerModel.upstreamModelId,
      endpoints: providerModel.endpoints,
      limits: providerModel.limits,
      providerModel,
    });
  }
  return { candidates, sawModel, modelsError: snapshot.lastError !== null, stale: shouldScheduleModelsRefresh(record.modelsCache, now) };
};

const enumerateReal = async (
  facts: GatewayRouteFacts, records: readonly StoredUpstreamRecord[], modelId: string, kind: ModelKind,
): Promise<EnumeratedCandidates> => {
  const allowed = await checkMany(facts['request.auth.user'], records.map(record => ({
    target: { kind: 'upstreamModel', upstreamId: record.id, model: { kind: 'exact', value: modelId } },
    requirement: { permission: 'Model.Use' },
  })));
  const groups: RouteCandidate[][] = [];
  const failedUpstreams: string[] = [];
  const staleRefreshes: ModelsRefreshTarget[] = [];
  let sawModel = false;
  const now = Date.now();
  for (const [index, record] of records.entries()) {
    if (!allowed[index]) continue;
    const result = enumerateProvider(record, modelId, kind, now);
    if (result.candidates.length > 0) groups.push(result.candidates);
    if (result.modelsError) failedUpstreams.push(record.name);
    if (result.stale) staleRefreshes.push({ upstreamId: record.id, configVersion: record.configVersion, inputHash: modelsRefreshInputHash(record) });
    sawModel ||= result.sawModel;
  }
  return {
    candidates: (facts['request.route.randomizeUpstreams'] ? shuffled(groups) : groups).flat(),
    sawModel,
    failedUpstreams,
    staleRefreshes,
  };
};

const createRequestDirectory = (runtimeLocation: string) => {
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
  const list = async (upstreamIds: readonly string[] | null): Promise<readonly StoredUpstreamRecord[]> => {
    const loaded = await loadDirectory();
    return upstreamIds === null ? loaded.enabled : upstreamIds.flatMap(id => {
      const upstream = loaded.upstreamById.get(id);
      return upstream === undefined ? [] : [upstream];
    });
  };
  const enumerate: GatewayProviders['enumerate'] = async (facts, model, kind) => {
    const listed = await list(facts['request.route.upstreamIds']);
    const alias = await getRepo().modelAliases.getByName(model);
    if (alias === null) return await enumerateReal(facts, listed, model, kind);

    const targets = alias.selection === 'first-available' ? alias.targets : shuffled(alias.targets);
    const candidates: RouteCandidate[] = [];
    const failed = new Set<string>();
    const stale = new Map<string, ModelsRefreshTarget>();
    let sawModel = false;
    for (const target of targets) {
      const result = await enumerateReal(facts, listed, target.target_model_id, kind);
      sawModel ||= result.sawModel;
      for (const upstream of result.failedUpstreams) failed.add(upstream);
      for (const refresh of result.staleRefreshes) stale.set(refresh.upstreamId, refresh);
      for (const candidate of result.candidates) candidates.push({ ...candidate, rules: target.rules });
    }
    return {
      candidates: uniqWith(candidates, (a, b) => a.modelId === b.modelId && a.upstreamId === b.upstreamId && isEqual(a.rules, b.rules)),
      sawModel,
      failedUpstreams: [...failed],
      staleRefreshes: [...stale.values()],
    };
  };
  return {
    providers: { enumerate },
    fetcher: (upstreamId: string) => requireDirectory().fetcher(upstreamId),
  };
};

export const createGatewayServices = (options: {
  readonly apiKey: ApiKey;
  readonly runtimeLocation: string;
  readonly requestStartedAt?: number;
  readonly responsesStore?: OpenResponsesStore;
  readonly providerServices?: ProviderRuntimeServices;
}): GatewayServices => {
  const { apiKey, runtimeLocation, requestStartedAt = Date.now(), responsesStore, providerServices = providerRuntimeServices } = options;
  let searchConfig: ReturnType<typeof loadWebSearchConfig> | undefined;
  const loadSearchConfig = () => searchConfig ??= loadWebSearchConfig();
  const webSearchProvider = Object.assign(
    async () => resolveConfiguredWebSearchProvider(await loadSearchConfig()),
    { alphaSearch: async () => (await loadSearchConfig()).passthroughOpenAiSearch },
  );
  return Object.freeze<GatewayServices>({
    ...providerServices,
    ...createRequestDirectory(runtimeLocation),
    modelsRefresh: async target => {
      try {
        await refreshModels(target, runtimeLocation);
        return { refreshed: true };
      } catch (error) {
        console.error('Failed to refresh upstream models:', error);
        return { refreshed: false, error: snapshotError(error) };
      }
    },
    affinityCodec: new AffinityCodec(apiKey.serverSecret, resolveLegacyOpaqueBlobCompatibilityIdentity),
    sidecarCodecs: createSidecarCodecFactory(apiKey.serverSecret),
    responsesStore: responsesStore ?? (mode => mode.kind === 'http'
      ? createOpenAIResponsesHttpStore(apiKey, requestStartedAt, mode.store)
      : createNonOpenAIResponsesSourceStore(apiKey.id)),
    usageStore: createUsageStore(
      row => getRepo().usage.record(row),
      async keyId => { await getRepo().apiKeys.update(keyId, { lastUsedAt: new Date().toISOString() }); },
    ),
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
    searchUsageStore: { record: row => getRepo().webSearchUsage.record(row) },
    webSearchProvider,
  });
};
