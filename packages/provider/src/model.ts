import type { FlagId, FlagOverrides } from './flags.ts';
import type { UpstreamChatModelConfig } from './model-config.ts';
import type { ModelPrefixConfig } from './model-prefix.ts';
import type { AliasSelection, AliasTarget, ModelKind, ModelEndpoints, ModelPricing, PublicModelLimits, RerankTarget } from '@floway-dev/protocols/common';

export const ALL_PROVIDER_KINDS = ['copilot', 'custom', 'azure', 'codex', 'claude-code', 'ollama'] as const;
export type UpstreamProviderKind = typeof ALL_PROVIDER_KINDS[number];

// Runtime narrow of an unvalidated string to `UpstreamProviderKind`. The
// DB CHECK constraint mirrors `ALL_PROVIDER_KINDS`, but the type system
// does not know that — narrow at every wire/DB boundary.
export const assertUpstreamProviderKind = (provider: string): UpstreamProviderKind => {
  if ((ALL_PROVIDER_KINDS as readonly string[]).includes(provider)) return provider as UpstreamProviderKind;
  throw new TypeError(`Invalid upstream provider kind: ${provider}`);
};

// The operator-chosen badge hue, as an OKLCH hue angle in degrees. It is the
// only dimension of the badge an operator picks: the dashboard fixes lightness
// and chroma, washes the hue to 10% for the fill and 35% for the outline, and
// solves the label against that fill for a contrast floor, so nothing else in
// the color would survive being chosen.
export const UPSTREAM_HUE_DEGREES = 360;

// Parse a wire / persisted upstream hue. Integers in `[0, 360)` pass through;
// everything else throws, including a float, a wrappable angle, and a missing
// value. Callers that want row-attributed error messages wrap this in a
// try/catch and re-throw, mirroring the normalize*/parse* split used by every
// other row hydrator in `packages/gateway/src/repo/sql.ts`.
export const normalizeUpstreamHue = (value: unknown): number => {
  if (typeof value !== 'number') throw new Error(`upstreamHue must be a number, got ${typeof value}`);
  if (!Number.isInteger(value) || value < 0 || value >= UPSTREAM_HUE_DEGREES) {
    throw new Error(`upstreamHue must be an integer in [0, ${UPSTREAM_HUE_DEGREES}), got ${value}`);
  }
  return value;
};

// One entry in `UpstreamRecord.proxyFallbackList`. `id` is the proxy id from
// the proxies catalog or a built-in transport (`direct_fetch`,
// `direct_connect`). `colos` is an
// optional whitelist of location tags (Cloudflare colos / the Node
// `RUNTIME_LOCATION` env var); when set, the dial layer only attempts this
// entry from a request that landed in one of the listed locations. Missing
// means "all locations". An empty array is never persisted — the wire schema
// rejects it and the repo normalizer strips it.
export interface ProxyFallbackEntry {
  id: string;
  colos?: string[];
}

// A cached projection of one upstream's catalog, stored on the upstream row.
// `revision` is the catalog contract version the entry was written under, so a
// deploy that changes the projection invalidates older entries; `lastError`
// annotates a previously-successful entry whose refresh failed.
export interface UpstreamModelsCache {
  revision: number;
  fetchedAt: number;
  models: ProviderModel[];
  lastError: { message: string; at: number } | null;
}

// One upstream's persisted record. `config` is a per-provider opaque payload;
// `state` is gateway-managed runtime data.
export interface UpstreamRecord {
  id: string;
  kind: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  config: unknown;
  // Gateway-written state that can change without an operator editing config;
  // null when a provider has no runtime state.
  state: unknown;
  // The upstream's cached catalog, read on the same round trip as the row
  // rather than through a second query. Null until the first successful fetch.
  // Written only by the catalog refresh path — an operator save leaves it
  // alone.
  modelsCache: UpstreamModelsCache | null;
  flagOverrides: FlagOverrides;
  // Model ids the operator switched off for this upstream, matched against the
  // provider-emitted id before any model prefix is applied — so one entry hides
  // both the bare and the prefixed surface. Orthogonal to every per-model
  // metadata field and uniform across provider kinds: a disabled id is hidden
  // from the catalog and unroutable, but its row metadata stays editable.
  // Entries may reference ids no longer present in the live model list.
  disabledPublicModelIds: string[];
  proxyFallbackList: ProxyFallbackEntry[];
  // Per-upstream model name prefix policy. `null` keeps the bare-id behavior
  // — the upstream's models are addressed and listed by bare upstream id only.
  // When set, the registry honors `addressable` and `listed` to expose /
  // accept either form (or both).
  modelPrefix: ModelPrefixConfig | null;
  // The operator-chosen badge hue, an OKLCH hue angle in degrees. Every
  // upstream carries its own; the dashboard derives the whole badge from it.
  // Wire validation lives in the control-plane Zod schema.
  hue: number;
}

