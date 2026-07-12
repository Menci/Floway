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
// size, which projects the request onto the declared inputTokens thresholds.
export const INPUT_BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image'];

// A PriceVector is the per-dimension USD-per-million-token rate set for one
// billing cell, aligned with the sst/models.dev `Cost` schema
// (https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts).
// Bare `input`/`output` are the text/fallback rate and `_image` keys are the
// image modality; every key is optional and an absent key falls back per
// `unitPriceForDimension` (modality → bare, cached → uncached).
export type PriceVector = Partial<Record<BillingDimension, number>>;

export type PricingThresholdOperator = 'gt' | 'gte';

export interface PricingThresholdCoordinate {
  operator: PricingThresholdOperator;
  value: number;
}

export type PricingCoordinateValue = string | PricingThresholdCoordinate;
export type PricingSelector = Readonly<Record<string, PricingCoordinateValue>>;

// The registry is the single source of truth for selector authoring and runtime
// projection. It is exported as plain metadata so the dashboard can render the
// same generic axes without duplicating their ids or value kinds.
export const PRICING_AXES = [
  { id: 'serviceTier', kind: 'equality', label: 'Service Tier' },
  { id: 'inputTokens', kind: 'threshold', label: 'Input Tokens' },
] as const;

export type PricingAxis = typeof PRICING_AXES[number];
export type PricingRuntimeFacts = Readonly<{
  serviceTier?: string | null;
  inputTokens: number;
}>;

// One explicit point in the selector Cartesian product. Rates never inherit
// from another cell: every published coordinate carries its own PriceVector.
// Within a vector, `unitPriceForDimension` still provides the documented
// modality/cache fallback chain.
export interface PricingCell {
  selector?: PricingSelector;
  rates: PriceVector;
}

// Per-model pricing as symmetric flat cells. `{ rates }` is the base cell;
// non-default coordinates use the same shape. Threshold bands are implied by
// selectors rather than maintained as a second catalog. Missing exact
// coordinates are unpriced; Floway never chooses one selector over another or
// derives rates across cells.
export interface ModelPricing {
  cells: readonly PricingCell[];
}

export interface PricedRequest {
  selector: PricingSelector;
  rates: PriceVector | null;
}

// Resolve the USD-per-million-tokens unit price for one dimension against a
// pricing snapshot, applying the LiteLLM-style fallback chain: a modality with
// no dedicated rate falls back to the bare text rate, cached input falls back
// to uncached input, and the 1-hour cache write falls back to the 5-minute
// cache write before reaching uncached input. Returns null when even the
// fallback base is absent (or the whole snapshot is null), which aggregation
// treats as cost 0.
export const validatePriceVector = (pricing: PriceVector, path = 'price vector'): void => {
  const dimensions = BILLING_DIMENSIONS.filter(dimension => pricing[dimension] !== undefined);
  if (dimensions.length === 0) throw new Error(`${path} must contain at least one rate`);
  for (const dimension of dimensions) {
    const rate = pricing[dimension]!;
    if (!Number.isFinite(rate) || rate < 0) throw new RangeError(`${path}.${dimension} must be a finite non-negative number`);
  }
};

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

const axisById = new Map<string, PricingAxis>(PRICING_AXES.map(axis => [axis.id, axis]));

