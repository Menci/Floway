import { expect, test } from 'vitest';

import type { CustomIngressHeaderRule, CustomUpstreamConfig } from '../src/config.ts';
import { customHeaders } from '../src/pipelines/http.ts';
import { getHeaders, type HttpHeaders } from '@floway-dev/http';

const HEADER = 'x-route';

const config: CustomUpstreamConfig = {
  apiKey: '',
  baseUrl: 'https://custom.test',
  endpoints: {},
  ingressHeadersRules: [],
  modelsFetch: { enabled: false, authStyle: 'bearer' },
};

const rules: Record<string, CustomIngressHeaderRule[]> = {
  passthrough: [{ key: HEADER, value: null }],
  'passthrough after a value': [{ key: HEADER, value: 'one' }, { key: HEADER, value: null }],
  'empty beside a value': [{ key: HEADER, value: '' }, { key: HEADER, value: 'one' }],
};

const clients: Record<string, HttpHeaders> = {
  absent: [],
  repeated: [['X-Route', 'client-a'], ['x-route', 'client-b']],
};

const expected: Record<string, Record<string, string[]>> = {
  passthrough: { absent: [], repeated: ['client-a', 'client-b'] },
  'passthrough after a value': { absent: ['one'], repeated: ['one', 'client-a', 'client-b'] },
  'empty beside a value': { absent: ['', 'one'], repeated: ['', 'one'] },
};

for (const [rule, ingressHeadersRules] of Object.entries(rules)) {
  for (const [client, headers] of Object.entries(clients)) {
    test(`${rule} with ${client} client values`, () => {
      const prepared = customHeaders(headers, { ...config, ingressHeadersRules }, 'bearer', 'application/json');
      expect(getHeaders(prepared, HEADER)).toEqual(expected[rule][client]);
    });
  }
}
