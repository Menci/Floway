import { divideDecimalString, parseNonNegativeDecimalString, type DecimalString } from './decimal.ts';
import { canonicalPricingTimeWindow, compilePricingTimeWindow, pricingTimeWindowsOverlap, type PricingTimeWindowCoordinate } from './pricing-time-window.ts';
import { billableServiceTier } from './usage.ts';

export type { PricingTimeWindowCoordinate } from './pricing-time-window.ts';

// Disjoint billing metrics a single request can be charged on. Every count
// keyed by these is non-overlapping: a prompt token is counted under exactly
// one input metric, never several at once.
//
// Bare `input`/`output` preserve an upstream's general counters; they are not
// assumed to be text-only when the upstream does not report modalities
// separately. The `_image` variants are used only for separately metered image
// counters, and adapters keep them disjoint from the corresponding general
// counter. Every metric is priced explicitly; an absent rate leaves that
// metric unpriced. Image cache metrics are absent until an upstream
// exposes disjoint counters that can be recorded without inference.
//
// `input_cache_write` is the generic cache-write bucket — protocols without
// a TTL distinction land all their writes here, and on Anthropic it covers
// the default (5-minute) TTL bucket. `input_cache_write_1h` is the explicit
// 1-hour bucket Anthropic surfaces under
// `cache_creation.ephemeral_1h_input_tokens` (extended-cache-ttl-2025-04-11).
// They are disjoint subsets of `cache_creation_input_tokens`.
export const BILLING_METRICS = ['input_tokens', 'input_cache_read_tokens', 'input_cache_write_tokens', 'input_cache_write_1h_tokens', 'input_image_tokens', 'input_audio_tokens', 'input_audio_seconds', 'output_tokens', 'output_image_tokens', 'rerank_searches'] as const;
export type BillingMetric = (typeof BILLING_METRICS)[number];

export const parseBillingMetric = (value: unknown, label = 'billing metric'): BillingMetric => {
  if (typeof value === 'string' && (BILLING_METRICS as readonly string[]).includes(value)) return value as BillingMetric;
  throw new TypeError(`${label} is invalid: ${JSON.stringify(value)}`);
};

// USD per one base metric unit for one pricing entry.
export type PriceVector = Partial<Record<BillingMetric, DecimalString>>;

export type PricingThresholdOperator = 'gt' | 'gte';

export interface PricingThresholdCoordinate {
  operator: PricingThresholdOperator;
  value: number;
}

export type PricingCoordinateValue = string | PricingThresholdCoordinate | PricingTimeWindowCoordinate;
export type PricingSelector = Readonly<Record<string, PricingCoordinateValue>>;

export type PricingRuntimeFacts = Readonly<{
  serviceTier?: string | null;
  inputTokens?: number;
  requestStartedAt?: number;
}>;

type PricingRuntimeFactKey<Value> = {
  [Key in keyof PricingRuntimeFacts]-?: Exclude<PricingRuntimeFacts[Key], null | undefined> extends Value ? Key : never;
}[keyof PricingRuntimeFacts] & string;

export type PricingAxis =
  | { id: string; kind: 'equality'; label: string; fact: PricingRuntimeFactKey<string> }
  | { id: string; kind: 'threshold'; label: string; fact: PricingRuntimeFactKey<number> }
  | { id: string; kind: 'time-window'; label: string; fact: 'requestStartedAt' };

// Each axis binds its authoring metadata to the runtime fact used for request
// projection, so a new registry entry cannot silently remain runtime-inert.
export const PRICING_AXES = [
  { id: 'serviceTier', kind: 'equality', label: 'Service Tier', fact: 'serviceTier' },
  { id: 'inputTokens', kind: 'threshold', label: 'Input Tokens', fact: 'inputTokens' },
  { id: 'timeWindow', kind: 'time-window', label: 'Time Window', fact: 'requestStartedAt' },
] as const satisfies readonly PricingAxis[];

export interface PricingEntry {
  selector?: PricingSelector;
  rates: PriceVector;
}

