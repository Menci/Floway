import { isEqual, uniqWith } from 'es-toolkit';

import { createAccessResolver } from '../../access-control/resolution.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord, ResolvedUpstreamModelMatch, StoredUpstreamRecord, User } from '../../repo/types.ts';
import type { AliasRules, ModelKind } from '@floway-dev/protocols/common';
import type { UpstreamModel } from '@floway-dev/upstream';

export interface ResolvedModelCandidate {
  readonly upstream: StoredUpstreamRecord;
  readonly model: UpstreamModel;
  readonly rules?: AliasRules;
}

interface ModelCandidateResolution {
  readonly candidates: readonly ResolvedModelCandidate[];
  readonly sawModel: boolean;
}

interface ResolveModelCandidatesOptions {
  subject: Pick<User, 'id' | 'isAdmin'>;
  upstreamIds: readonly string[] | null;
  randomizeUpstreams: boolean;
  model: string;
  kind: ModelKind;
}

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
): ModelCandidateResolution => {
  const groupsByUpstream = new Map<string, ResolvedModelCandidate[]>();

  for (const { upstream, model } of matches) {
    if (model.kind !== kind) continue;
    let group = groupsByUpstream.get(upstream.id);
    if (group === undefined) {
      group = [];
      groupsByUpstream.set(upstream.id, group);
    }
    group.push({ upstream, model });
  }

  const groupOrder = [...groupsByUpstream.values()];
  const orderedGroups = randomizeUpstreams ? shuffled(groupOrder) : groupOrder;
  return { candidates: orderedGroups.flat(), sawModel: matches.length > 0 };
};

// Per-request model resolution. Speculatively issues alias lookup, direct
// `upstream_models` resolution, and (for non-admin callers) group membership in
// one parallel RTT so direct hits pay 1 metadata RTT for admins and 2 for
// non-admins.
export const resolveModelCandidates = async ({
  subject, upstreamIds, randomizeUpstreams, model, kind,
}: ResolveModelCandidatesOptions): Promise<ModelCandidateResolution> => {
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

  if (orderedTargets === null) {
    return buildTargetCandidates(permittedMatches, kind, randomizeUpstreams);
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
  const flat: ResolvedModelCandidate[] = [];
  for (const target of orderedTargets) {
    const targetMatches = matchesByInputId.get(target.target_model_id) ?? [];
    const result = buildTargetCandidates(targetMatches, kind, randomizeUpstreams);
    if (result.sawModel) sawModel = true;
    for (const candidate of result.candidates) {
      flat.push({ ...candidate, rules: target.rules });
    }
  }
  const deduped = uniqWith(flat, (candidate, existing) =>
    candidate.model.id === existing.model.id
    && candidate.upstream.id === existing.upstream.id
    && isEqual(candidate.rules, existing.rules));
  return { candidates: deduped, sawModel };
};
