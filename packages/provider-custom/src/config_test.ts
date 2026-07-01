import { test } from 'vitest';

import { assertCustomUpstreamRecord } from './index.ts';
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
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
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

test('assertCustomUpstreamRecord defaults modelsFetch to enabled when absent', () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);
  assertEquals(config.modelsFetch, { enabled: true });
  assertEquals(config.models, []);
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
        },
      }),
    Error,
    'apiKey must be a non-empty string',
  );
});
