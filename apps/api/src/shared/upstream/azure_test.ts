import { test } from 'vitest';

import { assertAzureUpstreamRecord, createAzureUpstream } from './azure.ts';
import type { UpstreamRecord } from '../../repo/types.ts';
import { assertEquals, assertThrows } from '../../test-assert.ts';
import { withMockedFetch } from '../../test-helpers.ts';

const baseRecord: UpstreamRecord = {
  id: 'up_azure',
  provider: 'azure',
  name: 'Azure Resource',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com/',
    apiKey: 'az-key',
    deployments: [
      {
        deployment: 'gpt-prod',
        supportedEndpoints: ['/chat/completions', '/responses', '/embeddings'],
      },
    ],
  },
  flagOverrides: {},
};

test('createAzureUpstream uses Azure OpenAI v1 paths with api-key auth', async () => {
  const upstream = createAzureUpstream(baseRecord);
  const seen: Array<{ url: string; apiKey: string | null; contentType: string | null; beta: string | null; body: unknown }> = [];

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('api-key'),
        contentType: request.headers.get('content-type'),
        beta: request.headers.get('anthropic-beta'),
        body: request.method === 'GET' ? null : await request.json(),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('chat_completions', { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) });
      await upstream.fetch('responses', { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) });
      await upstream.fetch('embeddings', { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) });
      await upstream.fetch('models', { method: 'GET' });
    },
  );

  assertEquals(upstream.kind, 'azure');
  assertEquals(upstream.id, 'up_azure');
  assertEquals(upstream.name, 'Azure Resource');
  assertEquals(
    seen.map(item => item.url),
    [
      'https://example.openai.azure.com/openai/v1/chat/completions',
      'https://example.openai.azure.com/openai/v1/responses',
      'https://example.openai.azure.com/openai/v1/embeddings',
      'https://example.openai.azure.com/openai/v1/models',
    ],
  );
  assertEquals(
    seen.map(item => item.apiKey),
    ['az-key', 'az-key', 'az-key', 'az-key'],
  );
  assertEquals(
    seen.map(item => item.contentType),
    ['application/json', 'application/json', 'application/json', null],
  );
  assertEquals(seen[0].body, { model: 'set-by-provider' });
});

test('createAzureUpstream accepts an endpoint that already includes /openai/v1', async () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      endpoint: 'https://example.openai.azure.com/openai/v1/',
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('responses', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seenUrl, 'https://example.openai.azure.com/openai/v1/responses');
});

test('createAzureUpstream accepts Foundry project endpoints for OpenAI v1 calls', async () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod/',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'deepseek-prod',
          supportedEndpoints: ['/responses'],
        },
      ],
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('responses', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seenUrl, 'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses');
});

test('createAzureUpstream accepts Foundry project OpenAI v1 base URLs', async () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod/openai/v1',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'deepseek-prod',
          supportedEndpoints: ['/responses', '/v1/messages'],
        },
      ],
    },
  });
  const seen: string[] = [];

  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('responses', { method: 'POST', body: '{}' });
      await upstream.fetch('messages', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses',
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});

test('createAzureUpstream keeps native Anthropic calls on the resource Anthropic base when a project endpoint is entered', async () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'claude-prod',
          supportedEndpoints: ['/v1/messages'],
        },
      ],
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('messages', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seenUrl, 'https://example.services.ai.azure.com/anthropic/v1/messages');
});

test('createAzureUpstream supports Azure Foundry Anthropic Messages with x-api-key auth', async () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'claude-prod',
          supportedEndpoints: ['/v1/messages'],
        },
      ],
    },
  });
  const seen: Array<{ url: string; apiKey: string | null; openAiKey: string | null; version: string | null; beta: string | null }> = [];

  await withMockedFetch(
    request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('x-api-key'),
        openAiKey: request.headers.get('api-key'),
        version: request.headers.get('anthropic-version'),
        beta: request.headers.get('anthropic-beta'),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('messages', { method: 'POST', body: '{}' }, { extraHeaders: { 'anthropic-beta': 'context-1m' } });
      await upstream.fetch('messages_count_tokens', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      apiKey: 'az-key',
      openAiKey: null,
      version: '2023-06-01',
      beta: 'context-1m',
    },
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens',
      apiKey: 'az-key',
      openAiKey: null,
      version: '2023-06-01',
      beta: null,
    },
  ]);
});

test('createAzureUpstream accepts an Azure Foundry Anthropic messages target URI', async () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'claude-prod',
          supportedEndpoints: ['/v1/messages'],
        },
      ],
    },
  });
  const seen: string[] = [];

  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await upstream.fetch('messages', { method: 'POST', body: '{}' });
      await upstream.fetch('models', { method: 'GET' });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/anthropic/v1/messages',
    'https://example.services.ai.azure.com/openai/v1/models',
  ]);
});

