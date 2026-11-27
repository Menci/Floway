import { test } from 'vitest';

import { assertCustomUpstreamRecord } from '../src/index.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';
import type { UpstreamRecord } from '@floway-dev/upstream';

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
  for (const rules of [
    [{ key: 'X-Route', value: null }, { key: 'x-route', value: null }],
    [{ key: 'bad header', value: null }],
    [{ key: 'x-route', value: 'ok\r\nnot-ok' }],
    [{ key: 'Anthropic-Beta', value: null }],
    [{ key: 'Authorization', value: null }],
    [{ key: 'CF-Ray', value: null }],
  ]) {
    assertThrows(
      () => assertCustomUpstreamRecord({
        ...baseRecord,
        config: { ...(baseRecord.config as Record<string, unknown>), ingressHeadersRules: rules },
      }),
      Error,
    );
  }
});

test('preserves the OpenAI Audio Speech capability and operator path override', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      endpoints: { openaiAudioSpeech: {} },
      pathOverrides: { '/audio/speech': '/generate-audio' },
    },
  });

  assertEquals(config.endpoints, { openaiAudioSpeech: {} });
  assertEquals(config.pathOverrides, { '/audio/speech': '/generate-audio' });
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
  );

});
