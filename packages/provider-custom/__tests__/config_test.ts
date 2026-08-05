import { test } from 'vitest';

import { assertCustomUpstreamRecord } from '../src/index.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  kind: 'custom',
  name: 'Test Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-test',
    endpoints: { chatCompletions: {} },
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

test('assertCustomUpstreamRecord parses modelsFetch and models', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: false },
      models: [
        { upstreamModelId: 'pinned', endpoints: { chatCompletions: {} }, display_name: 'Pinned' },
      ],
    },
  });

  assertEquals(config.modelsFetch, { enabled: false });
  assertEquals(config.models.length, 1);
  assertEquals(config.models[0].upstreamModelId, 'pinned');
  assertEquals(config.models[0].display_name, 'Pinned');
});

test('assertCustomUpstreamRecord canonicalizes ingress header rules without collapsing empty values', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      ingressHeadersRules: [
        { key: ' X-Request-ID ', value: null },
        { key: 'X-Empty', value: '' },
        { key: 'X-Route', value: ' configured ' },
      ],
    },
  });

  assertEquals(config.ingressHeadersRules, [
    { key: 'x-request-id', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'configured' },
  ]);
});

test('assertCustomUpstreamRecord rejects invalid or duplicate ingress header rules', () => {
  for (const [rules, message] of [
    [[{ key: 'X-Route', value: null }, { key: 'x-route', value: 'other' }], 'duplicate key x-route'],
    [[{ key: 'bad header', value: null }], 'must be a valid HTTP header name'],
    [[{ key: 'x-route', value: 'ok\r\nnot-ok' }], 'value is not a valid HTTP header value'],
    [[{ key: 'x-route', value: null, extra: true }], 'must contain only key and value'],
    ['not-an-array', 'ingressHeadersRules must be an array'],
    [[null], 'must contain only key and value'],
    [[{ key: 1, value: null }], 'key must be a valid HTTP header name'],
    [[{ key: 'x-route', value: 1 }], 'value must be a string or null'],
    [[{ key: 'Content-Length', value: null }], 'content-length is owned by the HTTP transport'],
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

test('assertCustomUpstreamRecord requires ingressHeadersRules on persisted config', () => {
  const config = { ...(baseRecord.config as Record<string, unknown>) };
  delete config.ingressHeadersRules;
  assertThrows(
    () => assertCustomUpstreamRecord({ ...baseRecord, config }),
    Error,
    'ingressHeadersRules must be an array',
  );
});

test('assertCustomUpstreamRecord defaults modelsFetch to enabled when absent', () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);
  assertEquals(config.modelsFetch, { enabled: true });
  assertEquals(config.models, []);
});

test('assertCustomUpstreamRecord accepts the standard audio transcription path override', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      pathOverrides: { '/audio/transcriptions': '/speech/to-text' },
    },
  });
  assertEquals(config.pathOverrides, { '/audio/transcriptions': '/speech/to-text' });
});

test('assertCustomUpstreamRecord treats a null modelsFetch.endpoint as no override', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true, endpoint: null },
    },
  });
  assertEquals(config.modelsFetch, { enabled: true });
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

  assertThrows(
    () =>
      assertCustomUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          authStyle: 'oauth',
        },
      }),
    Error,
    'authStyle must be "bearer", "anthropic", or "none"',
  );
});

test('assertCustomUpstreamRecord accepts authStyle "none" with no apiKey', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      baseUrl: 'https://internal.example.com',
      authStyle: 'none',
      endpoints: { chatCompletions: {} },
      ingressHeadersRules: [],
    },
  });
  assertEquals(config.authStyle, 'none');
  // The discriminated union narrows: apiKey is statically absent on the
  // 'none' branch, so reading it requires the cast.
  assertEquals((config as unknown as Record<string, unknown>).apiKey, undefined);
});

test('assertCustomUpstreamRecord rejects authStyle "none" with a stale apiKey', () => {
  assertThrows(
    () =>
      assertCustomUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          authStyle: 'none',
          apiKey: 'sk-leftover',
        },
      }),
    Error,
    'apiKey must not be present when authStyle is "none"',
  );
});

test('assertCustomUpstreamRecord rejects authStyle "bearer" with no apiKey', () => {
  assertThrows(
    () =>
      assertCustomUpstreamRecord({
        ...baseRecord,
        config: {
          baseUrl: 'https://custom.example.com',
          authStyle: 'bearer',
          endpoints: { chatCompletions: {} },
          ingressHeadersRules: [],
        },
      }),
    Error,
    'apiKey must be a non-empty string',
  );
});
