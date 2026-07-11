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

// Pricing selectors are orthogonal coordinates. Service tier comes from the
// upstream usage object; inputAboveTokens is selected per request from total
// disjoint input. An omitted coordinate is the default on that axis.
export interface PricingSelector {
  serviceTier?: string;
  inputAboveTokens?: number;
}

// One explicit point in the selector Cartesian product. Rates never inherit
// from another cell: every published coordinate carries its own PriceVector.
// Within a vector, `unitPriceForDimension` still provides the documented
// modality/cache fallback chain.
export interface PricingCell {
  selector?: PricingSelector;
  rates: PriceVector;
}

// Per-model pricing as symmetric flat cells. `{ rates }` is the default service
// tier at the base input length; non-default selectors use the same shape. This
// keeps future selector axes independent instead of privileging one with nested
// data. Duplicate coordinates and malformed selectors are authoring errors
// rejected deterministically by the resolver.
//
// OpenAI's GPT-5.6 input-length selector uses `inputAboveTokens: 272000`: total
// input must be STRICTLY greater than 272000, and the selected cell reprices the
// whole request. Missing exact coordinates are unpriced; Floway never chooses
// one selector over another or derives cross-cell rates.
// https://developers.openai.com/api/docs/pricing
export interface ModelPricing {
  cells: readonly PricingCell[];
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

const pricingCoordinateKey = (selector: PricingSelector | undefined): string =>
  `${selector?.serviceTier ?? ''}\0${selector?.inputAboveTokens ?? ''}`;

const validatePricingCells = (pricing: ModelPricing): void => {
  const coordinates = new Set<string>();
  for (const cell of pricing.cells) {
    const { serviceTier, inputAboveTokens } = cell.selector ?? {};
    if (serviceTier?.length === 0) {
      throw new RangeError('pricing service-tier selector must be non-empty');
    }
    if (inputAboveTokens !== undefined && (!Number.isSafeInteger(inputAboveTokens) || inputAboveTokens <= 0)) {
      throw new RangeError(`input-length pricing threshold must be a positive safe integer, received ${inputAboveTokens}`);
    }
    const coordinate = pricingCoordinateKey(cell.selector);
    if (coordinates.has(coordinate)) {
      throw new Error(`duplicate pricing cell coordinate: serviceTier=${serviceTier ?? 'default'}, inputAboveTokens=${inputAboveTokens ?? 'base'}`);
    }
    coordinates.add(coordinate);
  }
};

// Resolve exactly one (service tier × input length) coordinate. Cells never
// inherit from one another: an absent exact coordinate is unpriced. Default
// protocol values are normalized to null before this function, so unknown wire
// service tiers remain real coordinates and do not silently use base pricing.
export const resolveEffectivePricing = (
  pricing: ModelPricing | null,
  serviceTier: string | null | undefined,
  inputAboveTokens?: number | null,
): PriceVector | null => {
  if (!pricing) return null;
  validatePricingCells(pricing);
  const coordinate = pricingCoordinateKey({
    ...(serviceTier != null ? { serviceTier } : {}),
    ...(inputAboveTokens != null ? { inputAboveTokens } : {}),
  });
  return pricing.cells.find(cell => pricingCoordinateKey(cell.selector) === coordinate)?.rates ?? null;
};

// Pick the highest input threshold strictly crossed by the request, independent
// of service tier. The returned coordinate is persisted with the request and
// later exact-matched by `resolveEffectivePricing`; a service-tier combination
// missing at that coordinate remains unpriced.
export const selectInputLengthTier = (pricing: ModelPricing | null, totalInputTokens: number): number | null => {
  if (!pricing) return null;
  validatePricingCells(pricing);
  let selected: number | null = null;
  for (const cell of pricing.cells) {
    const threshold = cell.selector?.inputAboveTokens;
    if (threshold !== undefined && totalInputTokens > threshold && (selected === null || threshold > selected)) {
      selected = threshold;
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
