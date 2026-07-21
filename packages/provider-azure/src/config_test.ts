import { test } from 'vitest';

import { assertAzureUpstreamRecord } from './index.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_azure',
  kind: 'azure',
  name: 'Azure Resource',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com/',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        endpoints: { chatCompletions: {}, responses: {}, embeddings: {} },
      },
    ],
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  color: null,
};

test('assertAzureUpstreamRecord validates Azure opaque config strictly', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        kind: 'custom',
      }),
    Error,
    'Expected azure upstream record, got custom',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com?tenant=a',
        },
      }),
    Error,
    'endpoint: must be an http(s) URL without query or fragment',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'http://example.openai.azure.com/openai/v1',
        },
      }),
    Error,
    'endpoint: must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://custom.example.com/openai/v1',
        },
      }),
    Error,
    'endpoint: must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.inference.ai.azure.com/openai/v1',
        },
      }),
    Error,
    'endpoint: must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com/openai',
        },
      }),
    Error,
    'endpoint: must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.services.ai.azure.com/api/projects/prod/anthropic/v1/messages',
        },
      }),
    Error,
    'endpoint: must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com/?',
        },
      }),
    Error,
    'endpoint: must be an http(s) URL without query or fragment',
  );
});

test('assertAzureUpstreamRecord round-trips per-model flagOverrides', () => {
  const parsed = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'gpt-5',
          endpoints: { chatCompletions: {} },
          flagOverrides: { 'vendor-kimi': true, 'vendor-deepseek': false },
        },
      ],
    },
  });

  assertEquals(parsed.config.models[0].flagOverrides, { 'vendor-kimi': true, 'vendor-deepseek': false });
});

test('assertAzureUpstreamRecord rejects malformed per-model flagOverrides', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          models: [
            {
              upstreamModelId: 'gpt-prod',
              endpoints: { chatCompletions: {} },
              flagOverrides: 'not-an-object',
            },
          ],
        },
      }),
    Error,
    'azure models[0].flagOverrides: must be an object',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          models: [
            {
              upstreamModelId: 'gpt-prod',
              endpoints: { chatCompletions: {} },
              flagOverrides: { 'vendor-deepseek': 'on' },
            },
          ],
        },
      }),
    Error,
    'azure models[0].flagOverrides.vendor-deepseek: must be a boolean',
  );
});

test('assertAzureUpstreamRecord rejects per-model flagOverrides with unknown flag id', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          models: [
            {
              upstreamModelId: 'gpt-prod',
              endpoints: { chatCompletions: {} },
              flagOverrides: { 'made-up-flag': true },
            },
          ],
        },
      }),
    Error,
    'azure models[0].flagOverrides: unknown flag ids: made-up-flag',
  );
});

test('assertAzureUpstreamRecord reports all unknown per-model flag ids in one error', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          models: [
            {
              upstreamModelId: 'gpt-prod',
              endpoints: { chatCompletions: {} },
              flagOverrides: { 'made-up-flag': true, 'another-typo': false },
            },
          ],
        },
      }),
    Error,
    'azure models[0].flagOverrides: unknown flag ids: made-up-flag, another-typo',
  );
});

test('assertAzureUpstreamRecord round-trips model.pricing with full pricing fields', () => {
  const parsed = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      models: [
        {
          upstreamModelId: 'gpt-prod',
          endpoints: { chatCompletions: {} },
          pricing: { entries: [{ rates: { input_tokens: '2.5', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.75', input_image_tokens: '8', output_tokens: '15', output_image_tokens: '30' } }] },
        },
      ],
    },
  });
  assertEquals(parsed.config.models[0].pricing, {
    entries: [{ rates: { input_tokens: '2.5', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.75', input_image_tokens: '8', output_tokens: '15', output_image_tokens: '30' } }],
  });
});

test('assertAzureUpstreamRecord accepts model without pricing field', () => {
  assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      models: [
        {
          upstreamModelId: 'gpt-prod',
          endpoints: { chatCompletions: {} },
        },
      ],
    },
  });
});

test('assertAzureUpstreamRecord accepts model.pricing with only input set', () => {
  assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      models: [
        {
          upstreamModelId: 'gpt-prod',
          endpoints: { chatCompletions: {} },
          pricing: { entries: [{ rates: { input_tokens: '2.5' } }] },
        },
      ],
    },
  });
});

test('assertAzureUpstreamRecord rejects model.pricing with negative input', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          models: [
            {
              upstreamModelId: 'gpt-prod',
              endpoints: { chatCompletions: {} },
              pricing: { entries: [{ rates: { input_tokens: '-1', output_tokens: '1' } }] },
            },
          ],
        },
      }),
    Error,
    'pricing.entries[0].rates.input_tokens must be non-negative',
  );
});

test('assertAzureUpstreamRecord rejects model.pricing with non-number input_cache_read', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          models: [
            {
              upstreamModelId: 'gpt-prod',
              endpoints: { chatCompletions: {} },
              pricing: { entries: [{ rates: { input_tokens: '2', output_tokens: '8', input_cache_read_tokens: 'cheap' } }] },
            },
          ],
        },
      }),
    Error,
    'pricing.entries[0].rates.input_cache_read_tokens must be a decimal string',
  );
});
