import type { AliasSelection, AliasTarget } from './aliases.ts';
import type { ModelEndpoints } from './capabilities.ts';

// Disjoint billing dimensions a single request can be charged on. Every count
// keyed by these is non-overlapping: a prompt token is counted under exactly
// one of `input`, `input_cache_read`, `input_cache_write`,
// `input_cache_write_1h`, or `input_image`, never several at once.
//
// Convention borrowed from models.dev and LiteLLM: bare `input`/`output` mean
// the text modality AND act as the fallback rate for any modality without a
// dedicated rate; the `_image` variants are the image modality. There are no
// image cache dimensions on purpose — a live probe of Azure gpt-image-2
// confirmed its usage object never emits cached fields.
//
// `input_cache_write` is the generic cache-write bucket — protocols without
// a TTL distinction land all their writes here, and on Anthropic it covers
// the default (5-minute) TTL bucket. `input_cache_write_1h` is the explicit
// 1-hour bucket Anthropic surfaces under
// `cache_creation.ephemeral_1h_input_tokens` (extended-cache-ttl-2025-04-11).
// They are disjoint subsets of `cache_creation_input_tokens`.
export type BillingDimension = 'input' | 'input_cache_read' | 'input_cache_write' | 'input_cache_write_1h' | 'input_image' | 'output' | 'output_image';

// Iteration form of BillingDimension; the type union is the source of truth.
export const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'];

// The input-side dimensions. Their disjoint sum is a request's total prompt
// size, which selects the input-length pricing tier (see `selectInputLengthTier`).
export const INPUT_BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image'];

// A PriceVector is the per-dimension USD-per-million-token rate set for one
// billing cell, aligned with the sst/models.dev `Cost` schema
// (https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts).
// Bare `input`/`output` are the text/fallback rate and `_image` keys are the
// image modality; every key is optional and an absent key falls back per
// `unitPriceForDimension` (modality → bare, cached → uncached).
export type PriceVector = Partial<Record<BillingDimension, number>>;

// Per-model pricing. The bare dimension keys are the base cell: the default
// service tier at the base (short) input length. Two orthogonal selectors then
// pick a different cell for a given request:
//
//   - service tier — the wire value the upstream stamps on the usage object
//     (`fast`, `priority`, `flex`, ...). `tiers[value]` is that service tier's
//     cell at the base input length. An empty cell acknowledges the tier
//     without changing any rate.
//   - input length — OpenAI charges a higher full-request rate once a prompt
//     crosses a token threshold (272k for the GPT-5.6 family). Each
//     `inputLengthTiers` entry is one input-length band; unlike a service tier,
//     it depends on the per-request prompt size, so it is selected before
//     persistence (see `selectInputLengthTier`) and stored as a coordinate on
//     the usage row.
//
// The two selectors form a Cartesian grid, not a pair of overlays that
// compose: each (service tier × input length) cell is priced explicitly. When
// both selectors are non-default the price comes ONLY from the explicit
// combined cell (`inputLengthTiers[i].tiers[value]`); a missing combination is
// unpriced rather than a silent single-axis win or an auto-multiply. Resolve
// through `resolveEffectivePricing(pricing, usage.tier, usage.inputAboveTokens)`
// before any unit-price lookup.
// https://developers.openai.com/api/docs/pricing
export interface ModelPricing extends PriceVector {
  tiers?: Record<string, PriceVector>;
  inputLengthTiers?: readonly InputLengthTier[];
}

// One input-length band of the pricing grid. Its bare dimension keys are the
// full-request rates for the default service tier once a request's total input
// is STRICTLY GREATER than `aboveInputTokens`. `tiers` holds the explicit
// (service tier × this input length) cells; a service tier absent from this map
// has no published combined price and resolves to unpriced.
export interface InputLengthTier extends PriceVector {
  aboveInputTokens: number;
  tiers?: Record<string, PriceVector>;
}

// Resolve the USD-per-million-tokens unit price for one dimension against a
// pricing snapshot, applying the LiteLLM-style fallback chain: a modality with
// no dedicated rate falls back to the bare text rate, cached input falls back
// to uncached input, and the 1-hour cache write falls back to the 5-minute
// cache write before reaching uncached input. Returns null when even the
// fallback base is absent (or the whole snapshot is null), which aggregation
// treats as cost 0.
export const unitPriceForDimension = (pricing: PriceVector | null, dimension: BillingDimension): number | null => {
  if (!pricing) return null;
  switch (dimension) {
  case 'input':
    return pricing.input ?? null;
  case 'input_cache_read':
    return pricing.input_cache_read ?? pricing.input ?? null;
  case 'input_cache_write':
    return pricing.input_cache_write ?? pricing.input ?? null;
  case 'input_cache_write_1h':
    return pricing.input_cache_write_1h ?? pricing.input_cache_write ?? pricing.input ?? null;
  case 'input_image':
    return pricing.input_image ?? pricing.input ?? null;
  case 'output':
    return pricing.output ?? null;
  case 'output_image':
    return pricing.output_image ?? pricing.output ?? null;
  }
};

