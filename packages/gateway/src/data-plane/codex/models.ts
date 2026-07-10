// codex-internal `/models` shape.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Pipeline: codex publishes a bundled catalog per release (see catalog.ts);
// for each chat-kind model the registry lists as addressable, we call
// `synthesizeCatalogEntry(model, base?)` with the segment-matched bundled
// entry as `base` (or `undefined` when no bundled entry matches). The
// synthesizer builds the codex-shaped entry from that base plus the
// registry-owned overlays it announces (see synthesize.ts for the exact
// field precedence rules).
//
// Ordering is native-first and fully deterministic — it depends only on the
// set of addressable ids, never on their enumeration order. Each surfaced id
// is classified against the bundled catalog:
//
//   • exact   — the whole public id equals a bundled GPT (`gpt-*`) slug.
//               Keeps the bundled priority verbatim.
//   • variant — a non-exact leaf-first segment match to a bundled GPT slug
//               (a prefixed / suffixed republish like `openrouter/gpt-5.5`).
//   • none    — everything else, including ids whose only bundled match is a
//               non-GPT slug (`codex-auto-review`) and ids with no match at
//               all.
//
// Variants sort by (matched bundled priority, public id) into a contiguous
// band strictly above the highest exact-native priority; unrelated ids sort
// by public id into a band above the variants. The final array is emitted in
// (priority, slug) order so the array shape — not just the priority field —
// is deterministic. Family is never used to exclude an id: a non-GPT model is
// ranked as unrelated, not dropped.

import type { Context } from 'hono';

import { resolveCodexCatalog, type CatalogModel, type CodexCatalog } from './catalog.ts';
import { synthesizeCatalogEntry } from './synthesize.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { enumerateAddressableModelIds, type AddressableIdEntry } from '../shared/listing/addressable.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

// The bundled GPT family that anchors native-first ordering. Every other
// bundled slug (e.g. `codex-auto-review`) ranks as unrelated even on an exact
// whole-id match.
const isBundledGptSlug = (slug: string): boolean => slug.startsWith('gpt-');

type MatchClass = 'exact' | 'variant' | 'none';

// Lexicographic public-id comparator: total, deterministic, case-sensitive.
const byPublicId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Pure transformation: bundled catalog + addressable entries →
// codex-shaped catalog (drops unlisted alternates and non-chat kinds).
// Extracted so tests can drive the mapping logic without standing up the
// addressable-enumeration pipeline.
export const assembleCatalog = (
  bundled: CodexCatalog,
  addressable: readonly AddressableIdEntry[],
): CodexCatalog => {
  const bundledBySlug = new Map<string, CatalogModel>();
  for (const m of bundled.models) bundledBySlug.set(m.slug.toLowerCase(), m);

  // Match against bundled by walking segments from the trailing leaf back
  // toward the prefix, so a publicId like `openrouter/gpt-5.5/gpt-5.4`
  // binds against `gpt-5.4` rather than the earlier `gpt-5.5` segment that
  // happens to collide with a bundled slug. Split on both `/` (model-prefix
  // segments) and `:` (OpenRouter-style `:variant` suffixes) — a variant
  // tag on the leaf falls through the walk without accidentally binding.
  // The matched slug drives classification: an exact whole-id GPT hit is
  // native; a segment-only GPT hit is a variant; any non-GPT hit (or no hit)
  // is unrelated. `basePriority` carries the matched bundled priority so
  // variants can be sorted native-first.
  const classify = (publicId: string): { base: CatalogModel | undefined; match: MatchClass; basePriority: number } => {
    const lower = publicId.toLowerCase();
    const segments = lower.split(/[/:]/);
    for (let i = segments.length - 1; i >= 0; i--) {
      const base = bundledBySlug.get(segments[i]);
      if (base === undefined) continue;
      const basePriority = base.priority as number;
      if (!isBundledGptSlug(segments[i])) return { base, match: 'none', basePriority };
      return { base, match: lower === segments[i] ? 'exact' : 'variant', basePriority };
    }
    return { base: undefined, match: 'none', basePriority: 0 };
  };

  interface Ranked {
    readonly entry: CatalogModel;
    readonly match: MatchClass;
    readonly basePriority: number;
    readonly publicId: string;
  }

  const ranked: Ranked[] = [];
  for (const addressed of addressable) {
    // Prefix-addressable alternates that the listing surface did not
    // publish stay off the codex picker too — they are routable at
    // request time but never surface as their own picker row.
    if (addressed.unlisted !== undefined) continue;
    if (addressed.model.kind !== 'chat') continue;
    const { base, match, basePriority } = classify(addressed.model.id);
    ranked.push({ entry: synthesizeCatalogEntry(addressed.model, base), match, basePriority, publicId: addressed.model.id });
  }

  // Exact natives keep the bundled priority the synthesizer already copied
  // onto the entry. Both derived bands start strictly above the highest such
  // priority (0 when no native is present), so the three bands never overlap.
  const maxNativePriority = ranked
    .filter(r => r.match === 'exact')
    .reduce((max, r) => Math.max(max, r.entry.priority as number), 0);

  const variants = ranked.filter(r => r.match === 'variant')
    .sort((a, b) => a.basePriority - b.basePriority || byPublicId(a.publicId, b.publicId));
  variants.forEach((r, i) => { r.entry.priority = maxNativePriority + 1 + i; });

  ranked.filter(r => r.match === 'none')
    .sort((a, b) => byPublicId(a.publicId, b.publicId))
    .forEach((r, i) => { r.entry.priority = maxNativePriority + variants.length + 1 + i; });

  const models = ranked.map(r => r.entry)
    .sort((a, b) => (a.priority as number) - (b.priority as number) || byPublicId(a.slug, b.slug));
  return { models };
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