// Per-model pricing as symmetric flat entries. `{ rates }` is the unique Base entry; non-default
// coordinates use the same shape. Threshold bands are implied by selectors
// rather than maintained as a second catalog. An exact selector miss resolves
// to the whole Base vector; rates are never merged or inherited field-by-field
// across entries.
export interface ModelPricing {
  entries: readonly PricingEntry[];
}

export interface PricedRequest {
  selector: PricingSelector;
  rates: PriceVector | null;
}

export type ModelPricingIssue =
  | { code: 'time-window-conflict'; entryIndexes: readonly [number, number]; error: Error }
  | { code: 'empty-catalog'; error: Error }
  | { code: 'empty-rates'; entryIndex: number; error: Error }
  | { code: 'invalid-rate'; entryIndex: number; metric: BillingMetric; error: Error }
  | { code: 'invalid-selector'; entryIndex: number; error: Error }
  | { code: 'base-count'; entryIndexes: readonly number[]; error: Error }
  | {
    code: 'rate-metrics';
    entryIndex: number;
    baseIndex: number;
    missingMetrics: readonly BillingMetric[];
    addedMetrics: readonly BillingMetric[];
    error: Error;
  }
  | { code: 'duplicate-selector'; selector: PricingSelector; selectorKey: string; entryIndexes: readonly number[]; error: Error }
  | {
    code: 'threshold-operator-conflict';
    axisId: string;
    value: number;
    entryIndexes: readonly [number, number];
    error: Error;
  };

export const validatePriceVector = (pricing: PriceVector, path = 'price vector'): void => {
  const metrics = BILLING_METRICS.filter(metric => pricing[metric] !== undefined);
  if (metrics.length === 0) throw new Error(`${path} must contain at least one rate`);
  for (const metric of metrics) {
    const rate = pricing[metric]!;
    const canonical = parseNonNegativeDecimalString(rate, `${path}.${metric}`);
    if (canonical !== rate) throw new Error(`${path}.${metric} must be canonical: ${JSON.stringify(canonical)}`);
  }
};

const axisById = new Map<string, PricingAxis>(PRICING_AXES.map(axis => [axis.id, axis]));

