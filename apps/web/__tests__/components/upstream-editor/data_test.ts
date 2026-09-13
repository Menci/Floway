import { expect, test } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { createBody, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

test('Codex editor saves the device policy without including OAuth account fields in PATCH', () => {
  const codex = upstreamRecord('codex', {
    kind: 'codex', config: { accounts: [] }, state: { accounts: [] },
  });
  const values = valuesFromRecord(codex);
  expect((values.config as { normalizeInstallationId: boolean }).normalizeInstallationId).toBe(false);
  for (const enabled of [true, false]) {
    values.config = { ...values.config, normalizeInstallationId: enabled };
    expect(updateBody(codex, values).config).toEqual({ normalizeInstallationId: enabled });
    expect(createBody(codex, values).config).toEqual({ accounts: [], normalizeInstallationId: enabled });
    expect(previewRecord(codex, values).config).toEqual({ accounts: [], normalizeInstallationId: enabled });
  }
});

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
  expect((updateBody(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((previewRecord(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
});
