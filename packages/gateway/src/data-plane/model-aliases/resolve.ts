// Alias resolver. Runs once per request, above prefix routing. The target
// string it returns is fed verbatim back into the real-model resolver
// (`enumerateRealModelCandidatesWithDatedRetry`); alias names never re-enter
// the alias layer, so recursion is impossible by construction and the
// shadow-the-real-model pattern (an alias whose first target is its own
// name) Just Works.
//
// The resolver is endpoint-aware on the pool-narrowing axis: the caller
// hands in an `endpointAccepts` predicate that decides whether a candidate
// target's resolved binding actually serves the inbound endpoint, and the
// pool only keeps targets that satisfy it. The pool walk itself uses the
// kind-aware `enumerateRealModelCandidates` — a target whose only catalog
// matches are wrong-kind is dropped at the walk, not at the predicate;
// `endpointAccepts` narrows further within the candidate's kind.

import type { ModelAliasesRepo, ModelAliasRecord } from '../../repo/types.ts';
import { enumerateRealModelCandidates } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { AliasRules, ModelEndpoints, ModelKind } from '@floway-dev/protocols/common';
import type { Fetcher, ModelProviderInstance } from '@floway-dev/provider';

export interface AliasResolution {
  readonly targetModelId: string;
  readonly rules: AliasRules;
  // Original alias name, preserved for dump attribution.
  readonly aliasName: string;
}

// Why the alias's target pool is empty. The resolver keeps targets whose
// candidate walk yielded at least one kind-matching match AND whose
// endpoint map satisfies the caller's `endpointAccepts` predicate; a
// target lost to either check counts toward its respective bucket here.
type CandidateRoutability =
  | { readonly routable: true }
  | { readonly routable: false; readonly reason: 'no-binding' | 'endpoint-mismatch' };

// Canonical wording for the alias-no-target-available 404. The "every
// target was endpoint-mismatched" branch is its own message so an
// embeddings client hitting a chat-only alias (or vice versa) sees a hint
// pointing at the kind/endpoint instead of the generic "no enabled
// upstream binding" wording.
const aliasNoTargetMessage = (params: {
  readonly aliasName: string;
  readonly targetCount: number;
  readonly allEndpointMismatch: boolean;
}): string => {
  const stem = `alias '${params.aliasName}' has ${params.targetCount} target(s)`;
  if (params.allEndpointMismatch) {
    return `${stem}; none currently serves the inbound endpoint`;
  }
  return `${stem}; none currently map to an enabled upstream binding`;
};

// Thrown when the alias name was found but no target currently resolves to
// an enabled upstream binding that serves the inbound endpoint. Caught at
// each protocol's serve seam and surfaced as a 404 in the protocol-specific
// error envelope.
export class AliasNoTargetAvailableError extends Error {
  readonly aliasName: string;

  constructor(params: { aliasName: string; targetCount: number; allEndpointMismatch: boolean }) {
    super(aliasNoTargetMessage(params));
    this.name = 'AliasNoTargetAvailableError';
    this.aliasName = params.aliasName;
  }
}

interface ResolveAliasArgs {
  readonly modelName: string;
  readonly scheduler: BackgroundScheduler;
  // The same per-request fetcher and provider list the surrounding model
  // resolver already built. Sharing them keeps the upstream-list + proxy-
  // factory cost paid once per request rather than twice.
  readonly providers: readonly ModelProviderInstance[];
  readonly fetcherForUpstream: (upstreamId: string) => Fetcher;
  // Inbound kind threaded into the per-target candidate walk so wrong-kind
  // catalog entries cannot enter the pool.
  readonly kind: ModelKind;
  // Predicate the caller supplies to narrow the pool to targets whose
  // resolved binding serves the inbound endpoint. Chat callers wrap
  // `pickTarget`; passthrough callers check the specific endpoint key.
  // A target enters the pool iff at least one of its candidates returns
  // true here.
  readonly endpointAccepts: (endpoints: ModelEndpoints) => boolean;
  // Injected so tests can hand in a stub; the per-request ctx already owns
  // a concrete one via `getRepo().modelAliases`.
  readonly repo: ModelAliasesRepo;
}

// Reports whether the target id resolves to at least one enabled upstream
// binding whose endpoint map satisfies the inbound endpoint predicate, and
// distinguishes the two empty-pool causes so `AliasNoTargetAvailableError`
// can show the right hint.
const candidateRoutability = async (
  targetModelId: string,
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  kind: ModelKind,
  endpointAccepts: (endpoints: ModelEndpoints) => boolean,
): Promise<CandidateRoutability> => {
  if (providers.length === 0) return { routable: false, reason: 'no-binding' };
  const { candidates } = await enumerateRealModelCandidates(targetModelId, kind, providers, fetcherForUpstream, scheduler);
  if (candidates.length === 0) return { routable: false, reason: 'no-binding' };
  if (candidates.some(c => endpointAccepts(c.model.endpoints))) return { routable: true };
  return { routable: false, reason: 'endpoint-mismatch' };
};

// Pre-pick the available pool ONCE. Order is preserved so
// selection=first-available picks deterministically; selection=random picks
// uniformly within whatever subset survived availability filtering.
// `rejections` collects the reason every dropped target was dropped, so the
// caller can pin the failure message when the pool is empty.
const buildAvailablePool = async (
  record: ModelAliasRecord,
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  kind: ModelKind,
  endpointAccepts: (endpoints: ModelEndpoints) => boolean,
): Promise<{ readonly pool: ModelAliasRecord['targets']; readonly rejections: readonly ('no-binding' | 'endpoint-mismatch')[] }> => {
  const outcomes = await Promise.all(record.targets.map(target =>
    candidateRoutability(target.target_model_id, providers, fetcherForUpstream, scheduler, kind, endpointAccepts)));
  const pool = record.targets.filter((_, index) => outcomes[index].routable);
  const rejections = outcomes.flatMap(o => o.routable ? [] : [o.reason]);
  return { pool, rejections };
};

export const resolveAlias = async (args: ResolveAliasArgs): Promise<AliasResolution | null> => {
  const { modelName, providers, fetcherForUpstream, scheduler, kind, endpointAccepts, repo } = args;
  const record = await repo.getByName(modelName);
  if (!record) return null;

  const { pool, rejections } = await buildAvailablePool(record, providers, fetcherForUpstream, scheduler, kind, endpointAccepts);
  if (pool.length === 0) {
    const allEndpointMismatch = rejections.length > 0 && rejections.every(r => r === 'endpoint-mismatch');
    throw new AliasNoTargetAvailableError({
      aliasName: record.name,
      targetCount: record.targets.length,
      allEndpointMismatch,
    });
  }

  const picked = record.selection === 'first-available'
    ? pool[0]
    : pool[Math.floor(Math.random() * pool.length)];

  return { targetModelId: picked.target_model_id, rules: picked.rules, aliasName: record.name };
};
