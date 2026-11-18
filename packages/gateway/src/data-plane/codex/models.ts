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
import type { ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import type { User } from '../../repo/types.ts';
import { enumerateAddressableModelIds, type AddressableIdEntry } from '../shared/listing/addressable.ts';
import { chatgptCodexModelMetadata } from '@floway-dev/provider-chatgpt';

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
  for (const model of catalog.models) catalogBySlug.set(model.slug.toLowerCase(), model);
  const catalogServiceTiers: CodexServiceTier[] = catalog.models.flatMap(model => model.service_tiers ?? []);

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
    const candidates = entry.upstreams.map(upstream => {
      const providerModel = entry.model.providerModels?.[upstream.upstreamId];
      if (providerModel === undefined) throw new Error(`Codex catalog model ${entry.id} has no provider model for ${upstream.upstreamId}`);
      return { providerModel, metadata: upstream.kind === 'chatgpt' ? chatgptCodexModelMetadata(providerModel) : undefined };
    });
    // A ChatGPT rate is not an entitlement. Only advertise tiers usable on every fallback.
    const chatgpt = candidates.find(candidate => candidate.metadata !== undefined)?.metadata;
    const serviceTiers = chatgpt === undefined ? undefined : (chatgpt.service_tiers ?? []).filter(tier => candidates.every(({ providerModel, metadata }) => {
      if (metadata !== undefined) return metadata.service_tiers?.some(other => other.id === tier.id);
      return providerModel.endpoints.openaiResponses !== undefined && providerModel.pricing?.entries.some(rate => rate.selector?.serviceTier === tier.id);
    }));
    const model = synthesizeCatalogEntry(entry.model, matchCatalog(entry.model.id), capabilities, catalogServiceTiers, { metadata: candidates[0]?.metadata, serviceTiers });
    if (model.input_modalities?.length === 0) continue;
    models.push(model);
  }
  return { models };
};

export const loadCodexCatalog = async (
  subject: User,
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
  scheduleRefresh: ModelsRefreshScheduler,
): Promise<CodexCatalog> => {
  const [resolution, addressable] = await Promise.all([
    resolveCodexCatalog(userAgent),
    enumerateAddressableModelIds(subject, upstreamIds, scheduleRefresh),
  ]);
  return assembleCodexCatalog(resolution.catalog, addressable, resolution.capabilities);
};
