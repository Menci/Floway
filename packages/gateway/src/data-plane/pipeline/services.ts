import { isEqual, uniqWith } from 'es-toolkit';

import { checkMany } from '../../access-control/check.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { createModelsRefreshScheduler, type ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord, StoredUpstreamRecord, TokenUsage, User } from '../../repo/types.ts';
import { readUpstreamModelsSnapshotAndScheduleRefresh } from '../providers/models-cache.ts';
import { createProvider, listModelProviders, type GatewayProvider } from '../providers/registry.ts';
import type { AttemptState, GatewayCtx } from '../shared/gateway-ctx.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';
import { toProviderModelFacts } from '@floway-dev/provider';
import type {
  ChatTargetApi,
  Fetcher,
  ProviderModel,
  ProviderPipelineServices,
  RouteCandidate,
  TelemetryModelIdentity,
} from '@floway-dev/provider';

export type GatewayTurnAttributionError = { readonly kind: 'gateway' | 'upstream'; readonly upstreamId?: string }
    | { readonly kind: 'failed'; readonly reason: string }
  | null;

const failureReason = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);

export class GatewayTurnAttribution {
  private requestedModelValue: string | null = null;
  private targetApiValue: ChatTargetApi | null = null;
  private winningIdentityValue: TelemetryModelIdentity | null = null;
  private usageValue: TokenUsage | null = null;
  private errorValue: GatewayTurnAttributionError = null;
  status: number | null = null;

  constructor(private readonly dump: GatewayCtx['dump']) {}

  get requestedModel(): string | null {
    return this.requestedModelValue;
  }

  get targetApi(): ChatTargetApi | null {
    return this.targetApiValue;
  }

  get winningIdentity(): TelemetryModelIdentity | null {
    return this.winningIdentityValue;
  }

  get usage(): TokenUsage | null {
    return this.usageValue;
  }

  get error(): GatewayTurnAttributionError {
    return this.errorValue;
  }

  recordRequestedModel(model: string): void {
    this.requestedModelValue = model;
    this.dump?.requestedModel(model);
  }

  recordTargetApi(targetApi: ChatTargetApi): void {
    this.targetApiValue = targetApi;
    this.dump?.setUpstreamTargetApi(targetApi);
  }

  recordSuccess(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.winningIdentityValue = identity;
    this.usageValue = usage;
    this.dump?.success(identity, usage);
  }

  recordError(kind: 'gateway' | 'upstream', upstreamId?: string): void {
    this.errorValue = { kind, ...(upstreamId === undefined ? {} : { upstreamId }) };
    this.dump?.error(kind, upstreamId);
  }

  recordFailure(reason: unknown): void {
    this.errorValue = { kind: 'failed', reason: failureReason(reason) };
    this.dump?.failed(reason);
  }

}

interface EnumeratedRoutes {
  readonly candidates: readonly RouteCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}

const shuffled = <T>(items: readonly T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
};

const orderAliasTargets = (alias: ModelAliasRecord): readonly ModelAliasRecord['targets'][number][] =>
  alias.selection === 'first-available' ? alias.targets : shuffled(alias.targets);

const routeCandidate = (
  provider: GatewayProvider,
  providerModel: ProviderModel,
  rules?: ModelAliasRecord['targets'][number]['rules'],
): RouteCandidate => {
  const normalizedModel = providerModel.kind === 'chat'
    ? {
        ...providerModel,
        chat: {
          ...(providerModel.chat ?? {}),
          image_detail_original: providerModel.chat?.image_detail_original === true,
        },
      }
    : providerModel;
  return Object.freeze({
    upstreamId: provider.upstreamId,
    upstreamName: provider.name,
    kind: provider.kind,
    modelId: normalizedModel.id,
    upstreamModelId: normalizedModel.upstreamModelId,
    endpoints: Object.freeze({ ...normalizedModel.endpoints }),
    limits: Object.freeze({ ...normalizedModel.limits }),
    providerModel: toProviderModelFacts(normalizedModel),
    ...(rules === undefined ? {} : { rules }),
  });
};

