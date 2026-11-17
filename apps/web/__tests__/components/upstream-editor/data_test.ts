import { expect, test } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { canFetchModelCatalog, createBody, hasUnsavedDiscoveryInputs, manualModelsSupported, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

const record = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [
      { key: 'x-pass', value: null },
      { key: 'x-empty', value: '' },
      { key: 'x-route', value: 'fast' },
    ],
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models: [],
  },
  state: null,
}) as CustomRecord;

test('Custom editor values add one blank ingress row and never serialize it', () => {
  const values = valuesFromRecord(record);
  const config = values.config as CustomRecord['config'];
  expect(config.ingressHeadersRules).toEqual([
    { key: 'x-pass', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'fast' },
    { key: '', value: null },
  ]);

  config.ingressHeadersRules[0]!.key = ' X-PASS ';
  const expected = [
    { key: 'x-pass', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'fast' },
  ];
  expect((createBody(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((updateBody(record, values, 'full').config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((previewRecord(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
});

test('background usage refresh remains explicit through editor create, preview and update', () => {
  const values = valuesFromRecord(record);
  expect(values.usageRefreshIntervalMinutes).toBe(0);
  for (const interval of [1, 15, 0]) {
    values.usageRefreshIntervalMinutes = interval;
    expect(createBody(record, values).usage_refresh_interval_minutes).toBe(interval);
    expect(previewRecord(record, values).usage_refresh_interval_minutes).toBe(interval);
    expect(updateBody(record, values, 'full').usage_refresh_interval_minutes).toBe(interval);
    expect(hasUnsavedDiscoveryInputs({ usageRefreshIntervalMinutes: 5 })).toBe(false);
  }
});

test('Kimi Code uses its entered key for unsaved discovery and preserves connection settings on save', () => {
  const record = upstreamRecord('', { kind: 'kimi-code', config: { region: 'china', apiKey: '' }, state: null });
  const values = valuesFromRecord(record);
  expect(canFetchModelCatalog(record, values.config)).toBe(false);
  values.config = { region: 'overseas', apiKey: ' sk-kimi-fake-test-key ' };
  expect(canFetchModelCatalog(record, values.config)).toBe(true);
  expect(manualModelsSupported(record)).toBe(false);
  const expected = { region: 'overseas', apiKey: 'sk-kimi-fake-test-key' };
  expect(createBody(record, values).config).toEqual(expected);
  expect(previewRecord(record, values).config).toEqual(expected);
  expect(updateBody(record, values, 'full').config).toEqual(expected);
  expect(canFetchModelCatalog({ ...record, id: 'up_kimi' }, { region: 'china', apiKeySet: true })).toBe(true);
});
