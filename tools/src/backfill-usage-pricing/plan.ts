import { createHash } from 'node:crypto';

import type { DatabaseIdentity, DatabaseValue, SqlStatement, ToolDatabase } from './database.ts';
import { inputError, safetyError, ToolError, verificationError } from './errors.ts';
import { ratesForStoredSelector, resolveUsagePricing, type PricingResolution, type StoredUpstream } from './pricing.ts';
import {
  BILLING_METRICS,
  multiplyDecimalStrings,
  parseBillingMetric,
  parseNonNegativeDecimalString,
  parsePricingSelectorKey,
  type BillingMetric,
  type DecimalString,
} from '@floway-dev/protocols/common';

export const PLAN_SCHEMA_VERSION = 1;

export type WriteMode = 'fill' | 'overwrite';

export interface BackfillIntent {
  upstream: string;
  model: string;
  modelKey: string;
  startHour: string;
  endHour: string;
  timezone: string;
  metrics: BillingMetric[];
  mode: WriteMode;
}

export interface PriceState {
  pricingSelector: string;
  metric: BillingMetric;
  unitPrice: DecimalString | null;
  rows: number;
  representativeQuantity: DecimalString;
}

export interface BackfillOperation {
  pricingSelector: string;
  metric: BillingMetric;
  proposedUnitPrice: DecimalString;
  expectedRows: number;
  representative: {
    quantity: DecimalString;
    realizedCost: DecimalString;
  };
}

export interface SkippedRate {
  pricingSelector: string;
  metric: BillingMetric;
  nullRows: number;
  reason: 'metric-unpriced' | 'model-unpriced';
}

export interface BackfillPlan {
  schemaVersion: 1;
  kind: 'usage-pricing-backfill-plan';
  planId: string;
  createdAt: string;
  database: DatabaseIdentity;
  intent: BackfillIntent;
  pricing: {
    status: 'priced' | 'unpriced' | 'unavailable';
    source?: string;
    digest?: string;
    reason?: string;
  };
  evidence: {
    pricedSiblingExists: boolean;
  };
  snapshot: PriceState[];
  operations: BackfillOperation[];
  skipped: SkippedRate[];
  blockers: Array<{ code: string; message: string }>;
  summary: {
    selectedRows: number;
    rowsToUpdate: number;
    remainingNullRows: number;
  };
}

interface PlanGuards {
  upstreamConfigJson: string;
  upstreamModelsCacheJson: string | null;
  guardModelsCache: boolean;
  pricedSiblingExists: boolean;
}

export interface BuiltPlan {
  plan: BackfillPlan;
  guards: PlanGuards;
}

interface UpstreamRow {
  id: string;
  provider: string;
  enabled: number;
  config_json: string;
  models_cache_json: string | null;
}

interface PriceStateRow {
  pricing_selector: string;
  metric: string;
  unit_price: string | null;
  row_count: number;
  representative_quantity: string;
}

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).toSorted().map(key => [
      key,
      canonicalValue((value as Record<string, unknown>)[key]),
    ]));
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const sha256 = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

const planPayload = (plan: Omit<BackfillPlan, 'planId'> | BackfillPlan): unknown => {
  const { planId: _planId, ...payload } = plan as BackfillPlan;
  return payload;
};

const planIdFor = (plan: Omit<BackfillPlan, 'planId'> | BackfillPlan): string =>
  `sha256:${sha256(planPayload(plan))}`;