// Public identity + capability surface shared by `InternalModel` (the merged,
// gateway-facing view) and `ProviderModel` (a single upstream's emission).
// The two shapes carry the same metadata verbatim; the merge step OR-unions
// `endpoints` and recomputes `kind`. Kept internal so callers can only touch
// the wrapper types — this base has no meaning on its own.
//
// `endpoints` is the precise per-protocol availability map; `kind` is always
// `kindForEndpoints(endpoints)`, a lossy first-match projection of it onto the
// endpoint-family discriminator. Only `kind === 'chat'` says anything about the
// whole map — it means no non-chat family key is present, since each of those
// short-circuits ahead of it. Every other value says only that its own key is
// present; the map may carry any other endpoint alongside, and no producer
// checks otherwise. `data-plane/providers/catalog.ts`'s union merge
// manufactures exactly such mixed sets on purpose when several upstreams
// contribute one public id, then recomputes `kind` from the union. Resolution
// uses this projection as the source-route discriminator before the selected
// serve path reads its endpoint configuration; `endpoints` remains the
// catalog's precise capability metadata even for mixed sets.
interface ModelMetadata {
  id: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  limits: PublicModelLimits;
  kind: ModelKind;
  pricing?: ModelPricing;
  chat?: UpstreamChatModelConfig;
  endpoints: ModelEndpoints;
}

// The neutral internal model shape consumed across the gateway. Metadata fields
// surface the public identity of the model; `endpoints` and `kind` reflect the
// OR-union across every contributing upstream so the gateway as a whole reaches
// the union.
//
// A row is exactly one of two mutually-exclusive kinds:
//   • Real row — carries `providerModels`, keyed on upstream id. Per-request
//     dispatch reads the chosen upstream's `ProviderModel` off this map via
//     `providerModelOf(candidate)`. A per-candidate row (from
//     `enumerateRealModelCandidates`) narrows the map to the single dispatched
//     upstream; the merged catalog row from `getModelsFromProviders`
//     aggregates every contributing upstream.
//   • Alias row — carries `aliasedFrom`, the operator-defined alias record.
//     Alias rows appear in listings but never dispatch directly; the resolver
//     walks the alias's targets and yields real-row candidates instead.
//
// The two carriers are exclusive: a row is either real or alias, never both.
// `providerModelOf` throws with distinct messages for each miss so a mis-used
// alias row surfaces the correct diagnostic.
export type InternalModel = ModelMetadata & (
  | { readonly providerModels: Record<string, ProviderModel>; readonly aliasedFrom?: never }
  | { readonly providerModels?: never; readonly aliasedFrom: InternalAliasedFrom }
);

// Alias-side payload carried on alias-synthesized `InternalModel` rows.
// Mirrors the operator's `ModelAliasRecord` at the point the row was
// synthesized: `selection` is the walk mode the resolver honors at request
// time, and `targets` is the configured target list — projected as-is on
// admin surfaces and filtered to the caller-reachable subset on data-plane
// / non-admin surfaces. `AliasTarget.rules` on each entry rides through to
// the picked candidate's request as the rule overlay. The alias's `name`
// and `kind` live on the enclosing `InternalModel` (`id`, `kind`), so this
// sidecar carries only the alias-specific fields.
export interface InternalAliasedFrom {
  readonly selection: AliasSelection;
  readonly targets: readonly AliasTarget[];
}

// Per-upstream projection returned by every provider's `getProvidedModels` and
// the shape every provider's `callXxx(model, ...)` takes at dispatch time.
// Carries the same metadata as `InternalModel` plus `providerData` (opaque
// provider-private invocation data, not a universal upstream-id field —
// Copilot uses it for raw variants, Claude Code for a dated wire id, and other
// providers may omit it or carry a different private shape), `enabledFlags`
// (the effective flag set for the model on the emitting upstream, already
// resolved through every layer), and `flagOverrides` (optional dashboard-only
// view of the per-model layer that fed into `enabledFlags`). Providers only
// ever see their own emission — the surrounding `InternalModel` map is
// assembled by the registry.
export interface ProviderModel extends ModelMetadata {
  providerData?: unknown;
  rerankTarget?: RerankTarget;
  enabledFlags: ReadonlySet<FlagId>;
  // Provider's per-model flag call as a sparse override — each entry
  // states the provider's opinion for that flag on this specific
  // model. Absent when the provider has no per-model call on this
  // model; when present, the map is non-empty (producers elide empty
  // overlays before emission). Populated only for providers with a
  // per-model rule (e.g., Copilot's Claude < 4.8 system-rewrite clause); other
  // providers leave it undefined.
  //
  // The data plane consumes the already-resolved `enabledFlags` and
  // never re-layers this. The field exists so the dashboard's
  // auto-row flag view can render a per-flag pill showing which flags
  // the provider itself calls on this specific model —
  // reshapeModelForDashboard projects it onto the wire as the auto-row
  // counterpart to the operator-authored
  // `UpstreamModelConfig.flagOverrides` on manual rows. Both occupy the
  // same layer-3 slot; which one a row carries follows from where the row
  // came from, not from anything on the field itself.
  flagOverrides?: FlagOverrides;
}
