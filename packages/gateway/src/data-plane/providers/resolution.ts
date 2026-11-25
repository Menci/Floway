import { isEqual, uniqWith } from 'es-toolkit';

import { internalModelFromProviderModel } from './catalog.ts';
import { modelCatalogSource, readUpstreamModelsSnapshotAndScheduleRefresh, type ModelCatalogSource } from './models-cache.ts';
import { listModelProviders, selectEnabledUpstreams, type GatewayProvider } from './registry.ts';
import { checkMany } from '../../access-control/check.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { createModelsRefreshScheduler, type ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord, StoredUpstreamRecord, User } from '../../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { AliasRules, ModelKind } from '@floway-dev/protocols/common';
import type { Fetcher, ModelCandidate, ProviderModel } from '@floway-dev/provider';

type Subject = Pick<User, 'id' | 'isAdmin'>;

interface CatalogCandidate<Source> {
  readonly source: Source;
  readonly model: ProviderModel;
  readonly rules?: AliasRules;
}

interface CandidateSearch<Candidate> {
  readonly candidates: readonly Candidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}

// Resolve one inbound id against one upstream. The upstream's
// `modelPrefix.addressable` configuration decides which lookup branches
// apply: an `unprefixed`-addressable upstream is probed with the inbound id
// verbatim; a `prefixed`-addressable upstream is probed with the inbound id
// minus its configured prefix when (and only when) the inbound carries that
// prefix. Both branches are evaluated against the same persisted catalog
// snapshot — a single upstream typically contributes at most one candidate,
// but a catalog that publishes both the bare and prefixed forms can match
// twice and both go through.
//
// `kind` is threaded down here so a wrong-kind catalog entry never becomes
// a candidate. `sawModel` is true whenever the lookup id appeared in the
// catalog regardless of kind, so the caller can distinguish
// "id is unknown to this upstream" from "id exists but wrong kind".
const enumerateOneUpstreamCandidates = <Source extends ModelCatalogSource>(
  source: Source,
  modelId: string,
  kind: ModelKind,
  scheduleRefresh: ModelsRefreshScheduler,
): { candidates: CatalogCandidate<Source>[]; sawModel: boolean; modelsError: boolean } => {
  const cfg = source.modelPrefix;
  const lookupIds: string[] = [];
  if (cfg === null) {
    lookupIds.push(modelId);
  } else {
    for (const form of cfg.addressable) {
      if (form === 'unprefixed') lookupIds.push(modelId);
      else if (form === 'prefixed' && modelId.startsWith(cfg.prefix)) lookupIds.push(modelId.slice(cfg.prefix.length));
    }
  }
  if (lookupIds.length === 0) return { candidates: [], sawModel: false, modelsError: false };

  const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(source, scheduleRefresh);
  const disabled = new Set(source.disabledPublicModelIds);
  const candidates: CatalogCandidate<Source>[] = [];
  let sawModel = false;
  for (const lookupId of lookupIds) {
    const match = snapshot.models.find(m => m.id === lookupId && !disabled.has(m.id));
    if (!match) continue;
    sawModel = true;
    if (match.kind === kind) {
      candidates.push({ source, model: match });
    }
  }
  return { candidates, sawModel, modelsError: snapshot.lastError !== null };
};