const canonicalThreshold = (value: PricingCoordinateValue, path: string): PricingThresholdCoordinate => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be a threshold object`);
  const { operator, value: threshold } = value;
  if (operator !== 'gt' && operator !== 'gte') throw new RangeError(`${path}.operator must be "gt" or "gte"`);
  if (!Number.isSafeInteger(threshold) || threshold <= 0) throw new RangeError(`${path}.value must be a positive safe integer`);
  return { operator, value: threshold };
};

export const canonicalizePricingSelector = (selector: PricingSelector | undefined): PricingSelector => {
  const canonical: Record<string, PricingCoordinateValue> = {};
  for (const axisId of Object.keys(selector ?? {}).toSorted()) {
    const axis = axisById.get(axisId);
    if (!axis) throw new RangeError(`unknown pricing selector axis: ${axisId}`);
    const value = selector![axisId];
    if (axis.kind === 'equality') {
      if (typeof value !== 'string' || value.length === 0) throw new RangeError(`pricing selector ${axisId} must be a non-empty string`);
      canonical[axisId] = value;
    } else {
      canonical[axisId] = canonicalThreshold(value, `pricing selector ${axisId}`);
    }
  }
  return canonical;
};

export const canonicalPricingSelectorKey = (selector: PricingSelector | undefined): string =>
  JSON.stringify(canonicalizePricingSelector(selector));

export const parsePricingSelectorKey = (key: string): PricingSelector => {
  const parsed: unknown = JSON.parse(key);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('pricing selector key must encode an object');
  const selector = canonicalizePricingSelector(parsed as PricingSelector);
  if (JSON.stringify(selector) !== key) throw new Error('pricing selector key is not canonical');
  return selector;
};

export const validateModelPricing = (pricing: ModelPricing): void => {
  if (pricing.cells.length === 0) throw new Error('model pricing must declare at least one cell');
  const selectors = pricing.cells.map((cell, index) => {
    validatePriceVector(cell.rates, `model pricing cell ${index}.rates`);
    return canonicalizePricingSelector(cell.selector);
  });
  const cellKeys = new Set<string>();
  const thresholds = new Map<string, Map<number, PricingThresholdOperator>>();
  for (const selector of selectors) {
    const key = JSON.stringify(selector);
    if (cellKeys.has(key)) throw new Error(`duplicate pricing cell selector: ${key}`);
    cellKeys.add(key);
    for (const [axisId, coordinate] of Object.entries(selector)) {
      if (typeof coordinate === 'string') continue;
      const values = thresholds.get(axisId) ?? new Map<number, PricingThresholdOperator>();
      const existing = values.get(coordinate.value);
      if (existing !== undefined && existing !== coordinate.operator) throw new Error(`conflicting pricing threshold operators for ${axisId} at ${coordinate.value}`);
      values.set(coordinate.value, coordinate.operator);
      thresholds.set(axisId, values);
    }
  }
  for (const selector of selectors) {
    const hasEquality = Object.keys(selector).some(axisId => axisById.get(axisId)?.kind === 'equality');
    if (!hasEquality) continue;
    const thresholdOnly = Object.fromEntries(Object.entries(selector).filter(([axisId]) => axisById.get(axisId)?.kind === 'threshold'));
    if (Object.keys(thresholdOnly).length > 0 && !cellKeys.has(JSON.stringify(thresholdOnly))) {
      throw new Error(`pricing threshold selector ${JSON.stringify(thresholdOnly)} must be declared without equality coordinates`);
    }
  }
};

interface CompiledModelPricing {
  cellByKey: ReadonlyMap<string, PriceVector>;
  inputBands: readonly PricingThresholdCoordinate[];
}

const compiledPricing = new WeakMap<ModelPricing, CompiledModelPricing>();

// Pricing objects are immutable after provider/config construction. Compilation
// validates and canonicalizes once per stable object identity.
export const compileModelPricing = (pricing: ModelPricing): CompiledModelPricing => {
  const existing = compiledPricing.get(pricing);
  if (existing) return existing;
  validateModelPricing(pricing);
  const cellByKey = new Map<string, PriceVector>();
  const bands = new Map<number, PricingThresholdCoordinate>();
  for (const cell of pricing.cells) {
    const selector = canonicalizePricingSelector(cell.selector);
    cellByKey.set(JSON.stringify(selector), cell.rates);
    const input = selector.inputTokens;
    if (typeof input === 'object') bands.set(input.value, input);
  }
  const compiled = { cellByKey, inputBands: [...bands.values()].toSorted((a, b) => b.value - a.value) };
  compiledPricing.set(pricing, compiled);
  return compiled;
};

export const pricingCell = (rates: PriceVector, selector?: PricingSelector): PricingCell => {
  validatePriceVector(rates);
  const canonicalSelector = canonicalizePricingSelector(selector);
  return { ...(Object.keys(canonicalSelector).length > 0 ? { selector: canonicalSelector } : {}), rates };
};
export const modelPricing = (...cells: PricingCell[]): ModelPricing => {
  const pricing: ModelPricing = { cells };
  compileModelPricing(pricing);
  return pricing;
};
export const basePricing = (rates: PriceVector): ModelPricing => modelPricing(pricingCell(rates));

const thresholdMatches = (coordinate: PricingThresholdCoordinate, fact: number): boolean =>
  coordinate.operator === 'gt' ? fact > coordinate.value : fact >= coordinate.value;

export const priceRequest = (pricing: ModelPricing | null, facts: PricingRuntimeFacts): PricedRequest => {
  const compiled = pricing ? compileModelPricing(pricing) : undefined;
  const selector: Record<string, PricingCoordinateValue> = {};
  if (facts.serviceTier != null) selector.serviceTier = facts.serviceTier;
  const band = compiled?.inputBands.find(coordinate => thresholdMatches(coordinate, facts.inputTokens));
  if (band) selector.inputTokens = band;
  const canonicalSelector = canonicalizePricingSelector(selector);
  return { selector: canonicalSelector, rates: compiled?.cellByKey.get(JSON.stringify(canonicalSelector)) ?? null };
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