export interface GatewayRequestDirectoryOptions {
  readonly user: User;
  readonly upstreamIds: readonly string[] | null;
  readonly randomizeUpstreams: boolean;
  readonly runtimeLocation: string;
  readonly backgroundScheduler: BackgroundScheduler;
  readonly wrapFetcher?: (fetcher: Fetcher, upstreamId: string) => Fetcher;
}

export class GatewayRequestDirectory {
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private upstreamRecords: readonly StoredUpstreamRecord[] = [];
  private upstreamsById = new Map<string, StoredUpstreamRecord>();
  private providers: readonly GatewayProvider[] = [];
  private providersById = new Map<string, GatewayProvider>();
  private rawFetcherForUpstream: (upstreamId: string) => Fetcher = () => {
    throw new Error('GatewayRequestDirectory has not been loaded');
  };
  private scheduleRefresh: ModelsRefreshScheduler = () => {
    throw new Error('GatewayRequestDirectory has not been loaded');
  };

  constructor(private readonly options: GatewayRequestDirectoryOptions) {}

  async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  providerFor(upstreamId: string): GatewayProvider {
    this.assertLoaded();
    const provider = this.providersById.get(upstreamId);
    if (provider !== undefined) return provider;
    const record = this.upstreamsById.get(upstreamId);
    if (record === undefined) throw new Error(`Unknown upstream id: ${upstreamId}`);
    if (!record.enabled) throw new Error(`Upstream is disabled: ${upstreamId}`);
    const created = createProvider(record);
    this.providersById.set(upstreamId, created);
    return created;
  }

  fetcherFor(upstreamId: string): Fetcher {
    this.assertLoaded();
    const raw = this.rawFetcherForUpstream(upstreamId);
    return this.options.wrapFetcher === undefined ? raw : this.options.wrapFetcher(raw, upstreamId);
  }

  async enumerateCandidates(model: string, kind: ModelKind): Promise<EnumeratedRoutes> {
    await this.ensureLoaded();
    const alias = await getRepo().modelAliases.getByName(model);
    if (alias === null) return await this.enumerateRealModelCandidates(model, kind);

    const failedUpstreams = new Set<string>();
    let sawModel = false;
    const flattened: RouteCandidate[] = [];
    for (const target of orderAliasTargets(alias)) {
      const result = await this.enumerateRealModelCandidates(target.target_model_id, kind);
      for (const name of result.failedUpstreams) failedUpstreams.add(name);
      sawModel ||= result.sawModel;
      for (const candidate of result.candidates) {
        flattened.push(Object.freeze({ ...candidate, rules: target.rules }));
      }
    }
    return Object.freeze({
      candidates: Object.freeze(uniqWith(flattened, (candidate, existing) =>
        candidate.modelId === existing.modelId
        && candidate.upstreamId === existing.upstreamId
        && isEqual(candidate.rules, existing.rules))),
      sawModel,
      failedUpstreams: Object.freeze([...failedUpstreams]),
    });
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('GatewayRequestDirectory has not been loaded; call ensureLoaded() first');
  }

  private async load(): Promise<void> {
    this.upstreamRecords = await getRepo().upstreams.list();
    this.upstreamsById = new Map(this.upstreamRecords.map(upstream => [upstream.id, upstream] as const));
    const [rawFetcherForUpstream, listedProviders] = await Promise.all([
      createPerRequestFetcher(this.options.runtimeLocation, this.upstreamRecords),
      listModelProviders(this.options.upstreamIds, this.upstreamRecords),
    ]);
    this.rawFetcherForUpstream = rawFetcherForUpstream;
    this.providers = listedProviders;
    this.providersById = new Map(listedProviders.map(provider => [provider.upstreamId, provider] as const));
    this.scheduleRefresh = createModelsRefreshScheduler(this.options.runtimeLocation, this.options.backgroundScheduler);
    this.loaded = true;
  }

