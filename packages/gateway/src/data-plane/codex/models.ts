// Codex-internal `/models` shape assembled for the shared catalog handler.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Pipeline: codex publishes a versioned catalog per release (see catalog.ts);
// for each chat-kind model the registry lists as addressable, we call
// `synthesizeCatalogEntry(model, base?)` with the segment-matched client
// catalog entry as `base` (or `undefined` when no catalog entry matches). The
// synthesizer builds the codex-shaped entry from that base, the registry-owned
// overlays it announces, and capabilities proven by the exact client catalog
// (see synthesize.ts for the exact field precedence rules).

import { resolveCodexCatalog, type CatalogModel, type CodexCatalog, type CodexCatalogCapabilities, type CodexServiceTier } from './catalog.ts';
import { synthesizeCatalogEntry } from './synthesize.ts';
import { getRepo } from '../../repo/index.ts';
import type { User } from '../../repo/types.ts';
import { loadModelListingCatalog } from '../models/load.ts';
import type { AddressableIdEntry } from '../shared/listing/addressable.ts';
import { mergeAliasesIntoModels } from '../shared/listing/alias.ts';
import { chatgptCodexModelMetadata } from '@floway-dev/upstream-chatgpt';

// Pure transformation: client catalog + addressable entries →
// codex-shaped catalog (drops unlisted alternates and non-chat kinds).
// Extracted so tests can drive the mapping logic without standing up the
// addressable-enumeration pipeline.
export const assembleCodexCatalog = (
  catalog: CodexCatalog,
  addressable: readonly AddressableIdEntry[],
  capabilities: CodexCatalogCapabilities = {},
): CodexCatalog => {
  const catalogBySlug = new Map<string, CatalogModel>();
  const catalogTierById = new Map<string, CodexServiceTier>();
  for (const model of catalog.models) {
    catalogBySlug.set(model.slug.toLowerCase(), model);
    if (model.service_tiers !== undefined) {
      for (const tier of model.service_tiers) {
        if (!catalogTierById.has(tier.id)) catalogTierById.set(tier.id, tier);
      }
    }
  }

  // Match against the client catalog by walking segments from the trailing leaf back
  // toward the prefix, so a publicId like `openrouter/gpt-5.5/gpt-5.4`
  // binds against `gpt-5.4` rather than the earlier `gpt-5.5` segment that
  // happens to collide with a catalog slug. Split on both `/` (model-prefix
  // segments) and `:` (OpenRouter-style `:variant` suffixes) — a variant
  // tag on the leaf falls through the walk without accidentally binding.
  const matchCatalog = (publicId: string): CatalogModel | undefined => {
    const segments = publicId.toLowerCase().split(/[/:]/);
    for (let i = segments.length - 1; i >= 0; i--) {
      const hit = catalogBySlug.get(segments[i]);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const models: CatalogModel[] = [];
  for (const entry of addressable) {
    // Prefix-addressable alternates that the listing surface did not
    // publish stay off the codex picker too — they are routable at
    // request time but never surface as their own picker row.
    if (entry.unlisted !== undefined) continue;
    if (entry.model.kind !== 'chat') continue;
    if (entry.model.aliasedFrom !== undefined) {
      const model = synthesizeCatalogEntry(entry.model, matchCatalog(entry.model.id), capabilities, catalogTierById);
      if ((model.input_modalities?.length ?? 0) > 0) models.push(model);
      continue;
    }
    const chatContributions: typeof entry.contributions[number][] = [];
    let hasChatGPT = false;
    for (const contribution of entry.contributions) {
      if (contribution.model.kind !== 'chat') continue;
      chatContributions.push(contribution);
      if (contribution.upstream.kind === 'chatgpt') hasChatGPT = true;
    }
    const chatUpstreamModels = chatContributions.map(contribution => contribution.model);
    let metadata: ReturnType<typeof chatgptCodexModelMetadata> | undefined;
    let serviceTiers: CodexServiceTier[] | undefined;
    if (hasChatGPT) {
      const candidates = chatContributions.map(({ upstream, model: upstreamModel }) => ({
        upstreamModel,
        metadata: upstream.kind === 'chatgpt' ? chatgptCodexModelMetadata(upstreamModel) : undefined,
      }));
      // A ChatGPT rate is not an entitlement. Only advertise tiers usable on every fallback.
      const chatgpt = candidates.find(candidate => candidate.metadata !== undefined)?.metadata;
      metadata = candidates[0]!.metadata;
      serviceTiers = chatgpt === undefined ? undefined : (chatgpt.service_tiers ?? []).filter(tier => candidates.every(({ upstreamModel, metadata: candidateMeta }) => {
        if (candidateMeta !== undefined) return candidateMeta.service_tiers?.some(other => other.id === tier.id);
        return upstreamModel.endpoints.openaiResponses !== undefined && upstreamModel.pricing?.entries.some(rate => rate.selector?.serviceTier === tier.id);
      }));
    }
    const model = synthesizeCatalogEntry(entry.model, matchCatalog(entry.model.id), capabilities, catalogTierById, {
      metadata,
      serviceTiers,
      chatUpstreamModels,
    });
    if (model.input_modalities?.length === 0) continue;
    models.push(model);
  }
  return { models };
};

export const loadCodexCatalog = async (
  subject: User,
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
): Promise<CodexCatalog> => {
  const [resolution, listing] = await Promise.all([
    resolveCodexCatalog(userAgent),
    loadModelListingCatalog(subject, upstreamIds, getRepo().modelAliases),
  ]);
  const merged = mergeAliasesIntoModels({
    realModels: listing.realModels,
    gatewayAddressableModelIds: listing.gatewayAddressable,
    callerAddressableModelIds: listing.callerAddressable,
    aliases: listing.aliases,
    narrowTargets: true,
  });
  const listedRealById = new Map(listing.callerAddressable
    .filter(entry => entry.unlisted === undefined)
    .map(entry => [entry.model.id, entry] as const));
  const addressable = merged.map((model): AddressableIdEntry => {
    if (model.aliasedFrom !== undefined) {
      return { id: model.id, model, unlisted: undefined, upstreams: [], contributions: [] };
    }
    const entry = listedRealById.get(model.id);
    if (entry === undefined) throw new Error(`Codex catalog model ${model.id} has no listed addressable entry`);
    return entry;
  });
  return assembleCodexCatalog(resolution.catalog, addressable, resolution.capabilities);
};
