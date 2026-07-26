import type { AliasSelection, AliasTarget } from './aliases.ts';
import type { ModelEndpoints, ModelKind } from './endpoints.ts';
import type { ModelPricing } from './pricing.ts';

export const RERANK_PROTOCOLS = [
  'cohere-v1',
  'cohere-v2',
  'jina-v1',
  'voyage-v1',
  'dashscope-compatible',
  'dashscope-native',
] as const;

export type RerankProtocol = typeof RERANK_PROTOCOLS[number];
export type RerankSourceProtocol = Exclude<RerankProtocol, 'dashscope-compatible' | 'dashscope-native'>;

// Rerank has no vendor-neutral upstream URL. The operator chooses the wire
// protocol on each model and may replace that protocol's canonical path for a
// compatible server. Keeping this off the upstream prevents one model's
// protocol choice from leaking onto every other model at the same base URL.
export interface RerankTarget {
  protocol: RerankProtocol;
  path?: string;
}

export type Modality = 'text' | 'image';

// Chat capability metadata for one model. Providers that can read it off the
// raw upstream catalog fill it themselves; elsewhere it comes from the
// operator's model config. Lives in protocols because it flows verbatim onto
// PublicModel.chat (the wire DTO) and is also re-exported by
// @floway-dev/provider as UpstreamChatModelConfig for the catalog side; one
// definition serves both surfaces.
export interface ChatModelInfo {
  modalities?: {
    input: readonly Modality[];
    output: readonly Modality[];
  };
  reasoning?: {
    // Discrete effort levels — a closed set of named presets (e.g. low/medium/high).
    effort?: { supported: readonly string[]; default: string };
    // Operator-supplied token budget. Bounds are optional; absent bounds mean
    // "operator can supply a budget, but legal range is unknown".
    budget_tokens?: { min?: number; max?: number };
    // Model-controlled adaptive depth — the model decides how much reasoning to do.
    adaptive?: boolean;
    // Always-on reasoning — the model cannot be instructed to skip it.
    mandatory?: boolean;
  };
}

// Alias provenance attached to a `/v1/models` entry that the gateway
// synthesized from an operator-defined alias rather than fetched from an
// upstream catalog. `targets` is the configured target list — projected
// as-is on admin surfaces and filtered to the caller-reachable subset on
// data-plane / non-admin surfaces. The alias's `kind` and `name` live on
// the enclosing `PublicModel` (`kind`, `id`); every alias-synthesized row
// puts the alias name on its outer `id` and the alias kind on its outer
// `kind`, so the sidecar avoids duplicating them.
export interface PublicModelAliasedFrom {
  selection: AliasSelection;
  targets: AliasTarget[];
}

// Operator-set context-window / prompt / output token limits the gateway
// surfaces on /v1/models. Pure data — every field is optional so a
// partially-known upstream still produces a sensible row.
export interface PublicModelLimits {
  max_output_tokens?: number;
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
}

// Public DTO served at /v1/models and /models. Single superset shape — OpenAI's
// and Anthropic's /models field names do not overlap, so one payload satisfies
// both client shapes.
export interface PublicModel {
  // OpenAI fields
  id: string;
  object: 'model';
  owned_by?: string;
  created?: number;
  // Anthropic fields
  type: 'model';
  display_name: string;
  created_at?: string;
  // Non-standard extra fields below.
  limits: PublicModelLimits;
  kind: ModelKind;
  // The merged upstream wire surface: the union of the endpoint keys the
  // contributing upstreams expose natively, and on an alias-synthesized row
  // the union across the alias's currently-available targets, so every key
  // advertised here is served natively by at least one of them. It is not a
  // list of client-callable Floway routes. Translation widens the callable
  // chat surface past the listed keys — a chat source protocol reaches any
  // candidate carrying one of its preferred chat targets, and Gemini has no
  // key of its own at all. The non-chat keys (`completions`, `embeddings`,
  // `imagesGenerations`, `imagesEdits`, `rerank`, `audioTranscriptions`) are
  // callable exactly where they appear.
  endpoints: ModelEndpoints;
  pricing?: ModelPricing;
  chat?: ChatModelInfo;
  // Present only on entries the gateway synthesized from an operator-defined
  // alias; absent for entries that came from an upstream catalog.
  aliasedFrom?: PublicModelAliasedFrom;
  // Sidecar flag carried only on entries that are addressable-but-not-
  // listed: ids the data plane accepts (via `modelPrefix.addressable`
  // alternates) but that do NOT appear in the default `/v1/models`
  // payload. Absent on every default-listed row and on alias rows — both
  // are part of the public catalog. The field surfaces only on
  // `/api/models?include_unlisted=true` rows that the dashboard's alias
  // edit combobox shows alongside the listed catalog. Wire shape is
  // intentionally `unlisted?: true` — boolean would add a wire byte to
  // every listed row for no caller benefit.
  unlisted?: true;
}

export interface PublicModelsResponse {
  // OpenAI container
  object: 'list';
  // Anthropic container
  has_more: false;
  first_id: string | null;
  last_id: string | null;
  data: PublicModel[];
}