const canonicalHour = (value: string, label: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value)) {
    throw inputError('invalid-hour', `${label} must use the UTC hour format YYYY-MM-DDTHH`);
  }
  const date = new Date(`${value}:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 13) !== value) {
    throw inputError('invalid-hour', `${label} is not a valid UTC hour: ${value}`);
  }
  return value;
};

export const normalizeIntent = (intent: BackfillIntent): BackfillIntent => {
  if (intent.upstream.length === 0) throw inputError('missing-upstream', 'upstream must not be empty');
  if (intent.model.length === 0) throw inputError('missing-model', 'model must not be empty');
  if (intent.modelKey.length === 0) throw inputError('missing-model-key', 'model-key must not be empty');
  const startHour = canonicalHour(intent.startHour, 'start-hour');
  const endHour = canonicalHour(intent.endHour, 'end-hour');
  if (startHour >= endHour) throw inputError('invalid-range', 'start-hour must be before end-hour');
  try {
    new Intl.DateTimeFormat('en', { timeZone: intent.timezone }).format();
  } catch {
    throw inputError('invalid-timezone', `timezone is not a valid IANA timezone: ${intent.timezone}`);
  }
  if (intent.metrics.length === 0) throw inputError('missing-metrics', 'At least one metric is required');
  const selected = new Set(intent.metrics.map(metric => parseBillingMetric(metric)));
  const metrics = BILLING_METRICS.filter(metric => selected.has(metric));
  if (intent.mode !== 'fill' && intent.mode !== 'overwrite') throw inputError('invalid-mode', 'mode must be fill or overwrite');
  return { ...intent, startHour, endHour, metrics };
};

export const validateUsageSchema = async (database: ToolDatabase): Promise<void> => {
  const columns = await database.query<{ name: string; type: string }>({ sql: 'PRAGMA table_info(usage)' });
  const actual = new Map(columns.rows.map(row => [row.name, row.type.toUpperCase()]));
  const expected = ['key_id', 'model', 'upstream', 'model_key', 'hour', 'pricing_selector', 'metric', 'quantity', 'unit_price'];
  for (const column of expected) {
    if (actual.get(column) !== 'TEXT') throw new ToolError('usage-schema', `usage.${column} must be a TEXT column`, 1);
  }
  const index = await database.query<{ sql: string | null }>({
    sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_metric_identity'",
  });
  if (index.rows.length !== 1 || typeof index.rows[0]?.sql !== 'string') {
    throw new ToolError('usage-schema', 'usage is missing idx_usage_metric_identity', 1);
  }
};

const loadUpstream = async (database: ToolDatabase, id: string): Promise<UpstreamRow> => {
  const result = await database.query<UpstreamRow>({
    sql: 'SELECT id, provider, enabled, config_json, models_cache_json FROM upstreams WHERE id = ?',
    params: [id],
  });
  if (result.rows.length !== 1) throw inputError('upstream-not-found', `No upstream has id ${id}`);
  const row = result.rows[0]!;
  if (typeof row.provider !== 'string' || typeof row.config_json !== 'string' || (row.models_cache_json !== null && typeof row.models_cache_json !== 'string')) {
    throw new ToolError('upstream-row', `Stored upstream ${id} is malformed`, 1);
  }
  return row;
};

const stateQuery = (intent: BackfillIntent): SqlStatement => ({
  sql: `SELECT pricing_selector, metric, unit_price, COUNT(*) AS row_count,
               MIN(quantity) AS representative_quantity
        FROM usage
        WHERE model = ? AND COALESCE(upstream, '') = ? AND model_key = ?
          AND hour >= ? AND hour < ?
          AND metric IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        GROUP BY pricing_selector, metric, unit_price
        ORDER BY pricing_selector, metric, unit_price`,
  params: [intent.model, intent.upstream, intent.modelKey, intent.startHour, intent.endHour, JSON.stringify(intent.metrics)],
});

const loadStates = async (database: ToolDatabase, intent: BackfillIntent): Promise<PriceState[]> => {
  const result = await database.query<PriceStateRow>(stateQuery(intent));
  return result.rows.map(row => {
    parsePricingSelectorKey(row.pricing_selector);
    const metric = parseBillingMetric(row.metric, 'usage.metric');
    const unitPrice = row.unit_price === null ? null : parseNonNegativeDecimalString(row.unit_price, `usage ${metric} unit_price`);
    const representativeQuantity = parseNonNegativeDecimalString(row.representative_quantity, `usage ${metric} quantity`);
    if (!Number.isSafeInteger(row.row_count) || row.row_count <= 0) throw new ToolError('usage-row-count', 'D1 returned an invalid usage row count', 1);
    return {
      pricingSelector: row.pricing_selector,
      metric,
      unitPrice,
      rows: row.row_count,
      representativeQuantity,
    };
  });
};

const loadPricedSiblingExists = async (database: ToolDatabase, intent: BackfillIntent): Promise<boolean> => {
  const result = await database.query<{ present: number }>({
    sql: `SELECT EXISTS (
            SELECT 1 FROM usage
            WHERE COALESCE(upstream, '') = ? AND model_key = ? AND unit_price IS NOT NULL
          ) AS present`,
    params: [intent.upstream, intent.modelKey],
  });
  if (result.rows.length !== 1 || (result.rows[0]?.present !== 0 && result.rows[0]?.present !== 1)) {
    throw new ToolError('priced-sibling-query', 'Database returned an invalid priced-sibling result', 1);
  }
  return result.rows[0].present === 1;
};

const pricingArtifact = (resolution: PricingResolution): BackfillPlan['pricing'] => {
  if (resolution.status === 'unavailable') return { status: 'unavailable', reason: resolution.reason };
  if (resolution.status === 'unpriced') return { status: 'unpriced', source: resolution.source };
  return { status: 'priced', source: resolution.source, digest: `sha256:${sha256(resolution.pricing)}` };
};

const createPlan = (
  database: DatabaseIdentity,
  intent: BackfillIntent,
  upstream: StoredUpstream,
  states: PriceState[],
  pricedSiblingExists: boolean,
  resolution: PricingResolution,
  createdAt: string,
): BackfillPlan => {
  const operations: BackfillOperation[] = [];
  const skipped: SkippedRate[] = [];
  const blockers: BackfillPlan['blockers'] = [];

  if (resolution.status === 'unavailable') {
    blockers.push({ code: 'pricing-unavailable', message: resolution.reason });
  }

  const coordinates = new Map<string, PriceState[]>();
  for (const state of states) {
    const key = `${state.pricingSelector}\0${state.metric}`;
    coordinates.set(key, [...(coordinates.get(key) ?? []), state]);
  }

  for (const coordinateStates of coordinates.values()) {
    const { pricingSelector, metric } = coordinateStates[0]!;
    const nullRows = coordinateStates.filter(state => state.unitPrice === null).reduce((sum, state) => sum + state.rows, 0);
    if (resolution.status !== 'priced') {
      if (nullRows > 0 && resolution.status === 'unpriced') skipped.push({ pricingSelector, metric, nullRows, reason: 'model-unpriced' });
      continue;
    }
    const selected = ratesForStoredSelector(resolution.pricing, pricingSelector);
    const proposedUnitPrice = selected.rates?.[metric];
    if (proposedUnitPrice === undefined) {
      if (nullRows > 0) skipped.push({ pricingSelector, metric, nullRows, reason: 'metric-unpriced' });
      continue;
    }
    const eligible = coordinateStates.filter(state =>
      intent.mode === 'fill' ? state.unitPrice === null : state.unitPrice !== proposedUnitPrice);
    const expectedRows = eligible.reduce((sum, state) => sum + state.rows, 0);
    if (expectedRows === 0) continue;
    if (!selected.exact && pricingSelector !== '{}' && pricedSiblingExists) {
      blockers.push({
        code: 'historical-selector-drift',
        message: `Stored selector ${pricingSelector} has priced siblings but is absent from the current catalog`,
      });
      continue;
    }
    const representative = eligible[0]!;
    operations.push({
      pricingSelector,
      metric,
      proposedUnitPrice,
      expectedRows,
      representative: {
        quantity: representative.representativeQuantity,
        realizedCost: multiplyDecimalStrings(representative.representativeQuantity, proposedUnitPrice),
      },
    });
  }

  blockers.sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  const rowsToUpdate = operations.reduce((sum, operation) => sum + operation.expectedRows, 0);
  const operationKeys = new Set(operations.map(operation => `${operation.pricingSelector}\0${operation.metric}`));
  const remainingNullRows = states
    .filter(state => state.unitPrice === null)
    .reduce((sum, state) => sum + (operationKeys.has(`${state.pricingSelector}\0${state.metric}`) ? 0 : state.rows), 0);
  const draft: Omit<BackfillPlan, 'planId'> = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    kind: 'usage-pricing-backfill-plan',
    createdAt,
    database,
    intent,
    pricing: pricingArtifact(resolution),
    evidence: { pricedSiblingExists },
    snapshot: states,
    operations,
    skipped,
    blockers,
    summary: {
      selectedRows: states.reduce((sum, state) => sum + state.rows, 0),
      rowsToUpdate,
      remainingNullRows,
    },
  };
  return { ...draft, planId: planIdFor(draft) };
};

export const buildPlan = async (
  database: ToolDatabase,
  rawIntent: BackfillIntent,
  options: { now?: number; createdAt?: string } = {},
): Promise<BuiltPlan> => {
  await validateUsageSchema(database);
  const intent = normalizeIntent(rawIntent);
  const upstreamRow = await loadUpstream(database, intent.upstream);
  const upstream: StoredUpstream = {
    id: upstreamRow.id,
    provider: upstreamRow.provider,
    configJson: upstreamRow.config_json,
    modelsCacheJson: upstreamRow.models_cache_json,
  };
  const [states, pricedSiblingExists] = await Promise.all([
    loadStates(database, intent),
    loadPricedSiblingExists(database, intent),
  ]);
  const resolution = resolveUsagePricing(upstream, { model: intent.model, modelKey: intent.modelKey }, options.now);
  const plan = createPlan(
    database.identity,
    intent,
    upstream,
    states,
    pricedSiblingExists,
    resolution,
    options.createdAt ?? new Date(options.now ?? Date.now()).toISOString(),
  );
  return {
    plan,
    guards: {
      upstreamConfigJson: upstream.configJson,
      upstreamModelsCacheJson: upstream.modelsCacheJson,
      guardModelsCache: resolution.status !== 'unavailable' && resolution.guardsModelsCache,
      pricedSiblingExists,
    },
  };
};

const valuesClause = (rows: readonly (readonly DatabaseValue[])[]): { sql: string; params: DatabaseValue[] } => ({
  sql: rows.map(row => `(${row.map(() => '?').join(', ')})`).join(', '),
  params: rows.flatMap(row => [...row]),
});

const applyStatement = (plan: BackfillPlan, guards: PlanGuards): SqlStatement => {
  const rates = valuesClause(plan.operations.map(operation =>
    [operation.pricingSelector, operation.metric, operation.proposedUnitPrice] as const));
  const expected = valuesClause(plan.snapshot.map(state =>
    [state.pricingSelector, state.metric, state.unitPrice, state.rows] as const));
  const scope = [
    plan.intent.model,
    plan.intent.upstream,
    plan.intent.modelKey,
    plan.intent.startHour,
    plan.intent.endHour,
    JSON.stringify(plan.intent.metrics),
  ] as const;
  return {
    sql: `WITH
      rates(pricing_selector, metric, rate) AS (VALUES ${rates.sql}),
      expected(pricing_selector, metric, unit_price, row_count) AS (VALUES ${expected.sql}),
      sibling_evidence AS MATERIALIZED (
        SELECT EXISTS (
          SELECT 1 FROM usage
          WHERE COALESCE(upstream, '') = ? AND model_key = ? AND unit_price IS NOT NULL
        ) AS present
      ),
      observed AS MATERIALIZED (
        SELECT pricing_selector, metric, unit_price, COUNT(*) AS row_count
        FROM usage
        WHERE model = ? AND COALESCE(upstream, '') = ? AND model_key = ?
          AND hour >= ? AND hour < ?
          AND metric IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        GROUP BY pricing_selector, metric, unit_price
      ),
      drift AS MATERIALIZED (
        SELECT 1 FROM expected AS e
        WHERE NOT EXISTS (
          SELECT 1 FROM observed AS o
          WHERE o.pricing_selector = e.pricing_selector AND o.metric = e.metric
            AND o.unit_price IS e.unit_price AND o.row_count = e.row_count
        )
        UNION ALL
        SELECT 1 FROM observed AS o
        WHERE NOT EXISTS (
          SELECT 1 FROM expected AS e
          WHERE e.pricing_selector = o.pricing_selector AND e.metric = o.metric
            AND e.unit_price IS o.unit_price AND e.row_count = o.row_count
        )
      )
      UPDATE usage AS u
      SET unit_price = (
        SELECT r.rate FROM rates AS r
        WHERE r.pricing_selector = u.pricing_selector AND r.metric = u.metric
      )
      WHERE u.model = ? AND COALESCE(u.upstream, '') = ? AND u.model_key = ?
        AND u.hour >= ? AND u.hour < ?
        AND u.metric IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND EXISTS (
          SELECT 1 FROM rates AS r
          WHERE r.pricing_selector = u.pricing_selector AND r.metric = u.metric
        )
        AND ${plan.intent.mode === 'fill' ? 'u.unit_price IS NULL' : `u.unit_price IS NOT (
          SELECT r.rate FROM rates AS r
          WHERE r.pricing_selector = u.pricing_selector AND r.metric = u.metric
        )`}
        AND NOT EXISTS (SELECT 1 FROM drift)
        AND EXISTS (
          SELECT 1 FROM upstreams
          WHERE id = ? AND config_json = ?
            AND (? = 0 OR models_cache_json IS ?)
        )
        AND (SELECT present FROM sibling_evidence) = ?`,
    params: [
      ...rates.params,
      ...expected.params,
      plan.intent.upstream,
      plan.intent.modelKey,
      ...scope,
      ...scope,
      plan.intent.upstream,
      guards.upstreamConfigJson,
      guards.guardModelsCache ? 1 : 0,
      // Only a guarded plan carries the catalog into the statement. The column
      // is 73 KB on a live Copilot upstream and doubles under hex encoding, and
      // every provider except a cache-priced custom one short-circuits the
      // comparison on the flag above — so inlining it unguarded pushed the
      // statement past what `--command` can carry and failed a 6-row backfill
      // with SQLITE_TOOBIG before any row was written.
      guards.guardModelsCache ? guards.upstreamModelsCacheJson : null,
      guards.pricedSiblingExists ? 1 : 0,
    ],
  };
};

const ensurePlan = (value: unknown): BackfillPlan => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw inputError('invalid-plan', 'Plan must be a JSON object');
  const plan = value as BackfillPlan;
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.kind !== 'usage-pricing-backfill-plan' || typeof plan.planId !== 'string') {
    throw inputError('invalid-plan', 'Plan schema is unsupported');
  }
  if (typeof plan.createdAt !== 'string' || Number.isNaN(Date.parse(plan.createdAt)) || new Date(plan.createdAt).toISOString() !== plan.createdAt) {
    throw inputError('invalid-plan', 'Plan createdAt must be a canonical ISO timestamp');
  }
  normalizeIntent(plan.intent);
  if (plan.planId !== planIdFor(plan)) throw safetyError('plan-tampered', 'Plan ID does not match its contents');
  return plan;
};

export const parsePlan = (source: string): BackfillPlan => {
  try {
    return ensurePlan(JSON.parse(source));
  } catch (cause) {
    if (cause instanceof ToolError) throw cause;
    throw inputError('invalid-plan-json', 'Plan is not valid JSON');
  }
};

export interface ApplyResult {
  schemaVersion: 1;
  kind: 'usage-pricing-backfill-result';
  planId: string;
  database: DatabaseIdentity;
  rowsUpdated: number;
  operations: Array<BackfillOperation & { remainingNullRows: number }>;
  summary: {
    remainingNullRows: number;
    remainingNullRowsByMetric: Partial<Record<BillingMetric, number>>;
  };
}

const finalStateHistogram = (plan: BackfillPlan): Array<Pick<PriceState, 'pricingSelector' | 'metric' | 'unitPrice' | 'rows'>> => {
  const operations = new Map(plan.operations.map(operation => [`${operation.pricingSelector}\0${operation.metric}`, operation]));
  const aggregated = new Map<string, Pick<PriceState, 'pricingSelector' | 'metric' | 'unitPrice' | 'rows'>>();
  for (const state of plan.snapshot) {
    const operation = operations.get(`${state.pricingSelector}\0${state.metric}`);
    const unitPrice = operation === undefined || (plan.intent.mode === 'fill' && state.unitPrice !== null)
      ? state.unitPrice
      : operation.proposedUnitPrice;
    const key = `${state.pricingSelector}\0${state.metric}\0${unitPrice ?? '\0'}`;
    const existing = aggregated.get(key);
    if (existing) existing.rows += state.rows;
    else aggregated.set(key, { pricingSelector: state.pricingSelector, metric: state.metric, unitPrice, rows: state.rows });
  }
  return [...aggregated.values()].toSorted((left, right) =>
    left.pricingSelector.localeCompare(right.pricingSelector) ||
    left.metric.localeCompare(right.metric) ||
    (left.unitPrice ?? '').localeCompare(right.unitPrice ?? ''));
};

const actualStateHistogram = (states: readonly PriceState[]): ReturnType<typeof finalStateHistogram> =>
  states
    .map(({ pricingSelector, metric, unitPrice, rows }) => ({ pricingSelector, metric, unitPrice, rows }))
    .toSorted((left, right) =>
      left.pricingSelector.localeCompare(right.pricingSelector) ||
      left.metric.localeCompare(right.metric) ||
      (left.unitPrice ?? '').localeCompare(right.unitPrice ?? ''));

const remainingNullSummary = (states: readonly PriceState[]): ApplyResult['summary'] => {
  const remainingNullRowsByMetric: Partial<Record<BillingMetric, number>> = {};
  let remainingNullRows = 0;
  for (const state of states) {
    if (state.unitPrice !== null) continue;
    remainingNullRows += state.rows;
    remainingNullRowsByMetric[state.metric] = (remainingNullRowsByMetric[state.metric] ?? 0) + state.rows;
  }
  return { remainingNullRows, remainingNullRowsByMetric };
};

export const applyPlan = async (database: ToolDatabase, savedPlan: BackfillPlan): Promise<ApplyResult> => {
  if (canonicalJson(database.identity) !== canonicalJson(savedPlan.database)) {
    throw safetyError('database-mismatch', 'The opened database does not match the plan target');
  }
  const rebuilt = await buildPlan(database, savedPlan.intent, { createdAt: savedPlan.createdAt });
  if (rebuilt.plan.planId !== savedPlan.planId) throw safetyError('stale-plan', 'Database rows or pricing changed after the plan was created');
  if (savedPlan.blockers.length > 0) throw safetyError('blocked-plan', 'Plan contains safety blockers');
  if (savedPlan.operations.length === 0) {
    return {
      schemaVersion: 1,
      kind: 'usage-pricing-backfill-result',
      planId: savedPlan.planId,
      database: database.identity,
      rowsUpdated: 0,
      operations: [],
      summary: remainingNullSummary(savedPlan.snapshot),
    };
  }

  const write = await database.execute(applyStatement(savedPlan, rebuilt.guards));
  if (write.changes !== null && write.changes !== savedPlan.summary.rowsToUpdate) {
    if (write.changes === 0) throw safetyError('apply-drift', 'The guarded update observed concurrent database drift and wrote no rows');
    throw verificationError('apply-count', `Expected ${savedPlan.summary.rowsToUpdate} updated rows, received ${write.changes}`);
  }

  const states = await loadStates(database, savedPlan.intent);
  if (canonicalJson(actualStateHistogram(states)) !== canonicalJson(finalStateHistogram(savedPlan))) {
    throw verificationError('post-write-state', 'Post-write usage price state does not match the planned result');
  }
  const operations = savedPlan.operations.map(operation => {
    const matching = states.filter(state => state.pricingSelector === operation.pricingSelector && state.metric === operation.metric);
    const remainingNullRows = matching.filter(state => state.unitPrice === null).reduce((sum, state) => sum + state.rows, 0);
    const wrongPriceRows = savedPlan.intent.mode === 'overwrite'
      ? matching.filter(state => state.unitPrice !== operation.proposedUnitPrice).reduce((sum, state) => sum + state.rows, 0)
      : 0;
    if (remainingNullRows > 0 || wrongPriceRows > 0) {
      throw verificationError('post-write-verification', `Post-write verification failed for ${operation.pricingSelector}/${operation.metric}`);
    }
    return { ...operation, remainingNullRows };
  });
  return {
    schemaVersion: 1,
    kind: 'usage-pricing-backfill-result',
    planId: savedPlan.planId,
    database: database.identity,
    rowsUpdated: savedPlan.summary.rowsToUpdate,
    operations,
    summary: remainingNullSummary(states),
  };
};

export interface InspectionResult {
  schemaVersion: 1;
  kind: 'usage-pricing-inspection';
  database: DatabaseIdentity;
  enabledUpstreams: Array<{ id: string; provider: string; name: string }>;
  nullPriceSlices: Array<{
    upstream: string | null;
    model: string;
    modelKey: string;
    pricingSelector: string;
    metric: BillingMetric;
    rows: number;
    firstHour: string;
    lastHour: string;
  }>;
}

export const inspectDatabase = async (database: ToolDatabase): Promise<InspectionResult> => {
  await validateUsageSchema(database);
  const [upstreams, slices] = await Promise.all([
    database.query<{ id: string; provider: string; name: string }>({
      sql: 'SELECT id, provider, name FROM upstreams WHERE enabled != 0 ORDER BY sort_order, created_at',
    }),
    database.query<{
      upstream: string | null;
      model: string;
      model_key: string;
      pricing_selector: string;
      metric: string;
      row_count: number;
      first_hour: string;
      last_hour: string;
    }>({
      sql: `SELECT upstream, model, model_key, pricing_selector, metric,
                   COUNT(*) AS row_count, MIN(hour) AS first_hour, MAX(hour) AS last_hour
            FROM usage
            WHERE unit_price IS NULL
            GROUP BY upstream, model, model_key, pricing_selector, metric
            ORDER BY upstream, model, model_key, pricing_selector, metric`,
    }),
  ]);
  return {
    schemaVersion: 1,
    kind: 'usage-pricing-inspection',
    database: database.identity,
    enabledUpstreams: upstreams.rows,
    nullPriceSlices: slices.rows.map(row => {
      parsePricingSelectorKey(row.pricing_selector);
      return {
        upstream: row.upstream,
        model: row.model,
        modelKey: row.model_key,
        pricingSelector: row.pricing_selector,
        metric: parseBillingMetric(row.metric),
        rows: row.row_count,
        firstHour: row.first_hour,
        lastHour: row.last_hour,
      };
    }),
  };
};
