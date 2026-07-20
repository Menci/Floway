import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { migrationSqlByFilename } from './test-sqlite.ts';
import { priceRequest, type ModelPricing, validateModelPricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const inputRates = (input: number, output?: number) => ({
  input,
  input_cache_read: input,
  input_cache_write: input,
  input_cache_write_1h: input,
  input_image: input,
  ...(output === undefined ? {} : { output, output_image: output }),
});

const tokenPricing = (entries: ModelPricing['entries']): ModelPricing => {
  const base = entries.find(entry => entry.selector === undefined);
  if (!base) throw new Error('tokenPricing requires a Base entry');
  return {
    units: Object.fromEntries(Object.keys(base.rates).map(dimension => [dimension, 'tokens_1m'])) as ModelPricing['units'],
    entries,
  };
};

test('model pricing migrations materialize legacy semantics with explicit units', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0054_model_pricing.sql') {
      const legacyKey = ['co', 'st'].join('');
      const configJson = JSON.stringify({
        models: [
          {
            upstreamModelId: 'base-and-overlay',
            [legacyKey]: { input: 1, output: 4, tiers: { priority: { input: 2 } } },
          },
          {
            upstreamModelId: 'cache-overrides',
            [legacyKey]: {
              input: 1,
              input_cache_read: 0.1,
              input_cache_write: 1.25,
              output: 4,
              tiers: { fast: { input: 2, input_cache_write: 3 } },
            },
          },
          {
            upstreamModelId: 'tier-adds-output',
            [legacyKey]: { input: 1, tiers: { priority: { output: 8 } } },
          },
          {
            upstreamModelId: 'tier-only',
            [legacyKey]: { tiers: { priority: { input: 2 } } },
          },
          {
            upstreamModelId: 'empty-tier',
            [legacyKey]: { input: 1, tiers: { priority: {} } },
          },
          {
            upstreamModelId: 'empty-rates',
            [legacyKey]: { tiers: { priority: {} } },
          },
          {
            upstreamModelId: 'write-and-output-only',
            [legacyKey]: { input_cache_write: 1.25, output: 4 },
          },
          {
            upstreamModelId: 'zero-input',
            [legacyKey]: { input: 0, tiers: { priority: { input: 2 } } },
          },
          {
            upstreamModelId: 'tier-order',
            [legacyKey]: { input: 1, tiers: { priority: { input: 2 }, flex: { input: 0.5 } } },
          },
          {
            upstreamModelId: 'base-equivalent-tiers',
            [legacyKey]: {
              input: 1,
              tiers: {
                default: { input: 2 },
                '\tDefault\n': { input: 3 },
                '\u00a0standard\u00a0': { output: 8 },
                '\u3000default\u3000': { input: 4 },
                '\t\n': { input: 5 },
              },
            },
          },
          {
            upstreamModelId: 'base-equivalent-tier-only',
            [legacyKey]: { tiers: { Standard: { input: 2 } } },
          },
          { upstreamModelId: 'unpriced', display_name: 'Unpriced' },
        ],
      });
      db.run(
        `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json)
         VALUES ('up_pricing', 'custom', 'Pricing migration', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z', ${sqlString(configJson)})`,
      );
    }
    db.run(sql);
  }

  const [configResult] = db.exec("SELECT config_json FROM upstreams WHERE id = 'up_pricing'");
  const config = JSON.parse(configResult!.values[0]![0] as string) as {
    models: { upstreamModelId: string; display_name?: string; pricing?: ModelPricing }[];
  };
  assertEquals(config, {
    models: [
      {
        upstreamModelId: 'base-and-overlay',
        pricing: tokenPricing([
          { rates: inputRates(1, 4) },
          { selector: { serviceTier: 'priority' }, rates: inputRates(2, 4) },
        ]),
      },
      {
        upstreamModelId: 'cache-overrides',
        pricing: tokenPricing([
          {
            rates: {
              input: 1,
              input_cache_read: 0.1,
              input_cache_write: 1.25,
              input_cache_write_1h: 1.25,
              input_image: 1,
              output: 4,
              output_image: 4,
            },
          },
          {
            selector: { serviceTier: 'fast' },
            rates: {
              input: 2,
              input_cache_read: 0.1,
              input_cache_write: 3,
              input_cache_write_1h: 3,
              input_image: 2,
              output: 4,
              output_image: 4,
            },
          },
        ]),
      },
      {
        upstreamModelId: 'tier-adds-output',
        pricing: tokenPricing([
          { rates: inputRates(1, 0) },
          { selector: { serviceTier: 'priority' }, rates: inputRates(1, 8) },
        ]),
      },
      {
        upstreamModelId: 'tier-only',
        pricing: tokenPricing([
          { rates: inputRates(0) },
          { selector: { serviceTier: 'priority' }, rates: inputRates(2) },
        ]),
      },
      {
        upstreamModelId: 'empty-tier',
        pricing: tokenPricing([
          { rates: inputRates(1) },
          { selector: { serviceTier: 'priority' }, rates: inputRates(1) },
        ]),
      },
      { upstreamModelId: 'empty-rates' },
      {
        upstreamModelId: 'write-and-output-only',
        pricing: tokenPricing([{ rates: { input_cache_write: 1.25, input_cache_write_1h: 1.25, output: 4, output_image: 4 } }]),
      },
      {
        upstreamModelId: 'zero-input',
        pricing: tokenPricing([
          { rates: inputRates(0) },
          { selector: { serviceTier: 'priority' }, rates: inputRates(2) },
        ]),
      },
      {
        upstreamModelId: 'tier-order',
        pricing: tokenPricing([
          { rates: inputRates(1) },
          { selector: { serviceTier: 'priority' }, rates: inputRates(2) },
          { selector: { serviceTier: 'flex' }, rates: inputRates(0.5) },
        ]),
      },
      {
        upstreamModelId: 'base-equivalent-tiers',
        pricing: tokenPricing([{ rates: inputRates(1) }]),
      },
      { upstreamModelId: 'base-equivalent-tier-only' },
      { upstreamModelId: 'unpriced', display_name: 'Unpriced' },
    ],
  });

  for (const model of config.models) {
    if (!model.pricing) continue;
    validateModelPricing(model.pricing);
    const base = model.pricing.entries.find(entry => entry.selector === undefined)!.rates;
    assertEquals(priceRequest(model.pricing, { inputTokens: 1, serviceTier: 'unknown' }), { selector: {}, units: model.pricing.units, rates: base });
  }
});
