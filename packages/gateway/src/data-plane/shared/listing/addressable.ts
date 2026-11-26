// One enumeration of every inbound model id the gateway accepts — the union of
// the listed catalog surface and the addressable-but-not-listed surface
// contributed by `modelPrefix.addressable` alternates. Listing-side
// availability checks (alias helper, Codex catalog, control-plane DTO) read
// directly from the `upstream_models` table plus lightweight upstream metadata
// without loading `config_json` / `state_json` or instantiating `Provider`s.

import { loadSubjectAccessResolver } from '../../../access-control/check.ts';
import type { AccessResolver, ModelUsePlan } from '../../../access-control/resolution.ts';
import type { AccessEvaluation } from '../../../access-control/types.ts';
import { getRepo } from '../../../repo/index.ts';
import type {
  CatalogUpstreamRow,
  ModelAliasRecord,
  ResolvedUpstreamModelMatch,
  UpstreamCatalogFilter,
  User,
} from '../../../repo/types.ts';
import {
  createCatalogAccumulator,
  distinctUpstreamsFromContributions,
  mergeIntoCatalog,
  sortByModelId,
  type CatalogAccumulator,
  type CatalogUpstreamMeta,
  type ModelContribution,
} from '../../providers/catalog.ts';
import type { AddressableForm, InternalModel, ProviderModel } from '@floway-dev/provider';

export interface AddressableIdEntry {
  // The inbound model id the data plane will accept verbatim.
  readonly id: string;
  // Absent on default-listed entries; `true` on entries only reachable through
  // `modelPrefix.addressable` alternates.
  readonly unlisted: true | undefined;
  // Real catalog row this id routes to, with union-merged endpoints across all
  // contributing upstreams.
  readonly model: InternalModel;
  // Every upstream that surfaces this addressable id, in enumeration order.
  readonly upstreams: readonly CatalogUpstreamMeta[];
  // Per-upstream raw ProviderModel contributions (preserving multi-kind rows
  // on the same upstream) for downstream consumers such as Codex synthesis.
  readonly contributions: readonly ModelContribution[];
}

// Project the listed (real-catalog) `InternalModel`s out of an addressable
// surface — every listing caller wants this same slice to feed
// `mergeAliasesIntoModels`'s `realModels` arg.
export const listedRealModels = (entries: readonly AddressableIdEntry[]): readonly InternalModel[] =>
  entries.filter(entry => entry.unlisted === undefined).map(entry => entry.model);

const toUpstreamMeta = (row: Pick<CatalogUpstreamRow, 'id' | 'kind' | 'name' | 'hue'>): CatalogUpstreamMeta => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  hue: row.hue,
});

const surfaceProviderModel = (
  model: ProviderModel,
  upstreamName: string,
  form: AddressableForm,
  publicId: string,
): ProviderModel => form === 'prefixed'
  ? { ...model, id: publicId, display_name: `${upstreamName}: ${model.display_name ?? model.id}` }
  : model;

const finalizeCatalogEntries = (
  acc: CatalogAccumulator,
  listedIds: ReadonlySet<string>,
): AddressableIdEntry[] => {
  const entries: AddressableIdEntry[] = [];
  for (const [id, model] of acc.byId) {
    const contributions = acc.contributionsById.get(id)!;
    entries.push({
      id,
      unlisted: listedIds.has(id) ? undefined : true,
      model,
      upstreams: distinctUpstreamsFromContributions(contributions),
      contributions,
    });
  }
  return sortByModelId(entries, entry => entry.id);
};

interface ModelUseAuthContext {
  readonly resolver: AccessResolver;
  readonly plan: ModelUsePlan;
  readonly evaluation: AccessEvaluation;
}

const catalogFilterForModelUse = (
  upstreamFilter: readonly string[] | null,
  plan: ModelUsePlan,
): UpstreamCatalogFilter | null => {
  if (!plan.globalAllowed) {
    if (upstreamFilter === null) {
      return { include: [...plan.candidateUpstreamIds] };
    }
    return {
      include: upstreamFilter.filter(id => plan.candidateUpstreamIds.has(id)),
      preserveIncludeOrder: true,
    };
  }
  if (upstreamFilter !== null) {
    return {
      include: upstreamFilter.filter(id => !plan.deniedUpstreamIds.has(id)),
      preserveIncludeOrder: true,
    };
  }
  if (plan.deniedUpstreamIds.size === 0) return null;
  return { exclude: [...plan.deniedUpstreamIds] };
};

const assembleAddressableEntries = (
  upstreams: readonly CatalogUpstreamRow[],
  modelsByUpstream: ReadonlyMap<string, readonly ProviderModel[]>,
  auth: ModelUseAuthContext | null,
): AddressableIdEntry[] => {
  const acc = createCatalogAccumulator();
  const listedIds = new Set<string>();
  const requirement = { permission: 'Model.Use' as const };

  for (const upstream of upstreams) {
    const hasModelRules = auth?.plan.upstreamsWithModelRules.has(upstream.id) ?? false;
    const meta = toUpstreamMeta(upstream);
    const cfg = upstream.modelPrefix;
    const forms = cfg === null ? (['unprefixed'] as const) : cfg.addressable;
    const allowedPublicIds = hasModelRules ? new Map<string, boolean>() : null;

    for (const providerModel of modelsByUpstream.get(upstream.id) ?? []) {
      for (const form of forms) {
        const publicId = form === 'prefixed' ? `${cfg!.prefix}${providerModel.id}` : providerModel.id;
        if (allowedPublicIds !== null) {
          let allowed = allowedPublicIds.get(publicId);
          if (allowed === undefined) {
            allowed = auth!.resolver.satisfies(
              { kind: 'upstreamModel', upstreamId: upstream.id, model: { kind: 'exact', value: publicId } },
              requirement,
              auth!.evaluation,
            );
            allowedPublicIds.set(publicId, allowed);
          }
          if (!allowed) continue;
        }
        if (cfg === null || cfg.listed.includes(form)) listedIds.add(publicId);
        mergeIntoCatalog(acc, meta, surfaceProviderModel(providerModel, upstream.name, form, publicId), publicId);
      }
    }
  }

  return finalizeCatalogEntries(acc, listedIds);
};