// Fisher-Yates ordering is shared by the two independent routing axes:
// alias targets and the non-empty upstream candidate groups produced for one
// concrete model. Keeping the calls independent lets each alias target choose
// its own upstream order without introducing request-scoped routing state.
const shuffled = <T>(items: readonly T[]): T[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

// Walk configured upstreams permitted by Model.Use for this ID. Snapshot reads never wait
// for upstream model-list I/O; cold and stale rows submit background refresh.
// Scheduling failures propagate as internal errors rather than being reported
// as persisted model-list failures for an upstream.
//
// `sawModel` aggregates only permitted catalogs, regardless of kind. Denied
// entries do not disclose model existence through this signal.
const enumerateCatalogModelCandidates = async <Source extends ModelCatalogSource>(
  subject: Subject,
  modelId: string,
  kind: ModelKind,
  sources: readonly Source[],
  context: {
    randomizeUpstreams: boolean;
    scheduleRefresh: ModelsRefreshScheduler;
  },
): Promise<CandidateSearch<CatalogCandidate<Source>>> => {
  const { randomizeUpstreams, scheduleRefresh } = context;
  const allowed = await checkMany(subject, sources.map(source => ({
    target: { kind: 'upstreamModel' as const, upstreamId: source.upstreamId, model: { kind: 'exact' as const, value: modelId } },
    requirement: { permission: 'Model.Use' as const },
  })));
  const failedUpstreams: string[] = [];
  const candidateGroups: CatalogCandidate<Source>[][] = [];
  let sawModel = false;
  for (let index = 0; index < sources.length; index++) {
    if (!allowed[index]) continue;
    const source = sources[index]!;
    const result = enumerateOneUpstreamCandidates(source, modelId, kind, scheduleRefresh);
    if (result.candidates.length > 0) candidateGroups.push(result.candidates);
    sawModel = sawModel || result.sawModel;
    if (result.modelsError) failedUpstreams.push(source.name);
  }
  const orderedGroups = randomizeUpstreams ? shuffled(candidateGroups) : candidateGroups;
  return { candidates: orderedGroups.flat(), sawModel, failedUpstreams };
};

const modelCandidate = (
  { source: provider, model, rules }: CatalogCandidate<GatewayProvider>,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
): ModelCandidate => ({
  provider,
  model: internalModelFromProviderModel(model, provider.upstreamId),
  fetcher: fetcherForUpstream(provider.upstreamId),
  ...(rules === undefined ? {} : { rules }),
});

export const enumerateRealModelCandidates = async (
  subject: Subject,
  modelId: string,
  kind: ModelKind,
  providers: readonly GatewayProvider[],
  context: {
    fetcherForUpstream: (upstreamId: string) => Fetcher;
    randomizeUpstreams: boolean;
    scheduleRefresh: ModelsRefreshScheduler;
  },
): Promise<CandidateSearch<ModelCandidate>> => {
  const { candidates, ...diagnostics } = await enumerateCatalogModelCandidates(subject, modelId, kind, providers, context);
  return { ...diagnostics, candidates: candidates.map(candidate => modelCandidate(candidate, context.fetcherForUpstream)) };
};

const orderAliasTargets = (alias: ModelAliasRecord): readonly ModelAliasRecord['targets'][number][] => {
  if (alias.selection === 'first-available') return alias.targets;
  return shuffled(alias.targets);
};

export const enumerateModelCandidates = async ({
  subject, upstreamIds, randomizeUpstreams, model, kind, scheduler, runtimeLocation,
}: {
  subject: Subject;
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  randomizeUpstreams: boolean;
  model: string;
  kind: ModelKind;
  scheduler: BackgroundScheduler;
  // Runtime location tag for this request — see GatewayCtx.runtimeLocation.
  // Threaded into the per-request fetcher so colo-scoped fallback entries
  // can be honoured at dial time.
  runtimeLocation: string;
}): Promise<CandidateSearch<ModelCandidate>> => {
  const upstreams = await getRepo().upstreams.list();
  const [createFetcherForUpstream, listedProviders] = await Promise.all([
    createPerRequestFetcher(runtimeLocation, upstreams),
    listModelProviders(upstreamIds, upstreams),
  ]);
  const { candidates, ...diagnostics } = await resolveCatalogCandidates(subject, model, kind, listedProviders, {
    randomizeUpstreams,
    scheduleRefresh: createModelsRefreshScheduler(runtimeLocation, scheduler),
  });
  return { ...diagnostics, candidates: candidates.map(candidate => modelCandidate(candidate, createFetcherForUpstream)) };
};

export interface FindCandidatesInput {
  readonly subject: Subject;
  readonly upstreamIds: readonly string[] | null;
  readonly randomizeUpstreams: boolean;
  readonly model: string;
  readonly kind: ModelKind;
  readonly scheduleRefresh: ModelsRefreshScheduler;
}

export const findCatalogCandidates = async (
  upstreams: readonly StoredUpstreamRecord[],
  { subject, model, kind, upstreamIds, randomizeUpstreams, scheduleRefresh }: FindCandidatesInput,
): Promise<CandidateSearch<{ readonly upstream: StoredUpstreamRecord; readonly model: ProviderModel; readonly rules?: AliasRules }>> => {
  const sources = selectEnabledUpstreams(upstreamIds, upstreams).map(upstream => ({ ...modelCatalogSource(upstream), upstream }));
  const { candidates, ...diagnostics } = await resolveCatalogCandidates(subject, model, kind, sources, { randomizeUpstreams, scheduleRefresh });
  return {
    ...diagnostics,
    candidates: candidates.map(({ source, model: matched, rules }) => ({
      upstream: source.upstream,
      model: matched,
      ...(rules === undefined ? {} : { rules }),
    })),
  };
};

// Alias targets walk the real catalog directly, including aliases that share a real model's name.
const resolveCatalogCandidates = async <Source extends ModelCatalogSource>(
  subject: Subject,
  model: string,
  kind: ModelKind,
  sources: readonly Source[],
  context: { randomizeUpstreams: boolean; scheduleRefresh: ModelsRefreshScheduler },
): Promise<CandidateSearch<CatalogCandidate<Source>>> => {
  const alias = await getRepo().modelAliases.getByName(model);
  if (alias === null) {
    return await enumerateCatalogModelCandidates(subject, model, kind, sources, context);
  }

  // Walk every target, tag each returned candidate with the target's rule
  // overlay, then flatten (target order preserved), and dedup by
  // (modelId, upstreamId, rules). Different rules against the same
  // (model, upstream) stay as distinct entries so the operator can pin the
  // same physical binding under two rule variants.
  const aggregatedFailed = new Set<string>();
  let sawModel = false;
  const flat: CatalogCandidate<Source>[] = [];
  for (const target of orderAliasTargets(alias)) {
    const result = await enumerateCatalogModelCandidates(subject, target.target_model_id, kind, sources, context);
    for (const name of result.failedUpstreams) aggregatedFailed.add(name);
    if (result.sawModel) sawModel = true;
    for (const candidate of result.candidates) {
      flat.push({ ...candidate, rules: target.rules });
    }
  }
  const deduped = uniqWith(flat, (candidate, existing) =>
    candidate.model.id === existing.model.id
    && candidate.source.upstreamId === existing.source.upstreamId
    && isEqual(candidate.rules, existing.rules));
  return {
    candidates: deduped,
    sawModel,
    failedUpstreams: [...aggregatedFailed],
  };
};
