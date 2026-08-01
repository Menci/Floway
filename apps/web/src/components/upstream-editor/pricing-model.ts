import {
  BILLING_METRICS,
  PRICING_AXES,
  collectModelPricingIssues,
  divideDecimalString,
  multiplyDecimalStrings,
  parseNonNegativeDecimalString,
  type BillingMetric,
  type DecimalString,
  type ModelKind,
  type ModelPricing,
  type ModelPricingIssue,
  type PricingCoordinateValue,
  type PricingSelector,
  type PricingThresholdOperator,
} from '@floway-dev/protocols/common';

export interface PricingField {
  readonly metric: BillingMetric;
  readonly displayUnit: string;
  readonly displayScale: DecimalString;
}

// Rates are stored per base unit but authored per display unit, so each field
// carries the scale between the two.
const tokenPricingField = (metric: BillingMetric): PricingField => ({ metric, displayUnit: 'MTok', displayScale: '1000000' });
const tokenPricingFields = (...metrics: BillingMetric[]): PricingField[] => metrics.map(tokenPricingField);

const pricingField = (metric: BillingMetric): PricingField => {
  if (metric === 'input_audio_seconds') return { metric, displayUnit: 'Second', displayScale: '1' };
  if (metric === 'rerank_searches') return { metric, displayUnit: '1K searches', displayScale: '1000' };
  return tokenPricingField(metric);
};

const PRICING_FIELD_BY_METRIC = Object.fromEntries(
  BILLING_METRICS.map(metric => [metric, pricingField(metric)]),
) as Record<BillingMetric, PricingField>;

export const PRICING_FIELDS_BY_KIND: Record<ModelKind, readonly PricingField[]> = {
  chat: tokenPricingFields('input_tokens', 'input_cache_read_tokens', 'input_cache_write_tokens', 'input_cache_write_1h_tokens', 'output_tokens'),
  embedding: tokenPricingFields('input_tokens'),
  image: tokenPricingFields('input_tokens', 'input_image_tokens', 'output_tokens', 'output_image_tokens'),
  transcription: [tokenPricingField('input_tokens'), tokenPricingField('input_audio_tokens'), PRICING_FIELD_BY_METRIC.input_audio_seconds, tokenPricingField('output_tokens')],
  rerank: [tokenPricingField('input_tokens'), PRICING_FIELD_BY_METRIC.rerank_searches],
};

export interface PricingThresholdDraft {
  operator: PricingThresholdOperator;
  value?: number;
}

export interface PricingEntryDraft {
  id: number;
  selector: Record<string, string | PricingThresholdDraft | undefined>;
  rates: ModelPricing['entries'][number]['rates'];
}

let draftIdSequence = 0;
export const nextPricingDraftId = (): number => ++draftIdSequence;

export const pricingEntryDraftsFor = (value: ModelPricing | undefined): PricingEntryDraft[] =>
  (value?.entries ?? []).map(entry => ({
    id: nextPricingDraftId(),
    selector: { ...(entry.selector ?? {}) },
    rates: { ...entry.rates },
  }));

const compactSelector = (draft: PricingEntryDraft): PricingSelector => {
  const selector: Record<string, PricingCoordinateValue> = {};
  for (const [axisId, coordinate] of Object.entries(draft.selector)) {
    if (typeof coordinate === 'string') selector[axisId] = coordinate;
    else if (coordinate?.value !== undefined) selector[axisId] = { operator: coordinate.operator, value: coordinate.value };
  }
  return selector;
};

// The base entry is the one that names no coordinate. Asked of the compacted
// selector rather than of its canonical key, because a draft mid-edit can hold
// a threshold the canonicalizer rejects, and "does not canonicalize" is not an
// answer to "is this the base entry" -- `collectDraftIssues` is where an
// operator is told the selector is invalid.
export const isBaseEntry = (draft: PricingEntryDraft): boolean =>
  Object.keys(compactSelector(draft)).length === 0;

export const baseEntryOf = (drafts: readonly PricingEntryDraft[]): PricingEntryDraft | undefined =>
  drafts.find(isBaseEntry);

