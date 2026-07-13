import type { FlagId, FlagOverrides } from './flags.ts';
import type { UpstreamChatModelConfig } from './model-config.ts';
import type { ModelPrefixConfig } from './model-prefix.ts';
import type { AliasSelection, AliasTarget, ModelKind, ModelEndpoints, ModelPricing } from '@floway-dev/protocols/common';

export const ALL_PROVIDER_KINDS = ['copilot', 'custom', 'azure', 'codex', 'claude-code', 'ollama'] as const;
export type UpstreamProviderKind = typeof ALL_PROVIDER_KINDS[number];

// Runtime narrow of an unvalidated string to `UpstreamProviderKind`. The
// DB CHECK constraint mirrors `ALL_PROVIDER_KINDS`, but the type system
// does not know that — narrow at every wire/DB boundary.
export const assertUpstreamProviderKind = (provider: string): UpstreamProviderKind => {
  if ((ALL_PROVIDER_KINDS as readonly string[]).includes(provider)) return provider as UpstreamProviderKind;
  throw new TypeError(`Invalid upstream provider kind: ${provider}`);
};

// Per-upstream badge color override. `null` inherits the frontend's kind
// default; a preset key resolves to a static Uno accent class; a `#RRGGBB`
// string renders via CSS custom properties + color-mix() so any operator hex
// works without extending the theme.
export const UPSTREAM_COLOR_PRESETS = ['amber', 'emerald', 'cyan', 'violet', 'rose', 'orange'] as const;
export type UpstreamColorPreset = typeof UPSTREAM_COLOR_PRESETS[number];
export type UpstreamColor = UpstreamColorPreset | `#${string}`;

// The frontend resolver (`apps/web/src/components/upstreams/upstream-paint.ts`)
// disambiguates hex from preset by `raw.startsWith('#')`; a preset that
// begins with '#' would silently route to the hex renderer and produce
// invalid CSS. `Extract<>` collects any offending members of the union;
// the assertion fails to compile if that projection is not `never`. (A
// naive `T extends \`#${string}\` ? never : true` distributes across the
// union and collapses to `true`, providing no guard.)
//
// If this compile error fires, DO NOT delete the assertion — either
// rename the offending preset to drop the '#' prefix, or (only if the
// hex-vs-preset disambiguation gets a different mechanism) update the
// resolver first and then this guard together.
type _NoHashPresets = Extract<UpstreamColorPreset, `#${string}`> extends never ? true : never;
const _noHashPresets: _NoHashPresets = true;
void _noHashPresets;

// Canonical hex form accepted at every wire boundary. Uppercase-or-lowercase
// #RRGGBB only; shorthand and 8-digit alpha are rejected so the resolver's
// `startsWith('#')` disambiguation vs preset keys stays sound.
export const UPSTREAM_COLOR_HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

// Parse a wire / persisted upstream color into the domain shape. `null`
// and `undefined` collapse to `null` (inherit). A valid preset key or
// hex-6 string passes through; anything else throws. Callers that want
// row-attributed error messages wrap this in a try/catch and re-throw,
// mirroring the normalize*/parse* split used by every other row
// hydrator in `packages/gateway/src/repo/sql.ts`.
export const normalizeUpstreamColor = (value: unknown): UpstreamColor | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`upstreamColor must be a string or null, got ${typeof value}`);
  if (UPSTREAM_COLOR_HEX_REGEX.test(value)) return value as UpstreamColor;
  if ((UPSTREAM_COLOR_PRESETS as readonly string[]).includes(value)) return value as UpstreamColor;
  throw new Error(`upstreamColor is invalid: ${JSON.stringify(value)}`);
};

