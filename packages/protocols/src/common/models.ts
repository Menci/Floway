import type { AliasSelection, AliasTarget } from './aliases.ts';
import type { ModelEndpoints } from './capabilities.ts';

// Disjoint billing dimensions a single request can be charged on. Every count
// keyed by these is non-overlapping: a prompt token is counted under exactly
// one of `input`, `input_cache_read`, `input_cache_write`,
// `input_cache_write_1h`, or `input_image`, never several at once.
//
// Convention borrowed from models.dev and LiteLLM: bare `input`/`output` mean
// the text modality and the `_image` variants mean the image modality. Every
// dimension is priced explicitly; an absent rate leaves that dimension
// unpriced. There are no image cache dimensions on purpose — a live probe of
// Azure gpt-image-2 confirmed its usage object never emits cached fields.
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

// USD-per-million-token rates for one entry; input/output are text rates and
// the _image keys are image rates.
export type PriceVector = Partial<Record<BillingDimension, number>>;

export type PricingThresholdOperator = 'gt' | 'gte';

export interface PricingThresholdCoordinate {
  operator: PricingThresholdOperator;
  value: number;
}

export type PricingCoordinateValue = string | PricingThresholdCoordinate;
export type PricingSelector = Readonly<Record<string, PricingCoordinateValue>>;

export type PricingRuntimeFacts = Readonly<{
  serviceTier?: string | null;
  inputTokens: number;
}>;

type PricingRuntimeFactKey<Value> = {
  [Key in keyof PricingRuntimeFacts]-?: Exclude<PricingRuntimeFacts[Key], null | undefined> extends Value ? Key : never;
}[keyof PricingRuntimeFacts] & string;

export type PricingAxis =
  | { id: string; kind: 'equality'; label: string; fact: PricingRuntimeFactKey<string> }
  | { id: string; kind: 'threshold'; label: string; fact: PricingRuntimeFactKey<number> };

// Each axis binds its authoring metadata to the runtime fact used for request
// projection, so a new registry entry cannot silently remain runtime-inert.
export const PRICING_AXES = [
  { id: 'serviceTier', kind: 'equality', label: 'Service Tier', fact: 'serviceTier' },
  { id: 'inputTokens', kind: 'threshold', label: 'Input Tokens', fact: 'inputTokens' },
] as const satisfies readonly PricingAxis[];

export interface PricingEntry {
  selector?: PricingSelector;
  rates: PriceVector;
}

// Per-model pricing as symmetric flat entries. `{ rates }` is the unique Base
// entry; non-default coordinates use the same shape. Threshold bands are
// implied by selectors rather than maintained as a second catalog. An exact
// selector miss resolves to the whole Base vector; rates are never merged or
// inherited field-by-field across entries.
export interface ModelPricing {
  entries: readonly PricingEntry[];
}

export interface PricedRequest {
  selector: PricingSelector;
  rates: PriceVector | null;
}

