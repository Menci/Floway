import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { migrationSqlByFilename } from './test-sqlite.ts';
import { divideDecimalString, priceRequest, type ModelPricing, validateModelPricing } from '@floway-dev/protocols/common';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const inputRates = (input: number, output?: number) => ({
  input_tokens: divideDecimalString(String(input), '1000000'),
  input_cache_read_tokens: divideDecimalString(String(input), '1000000'),
  input_cache_write_tokens: divideDecimalString(String(input), '1000000'),
  input_cache_write_1h_tokens: divideDecimalString(String(input), '1000000'),
  input_image_tokens: divideDecimalString(String(input), '1000000'),
  ...(output === undefined ? {} : {
    output_tokens: divideDecimalString(String(output), '1000000'),
    output_image_tokens: divideDecimalString(String(output), '1000000'),
  }),
});

const tokenPricing = (entries: ModelPricing['entries']): ModelPricing => ({ entries });

test('model pricing migrations materialize legacy semantics as base-unit metric rates', async () => {
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
            upstreamModelId: 'tiny-rate',
            [legacyKey]: { input: 1e-20 },
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
              input_tokens: '0.000001',
              input_cache_read_tokens: '0.0000001',
              input_cache_write_tokens: '0.00000125',
              input_cache_write_1h_tokens: '0.00000125',
              input_image_tokens: '0.000001',
              output_tokens: '0.000004',
              output_image_tokens: '0.000004',
            },
          },
          {
            selector: { serviceTier: 'fast' },
            rates: {
              input_tokens: '0.000002',
              input_cache_read_tokens: '0.0000001',
              input_cache_write_tokens: '0.000003',
              input_cache_write_1h_tokens: '0.000003',
              input_image_tokens: '0.000002',
              output_tokens: '0.000004',
              output_image_tokens: '0.000004',
            },
          },
        ]),
      },
      {
        upstreamModelId: 'tiny-rate',
        pricing: tokenPricing([{
          rates: {
            input_tokens: '0.00000000000000000000000001',
            input_cache_read_tokens: '0.00000000000000000000000001',
            input_cache_write_tokens: '0.00000000000000000000000001',
            input_cache_write_1h_tokens: '0.00000000000000000000000001',
            input_image_tokens: '0.00000000000000000000000001',
          },
        }]),
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
        pricing: tokenPricing([{ rates: { input_cache_write_tokens: '0.00000125', input_cache_write_1h_tokens: '0.00000125', output_tokens: '0.000004', output_image_tokens: '0.000004' } }]),
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
    assertEquals(priceRequest(model.pricing, { inputTokens: 1, serviceTier: 'unknown' }), { selector: {}, rates: base });
  }
});

test('model pricing migration preserves every digit in current numeric rate lexemes', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0062_usage_billing_metrics.sql') {
      const configJson = '{"models":[{"upstreamModelId":"precise-rate","pricing":{"entries":[{"rates":{"input":0.12345678901234566,"output":1e-20,"input_cache_read":9223372036854775807,"input_cache_write":1e-324}}]}}]}';
      db.run(
        `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json)
         VALUES ('up_precise_pricing', 'custom', 'Precise pricing', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z', ${sqlString(configJson)})`,
      );
      db.run(sql);
      break;
    }
    db.run(sql);
  }

  const row = db.exec("SELECT config_json FROM upstreams WHERE id = 'up_precise_pricing'")[0]!.values[0]![0] as string;
  assertEquals(JSON.parse(row).models[0].pricing.entries[0].rates, {
    input_tokens: '0.00000012345678901234566',
    output_tokens: '0.00000000000000000000000001',
    input_cache_read_tokens: '9223372036854.775807',
    input_cache_write_tokens: `0.${'0'.repeat(329)}1`,
  });
});

test('model pricing migration rejects malformed, negative, and non-finite legacy rates', async () => {
  for (const invalidRateJson of ['"not-a-price"', 'null', 'true', '-1', '1e999', '1e-400']) {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0062_usage_billing_metrics.sql') {
        const configJson = `{"models":[{"upstreamModelId":"invalid-rate","pricing":{"entries":[{"rates":{"input":${invalidRateJson}}]}}]}`;
        db.run(
          `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json)
           VALUES ('up_invalid_pricing', 'custom', 'Invalid pricing', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z', ${sqlString(configJson)})`,
        );
        assertThrows(() => db.run(sql), Error, 'malformed JSON');
        break;
      }
      db.run(sql);
    }
  }
});
