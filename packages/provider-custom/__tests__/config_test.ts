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

test('assertCustomUpstreamRecord keeps several rules under one name', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      ingressHeadersRules: [
        { key: 'X-Route', value: null },
        { key: 'x-route', value: 'appended' },
        { key: 'x-route', value: '' },
      ],
    },
  });

  assertEquals(config.ingressHeadersRules, [
    { key: 'x-route', value: null },
    { key: 'x-route', value: 'appended' },
    { key: 'x-route', value: '' },
  ]);
});

test('assertCustomUpstreamRecord rejects invalid ingress header rules', () => {
  for (const [rules, message] of [
    [[{ key: 'X-Route', value: null }, { key: 'x-route', value: null }], 'passes x-route through more than once'],
    [[{ key: 'bad header', value: null }], 'must be a valid HTTP header name'],
    [[{ key: 'x-route', value: 'ok\r\nnot-ok' }], 'value is not a valid HTTP header value'],
    [[{ key: 'x-route', value: 'control\u0001byte' }], 'value is not a valid HTTP header value'],
    [[{ key: 'x-route', value: 'delete\u007fbyte' }], 'value is not a valid HTTP header value'],
    [[{ key: 'x-route', value: 'non-byte-\u0100' }], 'value is not a valid HTTP header value'],
    [[{ key: 'x-route', value: null, extra: true }], 'must contain only key and value'],
    ['not-an-array', 'ingressHeadersRules must be an array'],
    [[null], 'must contain only key and value'],
    [[{ key: 1, value: null }], 'key must be a valid HTTP header name'],
    [[{ key: 'x-route', value: 1 }], 'value must be a string or null'],
    [[{ key: 'Content-Length', value: null }], 'content-length is owned by the HTTP transport'],
    [[{ key: 'Anthropic-Beta', value: null }], 'anthropic-beta is owned by the Messages protocol'],
    [[{ key: 'Authorization', value: null }], 'authorization is owned by the HTTP transport'],
    [[{ key: 'CF-Ray', value: null }], 'cf-ray is owned by the HTTP transport'],
    [[{ key: 'X-Forwarded-Port', value: null }], 'x-forwarded-port is owned by the HTTP transport'],
    [[{ key: 'Sec-WebSocket-Key', value: null }], 'sec-websocket-key is owned by the HTTP transport'],
    [[{ key: 'Proxy-Authenticate', value: null }], 'proxy-authenticate is owned by the HTTP transport'],
    [[{ key: 'Proxy-Authentication-Info', value: null }], 'proxy-authentication-info is owned by the HTTP transport'],
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

test('assertCustomUpstreamRecord reserves every transport-owned header name and family', () => {
  const exactNames = [
    'accept-encoding',
    'authorization',
    'cdn-loop',
    'connection',
    'content-encoding',
    'content-length',
    'content-type',
    'cookie',
    'expect',
    'forwarded',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authentication-info',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'true-client-ip',
    'upgrade',
    'x-api-key',
    'x-client-ip',
    'x-floway-session',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-goog-api-key',
    'x-openai-actor-authorization',
    'x-real-ip',
  ];
  const familyMembers = ['cf-future-field', 'sec-websocket-future-field', 'x-forwarded-future-field'];

  for (const key of [...exactNames, ...familyMembers]) {
    assertThrows(
      () => assertCustomUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          ingressHeadersRules: [{ key: key.toUpperCase(), value: null }],
        },
      }),
      Error,
      `${key} is owned by the HTTP transport`,
    );
  }
});

test('assertCustomUpstreamRecord preserves valid HTAB and obs-text field-value bytes', () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      ingressHeadersRules: [
        { key: 'x-tab', value: 'left\tright' },
        { key: 'x-obs-text', value: '\u0080\u00ff' },
      ],
    },
  });

  assertEquals(config.ingressHeadersRules, [
    { key: 'x-tab', value: 'left\tright' },
    { key: 'x-obs-text', value: '\u0080\u00ff' },
  ]);
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
