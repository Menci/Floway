import { expect, test } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { createBody, hasDraftModelInputs, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

const record = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { responses: {} },
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
  expect((updateBody(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((previewRecord(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
});

test('draft model inputs exclude metadata-only edits', () => {
  expect(hasDraftModelInputs({})).toBe(false);
  expect(hasDraftModelInputs({ config: true })).toBe(true);
  expect(hasDraftModelInputs({ state: true })).toBe(true);
  expect(hasDraftModelInputs({ proxyFallbackList: true })).toBe(true);
  expect(hasDraftModelInputs({ name: true })).toBe(false);
});
