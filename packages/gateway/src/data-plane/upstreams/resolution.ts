import { isEqual, uniqWith } from 'es-toolkit';

import { createUpstream } from './registry.ts';
import { createAccessResolver } from '../../access-control/resolution.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord, ResolvedUpstreamModelMatch, StoredUpstreamRecord, User } from '../../repo/types.ts';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { Fetcher, ModelCandidate, Upstream } from '@floway-dev/upstream';

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
  upstreamFor: (upstream: StoredUpstreamRecord) => Upstream,
  fetcherFor: (upstreamId: string) => Fetcher,
): { readonly candidates: readonly ModelCandidate[]; readonly sawModel: boolean } => {
  if (matches.length === 0) return { candidates: [], sawModel: false };

  const groupsByUpstream = new Map<string, ModelCandidate[]>();
  const groupOrder: ModelCandidate[][] = [];
  let sawModel = false;

  for (const match of matches) {
    sawModel = true;
    if (match.model.kind !== kind) continue;
    const upstream = upstreamFor(match.upstream);
    const candidate: ModelCandidate = {
      upstream,
      model: match.model,
      fetcher: fetcherFor(upstream.upstreamId),
    };
    let group = groupsByUpstream.get(upstream.upstreamId);
    if (group === undefined) {
      group = [];
      groupsByUpstream.set(upstream.upstreamId, group);
      groupOrder.push(group);
    }
    group.push(candidate);
  }

  const orderedGroups = randomizeUpstreams ? shuffled(groupOrder) : groupOrder;
  return { candidates: orderedGroups.flat(), sawModel };
};

// Per-request model resolution. Speculatively issues alias lookup, direct
// `upstream_models` resolution, and (for non-admin callers) group membership in
// one parallel RTT so direct hits pay 1 metadata RTT for admins and 2 for
// non-admins, plus an optional proxy-load RTT only when matched upstreams
// reference configured proxies. Only permitted, matched upstreams are
// instantiated as `Provider`s.
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
  const [alias, directMatches, subjectGroupIds] = await Promise.all([
    repo.modelAliases.getByName(model),
    repo.upstreamModels.resolve({ modelIds: [model], upstreamIds }),
    subject.isAdmin ? Promise.resolve(null) : repo.groups.listIdsByUserId(subject.id),
  ]);

  const orderedTargets = alias === null ? null : orderAliasTargets(alias);
  if (orderedTargets === null && directMatches.length === 0) {
    return { candidates: [], sawModel: false };
  }

  const targetModelIds = orderedTargets === null
    ? null
    : [...new Set(orderedTargets.map(target => target.target_model_id))];

  const [rawMatches, accessRecords] = await Promise.all([
    targetModelIds === null
      ? Promise.resolve(directMatches)
      : repo.upstreamModels.resolve({ modelIds: targetModelIds, upstreamIds }),
    subjectGroupIds === null
      ? Promise.resolve(null)
      : repo.accessRecords.listByPrincipals([
          { kind: 'user' as const, id: subject.id },
          ...subjectGroupIds.map(id => ({ kind: 'group' as const, id })),
        ]),
  ]);
  if (rawMatches.length === 0) {
    return { candidates: [], sawModel: false };
  }

  let permittedMatches: readonly ResolvedUpstreamModelMatch[];
  if (accessRecords === null) {
    permittedMatches = rawMatches;
  } else {
    const resolver = createAccessResolver(accessRecords);
    const evaluation = { targetGroups: new Set<number>(), subjectUserId: subject.id };
    const requirement = { permission: 'Model.Use' as const };
    const allowedByKey = new Map<string, boolean>();
    permittedMatches = rawMatches.filter(match => {
      const key = `${match.upstream.id}\0${match.matchedInputId}`;
      let allowed = allowedByKey.get(key);
      if (allowed === undefined) {
        allowed = resolver.satisfies(
          { kind: 'upstreamModel', upstreamId: match.upstream.id, model: { kind: 'exact', value: match.matchedInputId } },
          requirement,
          evaluation,
        );
        allowedByKey.set(key, allowed);
      }
      return allowed;
    });
  }
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
  const upstreamCache = new Map<string, Upstream>();
  const upstreamFor = (record: StoredUpstreamRecord): Upstream => {
    let upstream = upstreamCache.get(record.id);
    if (upstream === undefined) {
      upstream = createUpstream(record);
      upstreamCache.set(record.id, upstream);
    }
    return upstream;
  };

  if (orderedTargets === null) {
    return buildTargetCandidates(permittedMatches, kind, randomizeUpstreams, upstreamFor, fetcherFor);
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
    const result = buildTargetCandidates(targetMatches, kind, randomizeUpstreams, upstreamFor, fetcherFor);
    if (result.sawModel) sawModel = true;
    for (const candidate of result.candidates) {
      flat.push({ ...candidate, rules: target.rules });
    }
  }
  const deduped = uniqWith(flat, (candidate, existing) =>
    candidate.model.id === existing.model.id
    && candidate.upstream.upstreamId === existing.upstream.upstreamId
    && isEqual(candidate.rules, existing.rules));
  return { candidates: deduped, sawModel };
};