export const validatePriceVector = (pricing: PriceVector, path = 'price vector'): void => {
  const dimensions = BILLING_DIMENSIONS.filter(dimension => pricing[dimension] !== undefined);
  if (dimensions.length === 0) throw new Error(`${path} must contain at least one rate`);
  for (const dimension of dimensions) {
    const rate = pricing[dimension]!;
    if (!Number.isFinite(rate) || rate < 0) throw new RangeError(`${path}.${dimension} must be a finite non-negative number`);
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

const selectorCoordinatesByKind = (selector: PricingSelector, kind: PricingAxis['kind']): PricingSelector =>
  Object.fromEntries(Object.entries(selector).filter(([axisId]) => axisById.get(axisId)!.kind === kind));

const equalityScopeKey = (selector: PricingSelector): string =>
  JSON.stringify(selectorCoordinatesByKind(selector, 'equality'));

export const validateModelPricing = (pricing: ModelPricing): void => {
  if (pricing.entries.length === 0) throw new Error('model pricing must declare at least one entry');
  const selectors = pricing.entries.map((entry, index) => {
    validatePriceVector(entry.rates, `model pricing entry ${index}.rates`);
    return canonicalizePricingSelector(entry.selector);
  });
  const baseIndexes = selectors.flatMap((selector, index) => Object.keys(selector).length === 0 ? [index] : []);
  if (baseIndexes.length !== 1) throw new Error('model pricing must declare exactly one base entry');
  const baseIndex = baseIndexes[0]!;
  const dimensionsFor = (rates: PriceVector): readonly BillingDimension[] =>
    BILLING_DIMENSIONS.filter(dimension => rates[dimension] !== undefined);
  const expectedDimensions = dimensionsFor(pricing.entries[baseIndex]!.rates);
  for (let index = 0; index < pricing.entries.length; index++) {
    if (index === baseIndex) continue;
    const dimensions = dimensionsFor(pricing.entries[index]!.rates);
    if (dimensions.length !== expectedDimensions.length || dimensions.some((dimension, i) => dimension !== expectedDimensions[i])) {
      throw new Error(`model pricing entry ${index}.rates must define the same dimensions as the base entry (${expectedDimensions.join(', ')})`);
    }
  }
  const selectorKeys = new Set<string>();
  const thresholdOperatorsByScope = new Map<string, Map<string, Map<number, PricingThresholdOperator>>>();
  const operatorsFor = (scopeKey: string, axisId: string): Map<number, PricingThresholdOperator> => {
    const byAxis = thresholdOperatorsByScope.get(scopeKey) ?? new Map<string, Map<number, PricingThresholdOperator>>();
    thresholdOperatorsByScope.set(scopeKey, byAxis);
    const operators = byAxis.get(axisId) ?? new Map<number, PricingThresholdOperator>();
    byAxis.set(axisId, operators);
    return operators;
  };
  for (const selector of selectors) {
    const key = JSON.stringify(selector);
    if (selectorKeys.has(key)) throw new Error(`duplicate pricing entry selector: ${key}`);
    selectorKeys.add(key);
    const scopeKey = equalityScopeKey(selector);
    for (const [axisId, coordinate] of Object.entries(selector)) {
      if (typeof coordinate === 'string') continue;
      const overlappingScopes = scopeKey === '{}'
        ? [...thresholdOperatorsByScope.keys()]
        : ['{}', scopeKey];
      for (const overlappingScope of overlappingScopes) {
        const existing = thresholdOperatorsByScope.get(overlappingScope)?.get(axisId)?.get(coordinate.value);
        if (existing !== undefined && existing !== coordinate.operator) {
          throw new Error(`conflicting pricing threshold operators for ${axisId} at ${coordinate.value} in overlapping equality scopes`);
        }
      }
      operatorsFor(scopeKey, axisId).set(coordinate.value, coordinate.operator);
    }
  }
};

interface CompiledModelPricing {
  ratesBySelectorKey: ReadonlyMap<string, PriceVector>;
  thresholdBandsByAxisAndEqualityScope: ReadonlyMap<string, ReadonlyMap<string, readonly PricingThresholdCoordinate[]>>;
}

const compiledPricing = new WeakMap<ModelPricing, CompiledModelPricing>();

// Pricing objects are immutable after provider/config construction. Compilation
// validates and canonicalizes once per stable object identity.
const compileModelPricing = (pricing: ModelPricing): CompiledModelPricing => {
  const existing = compiledPricing.get(pricing);
  if (existing) return existing;
  validateModelPricing(pricing);
  const ratesBySelectorKey = new Map<string, PriceVector>();
  const bandsByAxisAndEqualityScope = new Map<string, Map<string, Map<number, PricingThresholdCoordinate>>>();
  for (const entry of pricing.entries) {
    const selector = canonicalizePricingSelector(entry.selector);
    ratesBySelectorKey.set(JSON.stringify(selector), entry.rates);
    for (const axis of PRICING_AXES) {
      if (axis.kind !== 'threshold') continue;
      const coordinate = selector[axis.id];
      if (typeof coordinate !== 'object') continue;
      const scopeKey = equalityScopeKey(selector);
      const bandsByScope = bandsByAxisAndEqualityScope.get(axis.id) ?? new Map<string, Map<number, PricingThresholdCoordinate>>();
      bandsByAxisAndEqualityScope.set(axis.id, bandsByScope);
      const bands = bandsByScope.get(scopeKey) ?? new Map<number, PricingThresholdCoordinate>();
      bands.set(coordinate.value, coordinate);
      bandsByScope.set(scopeKey, bands);
    }
  }
  const thresholdBandsByAxisAndEqualityScope = new Map(
    [...bandsByAxisAndEqualityScope].map(([axisId, bandsByScope]) => [
      axisId,
      new Map([...bandsByScope].map(([scopeKey, bands]) =>
        [scopeKey, [...bands.values()].toSorted((a, b) => b.value - a.value)] as const)),
    ] as const),
  );
  const compiled = { ratesBySelectorKey, thresholdBandsByAxisAndEqualityScope };
  compiledPricing.set(pricing, compiled);
  return compiled;
};

export const pricingEntry = (rates: PriceVector, selector?: PricingSelector): PricingEntry => {
  validatePriceVector(rates);
  const canonicalSelector = canonicalizePricingSelector(selector);
  return { ...(Object.keys(canonicalSelector).length > 0 ? { selector: canonicalSelector } : {}), rates };
};
export const modelPricing = (...entries: PricingEntry[]): ModelPricing => {
  const pricing: ModelPricing = { entries };
  compileModelPricing(pricing);
  return pricing;
};
export const basePricing = (rates: PriceVector): ModelPricing => modelPricing(pricingEntry(rates));

const thresholdMatches = (coordinate: PricingThresholdCoordinate, fact: number): boolean =>
  coordinate.operator === 'gt' ? fact > coordinate.value : fact >= coordinate.value;

export const priceRequest = (pricing: ModelPricing | null, facts: PricingRuntimeFacts): PricedRequest => {
  const compiled = pricing ? compileModelPricing(pricing) : undefined;
  const selector: Record<string, PricingCoordinateValue> = {};
  for (const axis of PRICING_AXES) {
    if (axis.kind !== 'equality') continue;
    const fact = facts[axis.fact];
    if (fact != null) selector[axis.id] = fact;
  }
  const scopeKey = JSON.stringify(selector);
  for (const axis of PRICING_AXES) {
    if (axis.kind !== 'threshold') continue;
    const fact = facts[axis.fact];
    if (fact === undefined) continue;
    const bandsByScope = compiled?.thresholdBandsByAxisAndEqualityScope.get(axis.id);
    const bands = [
      ...(bandsByScope?.get('{}') ?? []),
      ...(scopeKey === '{}' ? [] : (bandsByScope?.get(scopeKey) ?? [])),
    ].toSorted((a, b) => b.value - a.value);
    const band = bands.find(coordinate => thresholdMatches(coordinate, fact));
    if (band) selector[axis.id] = band;
  }
  const canonicalSelector = canonicalizePricingSelector(selector);
  const exactRates = compiled?.ratesBySelectorKey.get(JSON.stringify(canonicalSelector));
  if (exactRates !== undefined) return { selector: canonicalSelector, rates: exactRates };
  const baseRates = compiled?.ratesBySelectorKey.get('{}');
  return baseRates !== undefined ? { selector: {}, rates: baseRates } : { selector: canonicalSelector, rates: null };
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