  private async enumerateRealModelCandidates(modelId: string, kind: ModelKind): Promise<EnumeratedRoutes> {
    const allowed = await checkMany(this.options.user, this.providers.map(provider => ({
      target: {
        kind: 'upstreamModel' as const,
        upstreamId: provider.upstreamId,
        model: { kind: 'exact' as const, value: modelId },
      },
      requirement: { permission: 'Model.Use' as const },
    })));
    const failedUpstreams: string[] = [];
    const groups: RouteCandidate[][] = [];
    let sawModel = false;
    for (const [index, provider] of this.providers.entries()) {
      if (!allowed[index]) continue;
      const result = this.enumerateProviderCandidates(provider, modelId, kind);
      if (result.candidates.length > 0) groups.push(result.candidates);
      sawModel ||= result.sawModel;
      if (result.modelsError) failedUpstreams.push(provider.name);
    }
    return Object.freeze({
      candidates: Object.freeze((this.options.randomizeUpstreams ? shuffled(groups) : groups).flat()),
      sawModel,
      failedUpstreams: Object.freeze(failedUpstreams),
    });
  }

  private enumerateProviderCandidates(
    provider: GatewayProvider,
    modelId: string,
    kind: ModelKind,
  ): { readonly candidates: RouteCandidate[]; readonly sawModel: boolean; readonly modelsError: boolean } {
    const prefix = provider.modelPrefix;
    const lookupIds: string[] = [];
    if (prefix === null) {
      lookupIds.push(modelId);
    } else {
      for (const form of prefix.addressable) {
        if (form === 'unprefixed') lookupIds.push(modelId);
        else if (form === 'prefixed' && modelId.startsWith(prefix.prefix)) lookupIds.push(modelId.slice(prefix.prefix.length));
      }
    }
    if (lookupIds.length === 0) return { candidates: [], sawModel: false, modelsError: false };

    const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(provider, this.scheduleRefresh);
    const disabled = new Set(provider.disabledPublicModelIds);
    const candidates: RouteCandidate[] = [];
    let sawModel = false;
    for (const lookupId of lookupIds) {
      const match = snapshot.models.find(model => model.id === lookupId && !disabled.has(model.id));
      if (match === undefined) continue;
      sawModel = true;
      if (match.kind === kind) candidates.push(routeCandidate(provider, match));
    }
    return { candidates, sawModel, modelsError: snapshot.lastError !== null };
  }
}

export interface GatewayPipelineServices extends ProviderPipelineServices {
  readonly apiKeyId: string;
  readonly user: User;
  readonly upstreamIds: readonly string[] | null;
  readonly randomizeUpstreams: boolean;
  readonly runtimeLocation: string;
  readonly backgroundScheduler: BackgroundScheduler;
  readonly ctx: GatewayCtx;
  readonly attempt: AttemptState;
  readonly attribution: GatewayTurnAttribution;
  readonly directory: GatewayRequestDirectory;
  readonly providerFor: (upstreamId: string) => GatewayProvider;
  readonly fetcherFor: (upstreamId: string) => Fetcher;
  readonly onUpstreamDispatch: NonNullable<ProviderPipelineServices['onUpstreamDispatch']>;
  readonly egressState: { error?: unknown };
}

export const createGatewayPipelineServices = (
  ctx: GatewayCtx,
  options: { readonly directory?: GatewayRequestDirectory } = {},
): GatewayPipelineServices => {
  const directory = options.directory ?? new GatewayRequestDirectory({
    user: ctx.user,
    upstreamIds: ctx.upstreamIds,
    randomizeUpstreams: ctx.randomizeUpstreams,
    runtimeLocation: ctx.runtimeLocation,
    backgroundScheduler: ctx.backgroundScheduler,
  });
  return Object.freeze({
    apiKeyId: ctx.apiKeyId,
    user: ctx.user,
    upstreamIds: ctx.upstreamIds,
    randomizeUpstreams: ctx.randomizeUpstreams,
    runtimeLocation: ctx.runtimeLocation,
    backgroundScheduler: ctx.backgroundScheduler,
    ctx,
    attempt: ctx.attempt,
    attribution: new GatewayTurnAttribution(ctx.dump),
    directory,
    providerFor: (upstreamId: string) => directory.providerFor(upstreamId),
    fetcherFor: (upstreamId: string) => directory.fetcherFor(upstreamId),
    onUpstreamDispatch: (info: Parameters<NonNullable<ProviderPipelineServices['onUpstreamDispatch']>>[0]) => {
      if (info.headersAtMs === undefined && ctx.attempt.timing.firstOutputTokenAt === null) {
        ctx.attempt.timing.upstreamCallStartedAt = performance.now();
      }
    },
    egressState: {},
  });
};
