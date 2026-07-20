// codex-internal `/models` shape.
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

import type { Context } from 'hono';

import { resolveCodexCatalog, type CatalogModel, type CodexCatalog, type CodexCatalogCapabilities } from './catalog.ts';
import { synthesizeCatalogEntry } from './synthesize.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { enumerateAddressableModelIds, type AddressableIdEntry } from '../shared/listing/addressable.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

// Pure transformation: client catalog + addressable entries →
// codex-shaped catalog (drops unlisted alternates and non-chat kinds).
// Extracted so tests can drive the mapping logic without standing up the
// addressable-enumeration pipeline.
export const assembleCatalog = (
  catalog: CodexCatalog,
  addressable: readonly AddressableIdEntry[],
  capabilities: CodexCatalogCapabilities = {},
): CodexCatalog => {
  const catalogBySlug = new Map<string, CatalogModel>();
  for (const model of catalog.models) catalogBySlug.set(model.slug.toLowerCase(), model);

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
    models.push(synthesizeCatalogEntry(entry.model, matchCatalog(entry.model.id), capabilities));
  }
  return { models };
};

const computeCatalog = async (
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<CodexCatalog> => {
  const [resolution, addressable] = await Promise.all([
    resolveCodexCatalog(userAgent),
    enumerateAddressableModelIds(upstreamIds, fetcherForUpstream, scheduler),
  ]);
  return assembleCatalog(resolution.catalog, addressable, resolution.capabilities);
};

export const codexModels = async (c: Context): Promise<Response> => {
  const userAgent = c.req.header('user-agent');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(c.req.raw));
  const scheduler = backgroundSchedulerFromContext(c);
  return Response.json(await computeCatalog(userAgent, upstreamIds, fetcherForUpstream, scheduler));
};
