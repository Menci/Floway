import { isEqual, uniqWith } from 'es-toolkit';

import { internalModelFromProviderModel } from './catalog.ts';
import { createProvider } from './registry.ts';
import { checkMany } from '../../access-control/check.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord, ResolvedUpstreamModelMatch, StoredUpstreamRecord, User } from '../../repo/types.ts';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { Fetcher, ModelCandidate, Provider } from '@floway-dev/provider';

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

const orderAliasTargets = (alias: ModelAliasRecord): readonly ModelAliasRecord['targets'][number][] => {
  if (alias.selection === 'first-available') return alias.targets;
  return shuffled(alias.targets);
};

// Build candidates for one concrete inbound model id from pre-resolved,
// Model.Use-authorized matches. Grouping by upstream keeps dual-form hits
// (unprefixed + prefixed on the same upstream) together when randomizing.
const buildTargetCandidates = (
  matches: readonly ResolvedUpstreamModelMatch[],
  kind: ModelKind,
  randomizeUpstreams: boolean,
  providerFor: (upstream: StoredUpstreamRecord) => Provider,
  fetcherFor: (upstreamId: string) => Fetcher,
): { readonly candidates: readonly ModelCandidate[]; readonly sawModel: boolean } => {
  if (matches.length === 0) return { candidates: [], sawModel: false };

  const groupsByUpstream = new Map<string, ModelCandidate[]>();
  const groupOrder: ModelCandidate[][] = [];
  let sawModel = false;

  for (const match of matches) {
    sawModel = true;
    if (match.model.kind !== kind) continue;
    const provider = providerFor(match.upstream);
    const candidate: ModelCandidate = {
      provider,
      model: internalModelFromProviderModel(match.model, provider.upstreamId),
      fetcher: fetcherFor(provider.upstreamId),
    };
    let group = groupsByUpstream.get(provider.upstreamId);
    if (group === undefined) {
      group = [];
      groupsByUpstream.set(provider.upstreamId, group);
      groupOrder.push(group);
    }
    group.push(candidate);
  }

  const orderedGroups = randomizeUpstreams ? shuffled(groupOrder) : groupOrder;
  return { candidates: orderedGroups.flat(), sawModel };
};

// Per-request model resolution. Two-branch chain:
//
//   1. Look the inbound id up in the alias repo. When the id names an alias,
//      batch-resolve every target id against `upstream_models` in one query,
//      check `Model.Use`, tag each candidate with that target's rule overlay,
//      flatten across targets in `selection`-mode order, and dedup by
//      (modelId, upstreamId, rules).
//   2. Otherwise resolve the inbound id directly against `upstream_models`.
//
// Resolution queries `upstream_models` directly by inbound id (unprefixed via
// `idx_upstream_models_model_id`; prefixed via `idx_upstreams_model_prefix` ->
// PK lookup on `upstream_models`) and joins only the matched `upstreams` rows.
// Only permitted, matched upstreams are instantiated as `Provider`s and have
// their referenced proxies loaded.
export const enumerateModelCandidates = async ({
  subject, upstreamIds, randomizeUpstreams, model, kind, runtimeLocation,
}: {
  subject: User;
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  randomizeUpstreams: boolean;
  model: string;
  kind: ModelKind;
  // Runtime location tag for this request — see GatewayCtx.runtimeLocation.
  // Threaded into the per-request fetcher so colo-scoped fallback entries
  // can be honoured at dial time.
  runtimeLocation: string;
}): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
}> => {
  if (upstreamIds !== null && upstreamIds.length === 0) {
    return { candidates: [], sawModel: false };
  }
  const repo = getRepo();
  const alias = await repo.modelAliases.getByName(model);
  const orderedTargets = alias === null ? null : orderAliasTargets(alias);
  const queryModelIds = orderedTargets === null
    ? [model]
    : [...new Set(orderedTargets.map(target => target.target_model_id))];

  const rawMatches = await repo.upstreamModels.resolve({ modelIds: queryModelIds, upstreamIds });
  if (rawMatches.length === 0) {
    return { candidates: [], sawModel: false };
  }

  // Deduplicate permission checks on (upstreamId, matchedInputId).
  const checkKeyToIndex = new Map<string, number>();
  const checks: {
    target: { kind: 'upstreamModel'; upstreamId: string; model: { kind: 'exact'; value: string } };
    requirement: { permission: 'Model.Use' };
  }[] = [];
  for (const match of rawMatches) {
    const key = `${match.upstream.id}\0${match.matchedInputId}`;
    if (checkKeyToIndex.has(key)) continue;
    checkKeyToIndex.set(key, checks.length);
    checks.push({
      target: { kind: 'upstreamModel', upstreamId: match.upstream.id, model: { kind: 'exact', value: match.matchedInputId } },
      requirement: { permission: 'Model.Use' },
    });
  }
  const allowed = await checkMany(subject, checks);

  const permittedMatches = rawMatches.filter(match => {
    const idx = checkKeyToIndex.get(`${match.upstream.id}\0${match.matchedInputId}`)!;
    return allowed[idx] === true;
  });
  if (permittedMatches.length === 0) {
    return { candidates: [], sawModel: false };
  }

  const matchedUpstreamsById = new Map<string, StoredUpstreamRecord>();
  for (const match of permittedMatches) {
    if (match.model.kind === kind && !matchedUpstreamsById.has(match.upstream.id)) {
      matchedUpstreamsById.set(match.upstream.id, match.upstream);
    }
  }
  if (matchedUpstreamsById.size === 0) {
    return { candidates: [], sawModel: true };
  }

  const fetcherFor = await createPerRequestFetcher(runtimeLocation, [...matchedUpstreamsById.values()]);
  const providerCache = new Map<string, Provider>();
  const providerFor = (upstream: StoredUpstreamRecord): Provider => {
    let provider = providerCache.get(upstream.id);
    if (provider === undefined) {
      provider = createProvider(upstream);
      providerCache.set(upstream.id, provider);
    }
    return provider;
  };

  if (orderedTargets === null) {
    return buildTargetCandidates(permittedMatches, kind, randomizeUpstreams, providerFor, fetcherFor);
  }

  const matchesByInputId = new Map<string, ResolvedUpstreamModelMatch[]>();
  for (const match of permittedMatches) {
    let list = matchesByInputId.get(match.matchedInputId);
    if (list === undefined) {
      list = [];
      matchesByInputId.set(match.matchedInputId, list);
    }
    list.push(match);
  }

  let sawModel = false;
  const flat: ModelCandidate[] = [];
  for (const target of orderedTargets) {
    const targetMatches = matchesByInputId.get(target.target_model_id) ?? [];
    const result = buildTargetCandidates(targetMatches, kind, randomizeUpstreams, providerFor, fetcherFor);
    if (result.sawModel) sawModel = true;
    for (const candidate of result.candidates) {
      flat.push({ ...candidate, rules: target.rules });
    }
  }
  const deduped = uniqWith(flat, (candidate, existing) =>
    candidate.model.id === existing.model.id
    && candidate.provider.upstreamId === existing.provider.upstreamId
    && isEqual(candidate.rules, existing.rules));
  return { candidates: deduped, sawModel };
};
