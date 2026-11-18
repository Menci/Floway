import { test } from 'vitest';

import { assertCustomUpstreamRecord } from '../src/index.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  kind: 'custom',
  name: 'Test Custom',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com',
    apiKey: 'sk-test',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

test('assertCustomUpstreamRecord canonicalizes ingress header rules without collapsing empty values', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      ingressHeadersRules: [
        { key: ' X-Request-ID ', value: null },
        { key: 'X-Empty', value: '' },
        { key: 'X-Route', value: ' configured ' },
        { key: 'API-Key', value: 'resource-key' },
      ],
    },
  });

  assertEquals(config.ingressHeadersRules, [
    { key: 'x-request-id', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'configured' },
    { key: 'api-key', value: 'resource-key' },
  ]);
});

test('assertCustomUpstreamRecord rejects invalid ingress header rules', () => {
  for (const [rules, message] of [
    [[{ key: 'X-Route', value: null }, { key: 'x-route', value: null }], 'passes x-route through more than once'],
    [[{ key: 'bad header', value: null }], 'must be a valid HTTP header name'],
    [[{ key: 'x-route', value: 'ok\r\nnot-ok' }], 'value is not a valid HTTP header value'],
    [[{ key: 'x-route', value: 'non-byte-\u0100' }], 'value is not a valid HTTP header value'],
    [[{ key: 'Anthropic-Beta', value: null }], 'anthropic-beta is owned by the Anthropic Messages protocol'],
    [[{ key: 'Authorization', value: null }], 'authorization is owned by the HTTP transport'],
    [[{ key: 'CF-Ray', value: null }], 'cf-ray is owned by the HTTP transport'],
  ] as const) {
    assertThrows(
      () => assertCustomUpstreamRecord({
        ...baseRecord,
        config: { ...(baseRecord.config as Record<string, unknown>), ingressHeadersRules: rules },
      }),
      Error,
      message,
    );
  }
});

test('assertCustomUpstreamRecord rejects malformed opaque config instead of dropping endpoints', () => {
  assertThrows(
    () =>
      assertCustomUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoints: { bogus: {} },
        },
      }),
    Error,
    'unsupported endpoint bogus',
  );

  assertThrows(
    () =>
      assertCustomUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          pathOverrides: { models: '/models' },
        },
      }),
    Error,
    'unsupported pathOverrides key models',
  );

  assertThrows(
    () =>
      assertCustomUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          baseUrl: 'ftp://custom.example.com',
        },
      }),
    Error,
    'baseUrl must be an http(s) URL',
  );
});
