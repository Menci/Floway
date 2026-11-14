import { isEqual, uniqWith } from 'es-toolkit';

import { internalModelFromProviderModel } from './catalog.ts';
import { readUpstreamModelsSnapshotAndScheduleRefresh } from './models-cache.ts';
import { listModelProviders, type GatewayProvider } from './registry.ts';
import { checkMany } from '../../access-control/check.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { createModelsRefreshScheduler, type ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord, User } from '../../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { Fetcher, ModelCandidate } from '@floway-dev/provider';

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
const enumerateOneUpstreamCandidates = (
  provider: GatewayProvider,
  modelId: string,
  kind: ModelKind,
  context: {
    fetcher: Fetcher;
    scheduleRefresh: ModelsRefreshScheduler;
  },
): { candidates: ModelCandidate[]; sawModel: boolean; modelsError: boolean } => {
  const { fetcher, scheduleRefresh } = context;
  const cfg = provider.modelPrefix;
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

  const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(provider, scheduleRefresh);
  const disabled = new Set(provider.disabledPublicModelIds);
  const candidates: ModelCandidate[] = [];
  let sawModel = false;
  for (const lookupId of lookupIds) {
    const match = snapshot.models.find(m => m.id === lookupId && !disabled.has(m.id));
    if (!match) continue;
    sawModel = true;
    if (match.kind === kind) {
      candidates.push({ provider, model: internalModelFromProviderModel(match, provider.upstreamId), fetcher });
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
export const enumerateRealModelCandidates = async (
  subject: User,
  modelId: string,
  kind: ModelKind,
  providers: readonly GatewayProvider[],
  context: {
    fetcherForUpstream: (upstreamId: string) => Fetcher;
    randomizeUpstreams: boolean;
    scheduleRefresh: ModelsRefreshScheduler;
  },
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const { fetcherForUpstream, randomizeUpstreams, scheduleRefresh } = context;
  const allowed = await checkMany(subject, providers.map(provider => ({
    target: { kind: 'upstreamModel' as const, upstreamId: provider.upstreamId, model: { kind: 'exact' as const, value: modelId } },
    requirement: { permission: 'Model.Use' as const },
  })));
  const failedUpstreams: string[] = [];
  const candidateGroups: ModelCandidate[][] = [];
  let sawModel = false;
  for (let index = 0; index < providers.length; index++) {
    if (!allowed[index]) continue;
    const provider = providers[index]!;
    const result = enumerateOneUpstreamCandidates(provider, modelId, kind, {
      fetcher: fetcherForUpstream(provider.upstreamId),
      scheduleRefresh,
    });
    if (result.candidates.length > 0) candidateGroups.push(result.candidates);
    sawModel = sawModel || result.sawModel;
    if (result.modelsError) failedUpstreams.push(provider.name);
  }
  const orderedGroups = randomizeUpstreams ? shuffled(candidateGroups) : candidateGroups;
  return { candidates: orderedGroups.flat(), sawModel, failedUpstreams };
};

const orderAliasTargets = (alias: ModelAliasRecord): readonly ModelAliasRecord['targets'][number][] => {
  if (alias.selection === 'first-available') return alias.targets;
  return shuffled(alias.targets);
};

// Per-request model resolution. Two-branch chain:
//
//   1. Look the inbound id up in the alias repo. When the id names an
//      alias, walk every target in `selection`-mode order, delegate to the
//      real-catalog resolver for each one, tag each returned candidate
//      with that target's rule overlay, flatten across targets, and dedup
//      by (modelId, upstreamId, rules) — same (model, upstream) with
//      differing rules stays as distinct candidates so both variants can
//      be dispatched. `iterateCandidates` at the serve layer then cascades
//      across every kept candidate: a target's upstreams all failing over
//      falls through into the next target's candidates instead of hard-
//      failing at the first target.
//   2. Otherwise (no alias match at all) run the real-catalog resolver
//      directly on the inbound id.
//
// The real-catalog resolver applies Model.Use before reading each catalog,
// then filters by kind. `sawModel` tracks non-disabled addressable matches in
// permitted catalogs. With no candidates, false keeps hidden/missing IDs at 404;
// true identifies wrong-kind matches (400).
//
// Endpoint-level narrowing — picking the chat target protocol from
// `model.endpoints`, or checking the specific `openaiImagesEdits` /
// `openaiImagesGenerations` / `openaiAudioTranscriptions` / `openaiCompletions` endpoint key —
// is the caller's job.
// This function stays endpoint-blind so the same path serves chat,
// OpenAI Embeddings, OpenAI Images Generations/Edits, rerank, OpenAI Audio
// Transcriptions, and OpenAI Completions.
//
// The alias walk is a natural top-of-chain check: by construction an
// alias's target id is a real model id, so the shadow pattern (an alias
// whose first target matches its own name) resolves to the real model on
// the first pass; alias names never re-enter the alias layer.
export const enumerateModelCandidates = async ({
  subject, upstreamIds, randomizeUpstreams, model, kind, scheduler, runtimeLocation,
}: {
  subject: User;
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
}): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const upstreams = await getRepo().upstreams.list();
  const [createFetcherForUpstream, listedProviders] = await Promise.all([
    createPerRequestFetcher(runtimeLocation, upstreams),
    listModelProviders(upstreamIds, upstreams),
  ]);
  const resolutionContext = {
    fetcherForUpstream: createFetcherForUpstream,
    randomizeUpstreams,
    scheduleRefresh: createModelsRefreshScheduler(runtimeLocation, scheduler),
  };

  const alias = await getRepo().modelAliases.getByName(model);
  if (alias === null) {
    return await enumerateRealModelCandidates(subject, model, kind, listedProviders, resolutionContext);
  }

  // Walk every target, tag each returned candidate with the target's rule
  // overlay, then flatten (target order preserved), and dedup by
  // (modelId, upstreamId, rules). Different rules against the same
  // (model, upstream) stay as distinct entries so the operator can pin the
  // same physical binding under two rule variants.
  const aggregatedFailed = new Set<string>();
  let sawModel = false;
  const flat: ModelCandidate[] = [];
  for (const target of orderAliasTargets(alias)) {
    const result = await enumerateRealModelCandidates(subject, target.target_model_id, kind, listedProviders, resolutionContext);
    for (const name of result.failedUpstreams) aggregatedFailed.add(name);
    if (result.sawModel) sawModel = true;
    for (const candidate of result.candidates) {
      flat.push({ ...candidate, rules: target.rules });
    }
  }
  const deduped = uniqWith(flat, (candidate, existing) =>
    candidate.model.id === existing.model.id
    && candidate.provider.upstreamId === existing.provider.upstreamId
    && isEqual(candidate.rules, existing.rules));
  return {
    candidates: deduped,
    sawModel,
    failedUpstreams: [...aggregatedFailed],
  };
};
