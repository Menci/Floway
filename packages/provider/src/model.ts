import type { UpstreamChatModelConfig } from './model-config.ts';
import type { ModelPrefixConfig } from './model-prefix.ts';
import type { ModelKind, ModelEndpoints, ModelPricing } from '@floway-dev/protocols/common';

export const ALL_PROVIDER_KINDS = ['copilot', 'custom', 'azure', 'codex', 'claude-code', 'ollama'] as const;
export type UpstreamProviderKind = typeof ALL_PROVIDER_KINDS[number];

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
  provider: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  config: unknown;
  // Runtime state managed by the gateway autonomous flows; null when a
  // provider has no autonomous state.
  state: unknown;
  flagOverrides: Record<string, boolean>;
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
}

// Model identity attached to every provider result at the provider boundary
// so the identity is decided once.
export interface TelemetryModelIdentity {
  model: string;
  upstream: string;
  modelKey: string;
  cost: ModelPricing | null;
}

export interface PerformanceTelemetryContext {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  stream: boolean;
  runtimeLocation: string;
}

// The neutral internal model shape produced by every provider.
// Provider-internal raw fields stay inside that provider's own types and
// projections; nothing upstream-shaped leaks onto this type.
//
// `kind` is the high-level endpoint-family discriminator; `endpoints` is the
// precise per-protocol availability map. They are linked invariants enforced
// at the producer boundary:
//   `kind === 'embedding'` ⇔ `endpoints === { embeddings: {} }`
//   `kind === 'image'`     ⇔ `endpoints ⊂ {imagesGenerations, imagesEdits}`
//   `kind === 'chat'`      ⇒ `endpoints ⊂ generation endpoints`.
//
// `endpoints` declares which protocols this model is reachable through.
// The value is scoped by who produced the row: an `UpstreamModel` carries
// that one upstream's wire capability; a merged catalog row (the projection
// `getModels` returns) carries the OR-union across every upstream emitting
// under the same public id — the gateway as a whole reaches the union,
// translating where the dispatched upstream's native wire does not match.
// Per-request dispatch reads off the per-upstream `UpstreamModel`; listing
// endpoints (`/v1/models`, `/models`, `/v1beta/models`, and the control-
// plane catalog) project the merged row.
export interface InternalModel {
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
  cost?: ModelPricing;
  chat?: UpstreamChatModelConfig;
  endpoints: ModelEndpoints;
}

export interface UpstreamModel extends InternalModel {
  providerData?: unknown;
  enabledFlags: ReadonlySet<string>;
}