// The declared field set for the kind, plus any metric an entry actually
// prices — an upstream may bill on something this kind does not list, and
// hiding it would silently drop the rate on the next write.
export const visiblePricingFields = (drafts: readonly PricingEntryDraft[], kind: ModelKind): readonly PricingField[] => {
  const fields = new Map(PRICING_FIELDS_BY_KIND[kind].map(field => [field.metric, field]));
  for (const metric of BILLING_METRICS) {
    if (drafts.some(draft => draft.rates[metric] !== undefined)) fields.set(metric, PRICING_FIELD_BY_METRIC[metric]);
  }
  return [...fields.values()];
};

export const pricingEntryCoordinateLabel = (draft: PricingEntryDraft): string => {
  const labels = PRICING_AXES.flatMap(axis => {
    const coordinate = draft.selector[axis.id];
    if (axis.kind === 'equality') return typeof coordinate === 'string' && coordinate !== '' ? [coordinate] : [];
    if (!coordinate || typeof coordinate !== 'object') return [];
    if (coordinate.value === undefined) return [];
    return [`${coordinate.operator === 'gte' ? '>=' : '>'} ${coordinate.value} tokens`];
  });
  return labels.length > 0 ? labels.join(', ') : 'Base';
};

// The metric name is translated; the unit is not, because it is a symbol the
// same metric changes between kinds — per MTok, per second, per 1K searches.
export const pricingFieldLabel = (name: string, { displayUnit }: PricingField): string =>
  `${name} ($/${displayUnit})`;

export const pricingFieldRate = (draft: PricingEntryDraft, { metric, displayScale }: PricingField): DecimalString | undefined => {
  const price = draft.rates[metric];
  return price === undefined ? undefined : multiplyDecimalStrings(price, displayScale);
};

export const collectDraftIssues = (
  drafts: readonly PricingEntryDraft[],
  pricing: ModelPricing | undefined,
): readonly ModelPricingIssue[] => {
  if (drafts.length > 0) {
    return collectModelPricingIssues({ entries: drafts.map(draft => ({ selector: compactSelector(draft), rates: draft.rates })) });
  }
  return pricing === undefined ? [] : collectModelPricingIssues(pricing);
};

export const pricingIsValid = (drafts: readonly PricingEntryDraft[], pricing: ModelPricing | undefined): boolean =>
  collectDraftIssues(drafts, pricing).length === 0;

export const pricingFromDrafts = (drafts: readonly PricingEntryDraft[]): ModelPricing | undefined => {
  if (drafts.length === 0) return undefined;
  return {
    entries: drafts.map(draft => {
      const selector = compactSelector(draft);
      return { ...(Object.keys(selector).length > 0 ? { selector } : {}), rates: { ...draft.rates } };
    }),
  };
};

export const thresholdCoordinate = (draft: PricingEntryDraft, axisId: string): PricingThresholdDraft | undefined => {
  const value = draft.selector[axisId];
  return value && typeof value === 'object' ? value : undefined;
};

export const withEqualityCoordinate = (draft: PricingEntryDraft, axisId: string, raw: string): PricingEntryDraft => {
  const value = raw.trim();
  return { ...draft, selector: { ...draft.selector, [axisId]: value || undefined } };
};

export const withThresholdCoordinate = (
  draft: PricingEntryDraft,
  axisId: string,
  patch: Partial<PricingThresholdDraft>,
): PricingEntryDraft => {
  const current = thresholdCoordinate(draft, axisId);
  const operator = patch.operator ?? current?.operator ?? 'gt';
  const value = 'value' in patch ? patch.value : current?.value;
  return { ...draft, selector: { ...draft.selector, [axisId]: { operator, ...(value !== undefined ? { value } : {}) } } };
};

export const withRate = (draft: PricingEntryDraft, field: PricingField, raw: string): PricingEntryDraft => {
  const displayPrice = raw.trim();
  const value = displayPrice === ''
    ? undefined
    : divideDecimalString(parseNonNegativeDecimalString(displayPrice, `pricing ${field.metric}`), field.displayScale);
  const rates = { ...draft.rates };
  if (value === undefined) delete rates[field.metric];
  else rates[field.metric] = value;
  return { ...draft, rates };
};