const assembleResolvedMatches = (
  matches: readonly ResolvedUpstreamModelMatch[],
): AddressableIdEntry[] => {
  if (matches.length === 0) return [];
  const acc = createCatalogAccumulator();
  const listedIds = new Set<string>();
  for (const match of matches) {
    const publicId = match.matchedInputId;
    const cfg = match.upstream.modelPrefix;
    if (cfg === null || cfg.listed.includes(match.matchedForm)) {
      listedIds.add(publicId);
    }
    mergeIntoCatalog(
      acc,
      toUpstreamMeta(match.upstream),
      surfaceProviderModel(match.model, match.upstream.name, match.matchedForm, publicId),
      publicId,
    );
  }
  return finalizeCatalogEntries(acc, listedIds);
};

const collectVisibleAliasTargetIds = (aliases: readonly ModelAliasRecord[]): string[] => {
  const ids = new Set<string>();
  for (const alias of aliases) {
    if (!alias.visibleInModelsList) continue;
    for (const target of alias.targets) {
      if (target.target_model_id) ids.add(target.target_model_id);
    }
  }
  return [...ids];
};

// Load both caller-scoped and gateway-wide addressable surfaces needed for
// listing and alias synthesis.
//
// - Unrestricted admin: one full `listCatalog(null)` serves both surfaces.
// - Scoped or filtered caller: pre-prune candidate upstreams from the subject's
//   `Model.Use` rules before querying `upstream_models`, filter in-place during
//   assembly, and fetch gateway-wide metadata solely for visible alias targets
//   via indexed `resolve()`.
export const loadAddressableSurfaces = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
  aliasesPromise: Promise<ModelAliasRecord[]> = Promise.resolve([]),
): Promise<{
  readonly callerAddressable: readonly AddressableIdEntry[];
  readonly gatewayAddressable: readonly AddressableIdEntry[];
  readonly aliases: ModelAliasRecord[];
}> => {
  const repo = getRepo();
  if (subject.isAdmin && upstreamFilter === null) {
    const [{ upstreams, modelsByUpstream }, aliases] = await Promise.all([
      repo.upstreamModels.listCatalog(null),
      aliasesPromise,
    ]);
    const entries = assembleAddressableEntries(upstreams, modelsByUpstream, null);
    return { callerAddressable: entries, gatewayAddressable: entries, aliases };
  }

  if (upstreamFilter !== null && upstreamFilter.length === 0) {
    const aliases = await aliasesPromise;
    return { callerAddressable: [], gatewayAddressable: [], aliases };
  }

  if (subject.isAdmin) {
    const [{ upstreams, modelsByUpstream }, { aliases, resolvedAliasTargets }] = await Promise.all([
      repo.upstreamModels.listCatalog({
        include: upstreamFilter!,
        preserveIncludeOrder: true,
      }),
      aliasesPromise.then(async aliases => {
        const aliasTargetIds = collectVisibleAliasTargetIds(aliases);
        const resolvedAliasTargets = aliasTargetIds.length > 0
          ? await repo.upstreamModels.resolve({ modelIds: aliasTargetIds, upstreamIds: null })
          : [];
        return { aliases, resolvedAliasTargets };
      }),
    ]);
    return {
      callerAddressable: assembleAddressableEntries(upstreams, modelsByUpstream, null),
      gatewayAddressable: assembleResolvedMatches(resolvedAliasTargets),
      aliases,
    };
  }

  const [resolver, aliases] = await Promise.all([
    loadSubjectAccessResolver(subject),
    aliasesPromise,
  ]);
  const evaluation: AccessEvaluation = { targetGroups: new Set<number>(), subjectUserId: subject.id };
  const plan = resolver.planModelUse(evaluation);
  const filter = catalogFilterForModelUse(upstreamFilter, plan);
  if (filter?.include?.length === 0) {
    return { callerAddressable: [], gatewayAddressable: [], aliases };
  }

  const aliasTargetIds = collectVisibleAliasTargetIds(aliases);
  const [{ upstreams, modelsByUpstream }, resolvedAliasTargets] = await Promise.all([
    repo.upstreamModels.listCatalog(filter),
    aliasTargetIds.length > 0
      ? repo.upstreamModels.resolve({ modelIds: aliasTargetIds, upstreamIds: null })
      : Promise.resolve([]),
  ]);

  return {
    callerAddressable: assembleAddressableEntries(upstreams, modelsByUpstream, { resolver, plan, evaluation }),
    gatewayAddressable: assembleResolvedMatches(resolvedAliasTargets),
    aliases,
  };
};
