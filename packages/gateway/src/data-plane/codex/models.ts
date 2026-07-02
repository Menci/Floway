// codex-internal `/models` shape.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Pipeline: codex publishes a bundled catalog per release (see catalog.ts);
// for each chat-kind model the registry lists as addressable, we either
// reuse its bundled entry (found via segment-based slug matching so
// prefixed public ids like `openrouter/gpt-5.5` still resolve to the
// upstream slug) or synthesize a new one (see synthesize.ts). Bundled
// entries have their slug overridden to the registry public id and their
// context_window / max_context_window rewritten from the registry (see
// context-window.ts) so the codex client sees the same limits the data
// plane will actually enforce.
//
// Aliases never enter this pipeline — `enumerateAddressableModelIds`
// walks real provider-advertised models plus `modelPrefix.addressable`
// alternates only. The alias resolver handles alias requests at dispatch
// time, so alias ids do not appear on the codex `/model` picker.

import type { Context } from 'hono';

import { resolveCodexCatalog, type CatalogModel, type CodexCatalog } from './catalog.ts';
import { applyContextWindowFromRegistry, type ContextWindowResolver } from './context-window.ts';
import { deriveServiceTiers, synthesizeCatalogEntry } from './synthesize.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { enumerateAddressableModelIds, type AddressableIdEntry } from '../shared/listing/addressable.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

// Pure transformation: bundled catalog + listed addressable entries →
// codex-shaped catalog. Extracted so tests can drive the mapping logic
// without standing up the addressable-enumeration pipeline.
export const assembleCatalog = (
  bundled: CodexCatalog,
  addressable: readonly AddressableIdEntry[],
): CodexCatalog => {
  const bundledBySlug = new Map<string, CatalogModel>();
  for (const m of bundled.models) bundledBySlug.set(m.slug.toLowerCase(), m);

  const matchBundled = (publicId: string): CatalogModel | null => {
    for (const seg of publicId.toLowerCase().split(/[/:]/)) {
      const hit = bundledBySlug.get(seg);
      if (hit) return hit;
    }
    return null;
  };

  const models: CatalogModel[] = [];
  for (const entry of addressable) {
    // Prefix-addressable alternates that the listing surface did not
    // publish stay off the codex picker too — they are routable at
    // request time but never surface as their own picker row.
    if (entry.unlisted !== undefined) continue;
    const model = entry.model;
    if (model.kind !== 'chat') continue;
    const hit = matchBundled(model.id);
    if (hit) {
      const cloned: CatalogModel = { ...hit, slug: model.id };
      if (model.display_name !== undefined) cloned.display_name = model.display_name;
      // Registry-derived tiers win over bundled: a tier we can bill must
      // have unit prices in the registry, so any bundled tier we lack
      // pricing for cannot be surfaced to the client.
      cloned.service_tiers = deriveServiceTiers(model);
      models.push(cloned);
    } else {
      models.push(synthesizeCatalogEntry(model));
    }
  }

  const addressableById = new Map(addressable.map(entry => [entry.id, entry] as const));
  const contextWindowOf: ContextWindowResolver = slug =>
    addressableById.get(slug)?.model.limits.max_context_window_tokens ?? null;
  return applyContextWindowFromRegistry({ models }, contextWindowOf);
};

const computeCatalog = async (
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<CodexCatalog> => {
  const [bundled, addressable] = await Promise.all([
    resolveCodexCatalog(userAgent),
    enumerateAddressableModelIds(upstreamIds, fetcherForUpstream, scheduler),
  ]);
  return assembleCatalog(bundled, addressable);
};

export const codexModels = async (c: Context): Promise<Response> => {
  const userAgent = c.req.header('user-agent');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
  const scheduler = backgroundSchedulerFromContext(c);
  return Response.json(await computeCatalog(userAgent, upstreamIds, fetcherForUpstream, scheduler));
};