test('createAzureUpstream validates Azure opaque config strictly', () => {
  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        provider: 'custom',
      }),
    Error,
    'Expected azure upstream record, got custom',
  );

  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com?tenant=a',
        },
      }),
    Error,
    'endpoint must be an http(s) URL without query or fragment',
  );

  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'http://example.openai.azure.com/openai/v1',
        },
      }),
    Error,
    'endpoint must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com',
  );

  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://custom.example.com/openai/v1',
        },
      }),
    Error,
    'endpoint must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com',
  );

  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.inference.ai.azure.com/openai/v1',
        },
      }),
    Error,
    'endpoint must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com',
  );

  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com/openai',
        },
      }),
    Error,
    'endpoint must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL',
  );

  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.services.ai.azure.com/api/projects/prod/anthropic/v1/messages',
        },
      }),
    Error,
    'endpoint must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL',
  );

  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com/?',
        },
      }),
    Error,
    'endpoint must be an http(s) URL without query or fragment',
  );
});

test('assertAzureUpstreamRecord round-trips per-deployment flagOverrides', () => {
  const parsed = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'gpt-5',
          supportedEndpoints: ['/chat/completions'],
          flagOverrides: { enabled: true, values: { 'vendor-kimi': true, 'vendor-deepseek': false } },
        },
      ],
    },
  });

  assertEquals(parsed.config.deployments[0].flagOverrides, {
    enabled: true,
    values: { 'vendor-kimi': true, 'vendor-deepseek': false },
  });
});

test('assertAzureUpstreamRecord rejects malformed per-deployment flagOverrides', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          deployments: [
            {
              deployment: 'gpt-prod',
              supportedEndpoints: ['/chat/completions'],
              flagOverrides: { enabled: 'yes', values: {} },
            },
          ],
        },
      }),
    Error,
    'deployments[0].flagOverrides.enabled must be a boolean',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          deployments: [
            {
              deployment: 'gpt-prod',
              supportedEndpoints: ['/chat/completions'],
              flagOverrides: { enabled: true, values: { 'vendor-deepseek': 'on' } },
            },
          ],
        },
      }),
    Error,
    'deployments[0].flagOverrides.values.vendor-deepseek must be a boolean',
  );
});

test('assertAzureUpstreamRecord rejects per-deployment flagOverrides with unknown flag id', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          deployments: [
            {
              deployment: 'gpt-prod',
              supportedEndpoints: ['/chat/completions'],
              flagOverrides: { enabled: true, values: { 'made-up-flag': true } },
            },
          ],
        },
      }),
    Error,
    'deployments[0].flagOverrides.values has unknown flag ids: made-up-flag',
  );
});

test('assertAzureUpstreamRecord reports all unknown per-deployment flag ids in one error', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          deployments: [
            {
              deployment: 'gpt-prod',
              supportedEndpoints: ['/chat/completions'],
              flagOverrides: { enabled: true, values: { 'made-up-flag': true, 'another-typo': false } },
            },
          ],
        },
      }),
    Error,
    'deployments[0].flagOverrides.values has unknown flag ids: made-up-flag, another-typo',
  );
});

test('createAzureUpstream accepts deployment.cost with full pricing fields', () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      deployments: [
        {
          deployment: 'gpt-prod',
          supportedEndpoints: ['/chat/completions'],
          cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.75 },
        },
      ],
    },
  });
  assertEquals(upstream.kind, 'azure');
});

test('createAzureUpstream accepts deployment without cost field', () => {
  const upstream = createAzureUpstream({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      deployments: [
        {
          deployment: 'gpt-prod',
          supportedEndpoints: ['/chat/completions'],
        },
      ],
    },
  });
  assertEquals(upstream.kind, 'azure');
});

test('createAzureUpstream rejects deployment.cost with only input set', () => {
  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          deployments: [
            {
              deployment: 'gpt-prod',
              supportedEndpoints: ['/chat/completions'],
              cost: { input: 2.5 },
            },
          ],
        },
      }),
    Error,
    'deployments[0].cost.input and deployments[0].cost.output must both be set',
  );
});

test('createAzureUpstream rejects deployment.cost with negative input', () => {
  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          deployments: [
            {
              deployment: 'gpt-prod',
              supportedEndpoints: ['/chat/completions'],
              cost: { input: -1, output: 1 },
            },
          ],
        },
      }),
    Error,
    'deployments[0].cost.input must be a finite non-negative number',
  );
});

test('createAzureUpstream rejects deployment.cost with non-number cache_read', () => {
  assertThrows(
    () =>
      createAzureUpstream({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          deployments: [
            {
              deployment: 'gpt-prod',
              supportedEndpoints: ['/chat/completions'],
              cost: { input: 2, output: 8, cache_read: 'cheap' },
            },
          ],
        },
      }),
    Error,
    'deployments[0].cost.cache_read must be a finite non-negative number',
  );
});
