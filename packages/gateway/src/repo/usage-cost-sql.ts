import type { SqlDatabase } from '@floway-dev/platform';
import { addDecimalStrings, decimalStringIsZero, multiplyDecimalStrings, parseNonNegativeDecimalString, type DecimalString } from '@floway-dev/protocols/common';

type CostTerm = { quantity: string; unitPrice: string | null; occurrences: number };

export const sumUsageCostTerms = (terms: readonly CostTerm[]): DecimalString | null => {
  let cost = '0';
  for (const { quantity: raw, unitPrice, occurrences } of terms) {
    if (!Number.isSafeInteger(occurrences) || occurrences <= 0) throw new RangeError('Invalid usage cost occurrence count');
    const quantity = parseNonNegativeDecimalString(raw, 'usage cost quantity');
    if (decimalStringIsZero(quantity)) continue;
    if (unitPrice === null) return null;
    const price = parseNonNegativeDecimalString(unitPrice, 'usage cost unit price');
    cost = addDecimalStrings(cost, multiplyDecimalStrings(multiplyDecimalStrings(quantity, price), String(occurrences)));
  }
  return cost;
};

export const querySqlUpstreamCost = async (db: SqlDatabase, upstreamId: string, start: string, end: string): Promise<DecimalString | null> => {
  // Read prices and missing metric buckets from one snapshot while usage is
  // still being recorded. A request bucket without metrics cannot price a quota.
  const { results } = await db.prepare(`
    SELECT quantity, unit_price AS unitPrice, COUNT(*) AS occurrences FROM usage
    WHERE upstream = ? AND hour >= ? AND hour < ?
    GROUP BY quantity, unit_price
    UNION ALL
    SELECT NULL, NULL, 1 WHERE EXISTS (
      SELECT 1 FROM usage_requests request
      WHERE request.upstream = ? AND request.hour >= ? AND request.hour < ? AND request.requests > 0
        AND NOT EXISTS (
          SELECT 1 FROM usage metric WHERE metric.key_id = request.key_id AND metric.model = request.model
            AND metric.upstream = request.upstream AND metric.model_key = request.model_key
            AND metric.hour = request.hour AND metric.pricing_selector = request.pricing_selector
        )
    )
  `).bind(upstreamId, start, end, upstreamId, start, end).all<CostTerm | { quantity: null }>();
  const terms = results.filter((term): term is CostTerm => term.quantity !== null);
  return terms.length === results.length ? sumUsageCostTerms(terms) : null;
};