const canonicalThreshold = (value: PricingCoordinateValue, path: string): PricingThresholdCoordinate => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be a threshold object`);
  const unknownKeys = Object.keys(value).filter(key => key !== 'operator' && key !== 'value');
  if (unknownKeys.length > 0) throw new RangeError(`${path} has unknown fields: ${unknownKeys.join(', ')}`);
  const { operator, value: threshold } = value as PricingThresholdCoordinate;
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
    } else if (axis.kind === 'time-window') {
      canonical[axisId] = canonicalPricingTimeWindow(value, `pricing selector ${axisId}`);
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

const thresholdScope = (selector: PricingSelector): PricingSelector =>
  Object.fromEntries(Object.entries(selector).filter(([axisId]) => axisById.get(axisId)!.kind !== 'threshold'));

const scopeMatches = (scope: PricingSelector, selector: PricingSelector): boolean =>
  Object.entries(scope).every(([axisId, coordinate]) => JSON.stringify(coordinate) === JSON.stringify(selector[axisId]));

const scopesOverlap = (a: PricingSelector, b: PricingSelector): boolean =>
  Object.entries(a).every(([axisId, coordinate]) => b[axisId] === undefined || JSON.stringify(coordinate) === JSON.stringify(b[axisId]));

const pricingMetrics = (rates: PriceVector): readonly BillingMetric[] =>
  BILLING_METRICS.filter(metric => rates[metric] !== undefined);

export const collectModelPricingIssues = (pricing: ModelPricing): readonly ModelPricingIssue[] => {
  const issues: ModelPricingIssue[] = [];
  if (pricing.entries.length === 0) {
    issues.push({ code: 'empty-catalog', error: new Error('model pricing must declare at least one entry') });
    return issues;
  }

  const selectors: (PricingSelector | undefined)[] = [];
  for (let entryIndex = 0; entryIndex < pricing.entries.length; entryIndex++) {
    const entry = pricing.entries[entryIndex]!;
    const metrics = pricingMetrics(entry.rates);
    if (metrics.length === 0) {
      issues.push({
        code: 'empty-rates',
        entryIndex,
        error: new Error(`model pricing entry ${entryIndex}.rates must contain at least one rate`),
      });
    }
    for (const metric of metrics) {
      const rate = entry.rates[metric]!;
      try {
        const canonical = parseNonNegativeDecimalString(rate, `model pricing entry ${entryIndex}.rates.${metric}`);
        if (canonical !== rate) throw new Error(`model pricing entry ${entryIndex}.rates.${metric} must be canonical: ${JSON.stringify(canonical)}`);
      } catch (cause) {
        issues.push({
          code: 'invalid-rate',
          entryIndex,
          metric,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    }
    try {
      const selector = canonicalizePricingSelector(entry.selector);
      if (typeof selector.serviceTier === 'string' && billableServiceTier(selector.serviceTier) === null) {
        throw new RangeError('pricing selector serviceTier must not denote Base; omit the coordinate instead');
      }
      selectors[entryIndex] = selector;
    } catch (cause) {
      issues.push({
        code: 'invalid-selector',
        entryIndex,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
  }

  const baseIndexes = selectors.flatMap((selector, index) =>
    selector !== undefined && Object.keys(selector).length === 0 ? [index] : []);
  if (baseIndexes.length !== 1) {
    issues.push({
      code: 'base-count',
      entryIndexes: baseIndexes,
      error: new Error('model pricing must declare exactly one base entry'),
    });
  }

  if (baseIndexes.length === 1) {
    const baseIndex = baseIndexes[0]!;
    const expectedMetrics = pricingMetrics(pricing.entries[baseIndex]!.rates);
    const expectedSet = new Set(expectedMetrics);
    for (let entryIndex = 0; entryIndex < pricing.entries.length; entryIndex++) {
      if (entryIndex === baseIndex) continue;
      const metrics = pricingMetrics(pricing.entries[entryIndex]!.rates);
      const metricSet = new Set(metrics);
      const missingMetrics = expectedMetrics.filter(metric => !metricSet.has(metric));
      const addedMetrics = metrics.filter(metric => !expectedSet.has(metric));
      if (missingMetrics.length > 0 || addedMetrics.length > 0) {
        issues.push({
          code: 'rate-metrics',
          entryIndex,
          baseIndex,
          missingMetrics,
          addedMetrics,
          error: new Error(`model pricing entry ${entryIndex}.rates must define the same metrics as the base entry (${expectedMetrics.join(', ')})`),
        });
      }
    }
  }

  const selectorIndexesByKey = new Map<string, number[]>();
  for (let entryIndex = 0; entryIndex < selectors.length; entryIndex++) {
    const selector = selectors[entryIndex];
    if (selector === undefined) continue;
    const key = JSON.stringify(selector);
    const indexes = selectorIndexesByKey.get(key) ?? [];
    indexes.push(entryIndex);
    selectorIndexesByKey.set(key, indexes);
  }
  for (const [selectorKey, entryIndexes] of selectorIndexesByKey) {
    if (entryIndexes.length < 2) continue;
    issues.push({
      code: 'duplicate-selector',
      selector: selectors[entryIndexes[0]!]!,
      selectorKey,
      entryIndexes,
      error: new Error(`duplicate pricing entry selector: ${selectorKey}`),
    });
  }

  const selectorKeys = new Set<string>();
  const thresholdOperatorsByScope = new Map<string, Map<string, Map<number, { operator: PricingThresholdOperator; entryIndex: number }>>>();
  const operatorsFor = (scopeKey: string, axisId: string): Map<number, { operator: PricingThresholdOperator; entryIndex: number }> => {
    const byAxis = thresholdOperatorsByScope.get(scopeKey) ?? new Map<string, Map<number, { operator: PricingThresholdOperator; entryIndex: number }>>();
    thresholdOperatorsByScope.set(scopeKey, byAxis);
    const operators = byAxis.get(axisId) ?? new Map<number, { operator: PricingThresholdOperator; entryIndex: number }>();
    byAxis.set(axisId, operators);
    return operators;
  };
  for (let entryIndex = 0; entryIndex < selectors.length; entryIndex++) {
    const selector = selectors[entryIndex];
    if (selector === undefined) continue;
    const key = JSON.stringify(selector);
    if (selectorKeys.has(key)) continue;
    selectorKeys.add(key);
    const scope = thresholdScope(selector);
    const scopeKey = JSON.stringify(scope);
    for (const [axisId, coordinate] of Object.entries(selector)) {
      if (typeof coordinate === 'string' || !('operator' in coordinate)) continue;
      const overlappingScopes = [...thresholdOperatorsByScope.keys()].filter(key => scopesOverlap(scope, JSON.parse(key) as PricingSelector));
      for (const overlappingScope of overlappingScopes) {
        const existing = thresholdOperatorsByScope.get(overlappingScope)?.get(axisId)?.get(coordinate.value);
        if (existing !== undefined && existing.operator !== coordinate.operator) {
          issues.push({
            code: 'threshold-operator-conflict',
            axisId,
            value: coordinate.value,
            entryIndexes: [existing.entryIndex, entryIndex],
            error: new Error(`conflicting pricing threshold operators for ${axisId} at ${coordinate.value} in overlapping pricing scopes`),
          });
        }
      }
      operatorsFor(scopeKey, axisId).set(coordinate.value, { operator: coordinate.operator, entryIndex });
    }
  }
  for (let i = 0; i < selectors.length; i++) {
    const a = selectors[i];
    const aw = a?.timeWindow as PricingTimeWindowCoordinate | undefined;
    if (!a || !aw) continue;
    for (let j = 0; j < i; j++) {
      const b = selectors[j];
      const bw = b?.timeWindow as PricingTimeWindowCoordinate | undefined;
      if (!b || !bw) continue;
      const differentZone = aw.timeZone !== bw.timeZone;
      const overlapping = JSON.stringify(aw) !== JSON.stringify(bw)
        && scopesOverlap(selectorCoordinatesByKind(a, 'equality'), selectorCoordinatesByKind(b, 'equality'))
        && pricingTimeWindowsOverlap(aw, bw);
      if (differentZone || overlapping) issues.push({
        code: 'time-window-conflict', entryIndexes: [j, i],
        error: new Error(differentZone ? 'pricing time windows must use the same time zone' : 'pricing time windows must not overlap in compatible service tiers'),
      });
    }
  }
  return issues;
};

export const validateModelPricing = (pricing: ModelPricing): void => {
  const issue = collectModelPricingIssues(pricing)[0];
  if (issue) throw issue.error;
};

interface CompiledModelPricing {
  ratesBySelectorKey: ReadonlyMap<string, PriceVector>;
  timeWindows: readonly { scope: PricingSelector; coordinate: PricingTimeWindowCoordinate; matches: (timestamp: number) => boolean }[];
  thresholdBandsByAxisAndScope: ReadonlyMap<string, ReadonlyMap<string, readonly PricingThresholdCoordinate[]>>;
}

const compiledPricing = new WeakMap<ModelPricing, CompiledModelPricing>();

// Pricing objects are immutable after provider/config construction. Compilation
// validates and canonicalizes once per stable object identity.
const compileModelPricing = (pricing: ModelPricing): CompiledModelPricing => {
  const existing = compiledPricing.get(pricing);
  if (existing) return existing;
  validateModelPricing(pricing);
  const ratesBySelectorKey = new Map<string, PriceVector>();
  const timeWindows: CompiledModelPricing['timeWindows'][number][] = [];
  const seenWindows = new Set<string>();
  const bandsByAxisAndScope = new Map<string, Map<string, Map<number, PricingThresholdCoordinate>>>();
  for (const entry of pricing.entries) {
    const selector = canonicalizePricingSelector(entry.selector);
    ratesBySelectorKey.set(JSON.stringify(selector), entry.rates);
    const coordinate = selector.timeWindow as PricingTimeWindowCoordinate | undefined;
    const windowKey = JSON.stringify([equalityScopeKey(selector), coordinate]);
    if (coordinate && !seenWindows.has(windowKey)) {
      seenWindows.add(windowKey);
      timeWindows.push({ scope: selectorCoordinatesByKind(selector, 'equality'), coordinate, matches: compilePricingTimeWindow(coordinate) });
    }
    for (const axis of PRICING_AXES) {
      if (axis.kind !== 'threshold') continue;
      const coordinate = selector[axis.id];
      if (typeof coordinate !== 'object' || !('operator' in coordinate)) continue;
      const scopeKey = JSON.stringify(thresholdScope(selector));
      const bandsByScope = bandsByAxisAndScope.get(axis.id) ?? new Map<string, Map<number, PricingThresholdCoordinate>>();
      bandsByAxisAndScope.set(axis.id, bandsByScope);
      const bands = bandsByScope.get(scopeKey) ?? new Map<number, PricingThresholdCoordinate>();
      bands.set(coordinate.value, coordinate);
      bandsByScope.set(scopeKey, bands);
    }
  }
  const thresholdBandsByAxisAndScope = new Map(
    [...bandsByAxisAndScope].map(([axisId, bandsByScope]) => [
      axisId,
      new Map([...bandsByScope].map(([scopeKey, bands]) =>
        [scopeKey, [...bands.values()].toSorted((a, b) => b.value - a.value)] as const)),
    ] as const),
  );
  const compiled = { ratesBySelectorKey, thresholdBandsByAxisAndScope, timeWindows };
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

export const perMillionTokenRates = (publishedRates: PriceVector): PriceVector => Object.fromEntries(
  Object.entries(publishedRates).map(([metric, price]) => [metric, divideDecimalString(price, '1000000')]),
) as PriceVector;

export const tokenPricingEntry = (publishedRates: PriceVector, selector?: PricingSelector): PricingEntry =>
  pricingEntry(perMillionTokenRates(publishedRates), selector);

export const tokenBasePricing = (publishedRates: PriceVector): ModelPricing => basePricing(perMillionTokenRates(publishedRates));

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
  if (compiled && compiled.timeWindows.length > 0) {
    const timestamp = facts.requestStartedAt;
    if (timestamp === undefined || !Number.isFinite(new Date(timestamp).getTime())) throw new RangeError('time-window pricing requires a valid requestStartedAt timestamp');
    const window = compiled.timeWindows.find(window => scopeMatches(window.scope, selector) && window.matches(timestamp));
    if (window) selector.timeWindow = window.coordinate;
  }
  for (const axis of PRICING_AXES) {
    if (axis.kind !== 'threshold') continue;
    const fact = facts[axis.fact];
    if (fact === undefined) continue;
    const bandsByScope = compiled?.thresholdBandsByAxisAndScope.get(axis.id);
    const bands = [...(bandsByScope ?? [])]
      .filter(([scopeKey]) => scopeMatches(JSON.parse(scopeKey) as PricingSelector, selector))
      .flatMap(([, bands]) => bands)
      .toSorted((a, b) => b.value - a.value);
    const band = bands.find(coordinate => thresholdMatches(coordinate, fact));
    if (band) selector[axis.id] = band;
  }
  const canonicalSelector = canonicalizePricingSelector(selector);
  const exactRates = compiled?.ratesBySelectorKey.get(JSON.stringify(canonicalSelector));
  if (exactRates !== undefined) return { selector: canonicalSelector, rates: exactRates };
  const baseRates = compiled?.ratesBySelectorKey.get('{}');
  return baseRates !== undefined
    ? { selector: {}, rates: baseRates }
    : { selector: canonicalSelector, rates: null };
};
