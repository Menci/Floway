import { toPublicModel } from '../../data-plane/models/load.ts';
import { type AddressableIdEntry, listedRealModels, loadAddressableSurfaces } from '../../data-plane/shared/listing/addressable.ts';
import { mergeAliasesIntoModels } from '../../data-plane/shared/listing/alias.ts';
import type { CatalogUpstreamMeta } from '../../data-plane/upstreams/catalog.ts';
import { effectiveUpstreamIdsFromContext, userFromContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { modelsQuery } from '../schemas.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { InternalModel, UpstreamKind } from '@floway-dev/upstream';

interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamKind; id: string; name: string; hue: number }[];
}

interface ControlPlaneModelsResponse extends Omit<PublicModelsResponse, 'data'> {
  data: ControlPlaneModel[];
}

const toControlPlaneModel = (
  model: InternalModel,
  upstreams: readonly CatalogUpstreamMeta[],
): ControlPlaneModel => ({
  ...toPublicModel(model),
  upstreams: upstreams.map(upstream => ({
    kind: upstream.kind,
    id: upstream.id,
    name: upstream.name,
    hue: upstream.hue,
  })),
});

const toUnlistedControlPlaneModel = (entry: AddressableIdEntry): ControlPlaneModel => ({
  ...toControlPlaneModel(entry.model, entry.upstreams),
  id: entry.id,
  display_name: entry.model.display_name ?? entry.id,
  unlisted: true,
});

export const controlPlaneModels = async (c: CtxWithQuery<typeof modelsQuery>) => {
  try {
    const { aliases: aliasesValue, include_unlisted: includeUnlistedValue } = c.req.valid('query');
    const includeAliases = aliasesValue !== 'false';
    const includeUnlisted = includeUnlistedValue === 'true';
    const subject = userFromContext(c);
    const isAdmin = subject.isAdmin;
    const upstreamScope = isAdmin ? null : effectiveUpstreamIdsFromContext(c);
    const { callerAddressable, gatewayAddressable, aliases } = await loadAddressableSurfaces(
      subject,
      upstreamScope,
      includeAliases ? getRepo().modelAliases.list() : Promise.resolve([]),
    );
    const upstreamsByListedId = new Map(callerAddressable.map(entry => [entry.id, entry.upstreams] as const));
    const realModels = listedRealModels(callerAddressable);
    const merged = includeAliases
      ? mergeAliasesIntoModels({
          realModels,
          gatewayAddressableModelIds: gatewayAddressable,
          callerAddressableModelIds: callerAddressable,
          aliases,
          narrowTargets: !isAdmin,
        })
      : realModels;
    const listedRows = merged.map(model => {
      const upstreams = model.aliasedFrom !== undefined ? [] : upstreamsByListedId.get(model.id);
      if (upstreams === undefined) throw new Error(`Missing upstream index for listed model ${model.id}`);
      return toControlPlaneModel(model, upstreams);
    });
    const listedIds = new Set(listedRows.map(row => row.id));
    const unlistedRows = includeUnlisted
      ? callerAddressable
          .filter(entry => entry.unlisted === true && !listedIds.has(entry.id))
          .map(toUnlistedControlPlaneModel)
      : [];
    const data = [...listedRows, ...unlistedRows];
    const response: ControlPlaneModelsResponse = {
      object: 'list',
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      data,
    };
    return c.json(response);
  } catch (e: unknown) {
    return c.json({ error: { message: e instanceof Error ? e.message : String(e), type: 'api_error' } }, 502);
  }
};