// Resolve a pricing snapshot to the flat PriceVector for one request's
// (service tier × input length) grid cell, so every downstream
// `unitPriceForDimension` call sees one self-contained rate set.
//
//   - service tier is a non-default selector only when the model prices it (a
//     `tiers[serviceTier]` entry exists). An absent or unrecognized service
//     tier prices as the base cell.
//   - input length is a non-default selector when `aboveInputTokens` names an
//     `inputLengthTiers` band (the coordinate `selectInputLengthTier` picked).
//
// When at most one selector is non-default the cell is base optionally overlaid
// by that selector's vector (a per-dimension shallow merge: overlay keys win,
// omitted keys inherit base and then flow through `unitPriceForDimension`'s
// fallback chain). When BOTH are non-default, an explicit combined cell MUST
// exist; its dimensions overlay the selected input-length cell, so omitted
// dimensions inherit the long-context rate rather than falling back to the
// short base cell. A missing combination returns null (unpriced) rather than
// letting one axis silently win or multiplying the two. Returns a fresh vector
// that never carries `tiers`/`inputLengthTiers`. A null snapshot resolves to
// null.
export const resolveEffectivePricing = (
  pricing: ModelPricing | null,
  serviceTier: string | null | undefined,
  aboveInputTokens?: number | null,
): PriceVector | null => {
  if (!pricing) return null;
  const { tiers, inputLengthTiers, ...base } = pricing;

  const lengthTier = aboveInputTokens != null ? inputLengthTiers?.find(t => t.aboveInputTokens === aboveInputTokens) : undefined;
  const serviceCell = serviceTier != null ? tiers?.[serviceTier] : undefined;

  if (!lengthTier) return serviceCell ? { ...base, ...serviceCell } : base;

  const { aboveInputTokens: _aboveInputTokens, tiers: lengthServiceCells, ...lengthDims } = lengthTier;
  if (!serviceCell) return { ...base, ...lengthDims };

  const combinedCell = lengthServiceCells?.[serviceTier as string];
  return combinedCell ? { ...base, ...lengthDims, ...combinedCell } : null;
};

// Pick the input-length band a request falls into, given the disjoint sum of
// its input dimensions. Returns the winning band's `aboveInputTokens` — the
// coordinate persisted on the usage row and later fed back to
// `resolveEffectivePricing` — or null when the model declares no bands or the
// request stays at or below every threshold. Selection is strictly greater than
// the threshold (a prompt of exactly `aboveInputTokens` stays in the band
// below), and the highest threshold the request exceeds wins.
export const selectInputLengthTier = (pricing: ModelPricing | null, totalInputTokens: number): number | null => {
  let selected: number | null = null;
  for (const tier of pricing?.inputLengthTiers ?? []) {
    if (!Number.isSafeInteger(tier.aboveInputTokens) || tier.aboveInputTokens <= 0) {
      throw new RangeError(`input-length pricing threshold must be a positive safe integer, received ${tier.aboveInputTokens}`);
    }
    if (totalInputTokens > tier.aboveInputTokens && (selected === null || tier.aboveInputTokens > selected)) {
      selected = tier.aboveInputTokens;
    }
  }
  return selected;
};

// High-level endpoint-family discriminator. A model belongs to exactly one
// kind; cross-cutting features (vision, function calling, structured
// outputs) are orthogonal and modeled separately when needed.
//
// Convention borrowed from Together AI's `type` field on /v1/models, which
// chooses a single string enum because each model id in practice maps to
// one endpoint family. Field is named `kind` rather than `type` because
// PublicModel already carries Anthropic's `type: 'model'` discriminator.
//
// Add a value here only when we actually route that endpoint family — do
// not pre-declare for future capabilities.
export type ModelKind = 'chat' | 'embedding' | 'image';

export type Modality = 'text' | 'image';

// Operator-configured chat capability metadata. Lives in protocols because it
// flows verbatim onto PublicModel.chat (the wire DTO) and is also re-exported
// by @floway-dev/provider as UpstreamChatModelConfig for the catalog side; one
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
// upstream catalog. `targets` carries every configured target — including
// targets the live catalog currently can not serve — so the dashboard can
// show the full configuration and warn about unavailable ones without a
// second control-plane round trip. The alias's `kind` and `name` live on
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
  // Public-facing endpoint surface. Mirrors the upstream-side ModelEndpoints
  // verbatim — by the time a model reaches this DTO, the provider layer
  // (e.g. provider-ollama, provider-copilot) has already projected the raw
  // upstream catalog into the public-facing shape: the three chat endpoints
  // (chatCompletions / messages / responses) appear together because the
  // gateway translates between them, while `completions`, `embeddings`,
  // `imagesGenerations`, and `imagesEdits` only appear when the upstream
  // natively serves them. Alias entries surface the UNION of every
  // currently-available target's endpoint map — at request time the
  // resolver narrows the pool to targets that serve the inbound endpoint,
  // so any endpoint advertised here is reachable through at least one
  // target.
  endpoints: ModelEndpoints;
  cost?: ModelPricing;
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
