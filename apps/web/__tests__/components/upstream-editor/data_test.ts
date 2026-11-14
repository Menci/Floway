import { expect, test } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { createBody, hasUnsavedDiscoveryInputs, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

const record = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [
      { key: 'x-pass', value: null },
      { key: 'x-empty', value: '' },
      { key: 'x-route', value: 'fast' },
    ],
    modelsFetch: { enabled: false },
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

test('discovery input edits exclude metadata-only changes', () => {
  expect(hasUnsavedDiscoveryInputs({})).toBe(false);
  expect(hasUnsavedDiscoveryInputs({ config: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ state: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ proxyFallbackList: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ flagOverrides: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ name: true })).toBe(false);
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

// The key input carries the stored value, so what the operator leaves in it is
// what gets sent -- including an emptied field, which must reach the provider
// as a cleared credential rather than let the config merge restore the old one.
const withKey = (apiKey: string) => upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey,
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false },
    models: [],
  },
  state: null,
}) as CustomRecord;

test('an API key opens on the stored value', () => {
  expect((valuesFromRecord(withKey('sk-stored')).config as CustomRecord['config']).apiKey).toBe('sk-stored');
});

test('a replacement API key is sent', () => {
  const values = valuesFromRecord(withKey('sk-stored'));
  (values.config as CustomRecord['config']).apiKey = ' sk-replacement ';
  expect((updateBody(withKey('sk-stored'), values, 'full').config as CustomRecord['config']).apiKey).toBe('sk-replacement');
});

test('an emptied API key field is sent as an empty key', () => {
  const values = valuesFromRecord(withKey('sk-stored'));
  (values.config as CustomRecord['config']).apiKey = '';
  expect((updateBody(withKey('sk-stored'), values, 'full').config as CustomRecord['config']).apiKey).toBe('');
});

test('an absent API key opens as an empty field', () => {
  expect((valuesFromRecord(withKey('')).config as CustomRecord['config']).apiKey).toBe('');
});