// One entry in `UpstreamRecord.proxyFallbackList`. `id` is the proxy id from
// the proxies catalog or the literal 'direct' sentinel. `colos` is an
// optional whitelist of location tags (Cloudflare colos / the Node
// `RUNTIME_LOCATION` env var); when set, the dial layer only attempts this
// entry from a request that landed in one of the listed locations. Missing
// means "all locations". An empty array is never persisted — the wire schema
// rejects it and the repo normalizer strips it.
export interface ProxyFallbackEntry {
  id: string;
  colos?: string[];
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
  // Runtime state managed by the gateway autonomous flows; null when a
  // provider has no autonomous state.
  state: unknown;
  flagOverrides: FlagOverrides;
  // Public model ids the operator switched off for this upstream. Orthogonal to
  // every per-model metadata field and uniform across provider kinds: a disabled
  // id is hidden from the catalog and unroutable, but its row metadata stays
  // editable. Entries may reference ids no longer present in the live model list.
  disabledPublicModelIds: string[];
  proxyFallbackList: ProxyFallbackEntry[];
  // Per-upstream model name prefix policy. `null` keeps the bare-id behavior
  // — the upstream's models are addressed and listed by bare upstream id only.
  // When set, the registry honors `addressable` and `listed` to expose /
  // accept either form (or both).
  modelPrefix: ModelPrefixConfig | null;
  // Operator-chosen badge color. `null` falls back to the frontend's kind
  // default. Otherwise: a preset key from `UPSTREAM_COLOR_PRESETS`, or a raw
  // `#RRGGBB` string. Wire validation lives in the control-plane Zod schema.
  color: UpstreamColor | null;
}

// Model identity attached to every provider result at the provider boundary
// so the identity is decided once.
export interface TelemetryModelIdentity {
  model: string;
  upstream: string;
  modelKey: string;
  pricing: ModelPricing | null;
}

// `chat`, `text_completion`, and `embeddings` are the OTel `gen_ai.operation.name`
// well-known values we route; `image_generation` and `image_edit` are Floway
// extensions covering the concrete non-chat endpoints OTel does not name. Extend
// only when a new route lands — no wildcard string.
// OTel canonical set:
// https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-spans.md#gen_aioperationname
export type PerformanceOperation =
  | 'chat'
  | 'text_completion'
  | 'embeddings'
  | 'image_generation'
  | 'image_edit';

export interface PerformanceTelemetryContext {
  keyId: string;
  model: string;
  upstream: string;
  operation: PerformanceOperation;
  runtimeLocation: string;
}

// Public identity + capability surface shared by `InternalModel` (the merged,
// gateway-facing view) and `ProviderModel` (a single upstream's emission).
// The two shapes carry the same metadata verbatim; the merge step OR-unions
// `endpoints` and recomputes `kind`. Kept internal so callers can only touch
// the wrapper types — this base has no meaning on its own.
//
// `kind` is the high-level endpoint-family discriminator; `endpoints` is the
// precise per-protocol availability map. They are linked invariants enforced
// at the producer boundary:
//   `kind === 'embedding'` ⇔ `endpoints === { embeddings: {} }`
//   `kind === 'image'`     ⇔ `endpoints ⊂ {imagesGenerations, imagesEdits}`
//   `kind === 'chat'`      ⇒ `endpoints ⊂ generation endpoints`.
interface ModelMetadata {
  id: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
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
//     upstream; the merged catalog row from `getModels` aggregates every
//     contributing upstream.
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
// Carries the same metadata as `InternalModel` plus `providerData` (the opaque
// per-provider wire carrier — Copilot's raw variant list, Claude Code's dated
// upstream id, ...), `enabledFlags` (the effective flag set for the model
// on the emitting upstream, already resolved through every layer), and
// `flagOverrides` (optional dashboard-only view of the per-model layer
// that fed into `enabledFlags`). Providers only ever see their own emission —
// the surrounding `InternalModel` map is assembled by the registry.
export interface ProviderModel extends ModelMetadata {
  providerData?: unknown;
  enabledFlags: ReadonlySet<FlagId>;
  // Provider's per-model flag call as a sparse override — each entry
  // states the provider's opinion for that flag on this specific
  // model. Absent when the provider has no per-model call on this
  // model; when present, the map is non-empty (producers elide empty
  // overlays before emission). Populated only for providers with a
  // per-model rule (e.g., Copilot's Claude < 4.8 demote clause); other
  // providers leave it undefined.
  //
  // The data plane consumes the already-resolved `enabledFlags` and
  // never re-layers this. The field exists so the dashboard's
  // auto-row flag view can render a per-flag pill showing which flags
  // the provider itself calls on this specific model —
  // reshapeModelForDashboard projects it onto the wire as the auto-row
  // counterpart to the operator-authored
  // `UpstreamModelConfig.flagOverrides` on manual rows. The two
  // occupy the same layer-3 slot; the source is carried by the
  // enclosing row type (auto vs manual), not by the field name.
  flagOverrides?: FlagOverrides;
}
