import { test } from 'vitest';

import { assertAzureUpstreamRecord } from '../src/config.ts';
import { createAzureProvider } from '../src/provider.ts';
import { runPipeline } from '@floway-dev/pipeline';
import type { Fetcher, ProviderPipelineServices, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, readManagedBytes, toProviderModelFacts } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const record = (endpoint: string, model: Record<string, unknown> = {
  upstreamModelId: 'transcribe deployment',
  endpoints: { openaiResponses: {}, anthropicMessages: {}, openaiAudioTranscriptions: {} },
}): UpstreamRecord => ({
  id: 'up_azure_endpoint',
  kind: 'azure',
  name: 'Azure endpoint',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: { endpoint, apiKey: 'az-key', models: [model] },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

const services = (fetcher: Fetcher): ProviderPipelineServices => ({ fetcherFor: () => fetcher });

test('audio transcription reduces every admitted endpoint shape to the deployment route', async () => {
  const endpoints = [
    ['https://example.openai.azure.com/', 'https://example.openai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
    ['https://example.openai.azure.com/openai/v1/', 'https://example.openai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
    ['https://example.services.ai.azure.com/', 'https://example.services.ai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
    ['https://example.services.ai.azure.com/api/projects/prod/', 'https://example.services.ai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
  ] as const;

  for (const [endpoint, expected] of endpoints) {
    assertAzureUpstreamRecord(record(endpoint));
    const provider = createAzureProvider(record(endpoint));
    const [model] = await provider.instance.getProvidedModels(directFetcher);
    let seenUrl = '';
    const event = await runPipeline(provider.pipelines.openaiAudioTranscriptions!, {
      'provider.model': toProviderModelFacts(model!),
      'request.inboundHeaders': [],
      'request.payload': { entries: [] },
    }, {
      services: services(async url => {
        seenUrl = url;
        return Response.json({ text: 'ok' });
      }),
    });
    if (event.body !== null) await readManagedBytes(event.body);
    assertEquals(seenUrl, expected);
  }
});

test('Foundry project endpoints split OpenAI v1 and Anthropic surfaces', async () => {
  const upstream = record('https://example.services.ai.azure.com/api/projects/prod/openai/v1');
  const provider = createAzureProvider(upstream);
  const [model] = await provider.instance.getProvidedModels(directFetcher);
  const facts = toProviderModelFacts(model!);
  const seen: string[] = [];
  const fetcher: Fetcher = async url => {
    seen.push(url);
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };

  const responses = await runPipeline(provider.pipelines.openaiResponses!, {
    'provider.model': facts,
    'request.inboundHeaders': [],
    'request.action': 'generate',
    'request.payload': { input: [] },
  }, { services: services(fetcher) });
  if (responses.action === 'generate' && responses.ok) for await (const _frame of responses.events) continue;

  const messages = await runPipeline(provider.pipelines.anthropicMessages!, {
    'provider.model': facts,
    'request.inboundHeaders': [],
    'request.anthropicBeta': [],
    'request.payload': { max_tokens: 16, messages: [] },
  }, { services: services(fetcher) });
  if (messages.ok) for await (const _frame of messages.events) continue;

  assertEquals(seen, [
    'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses',
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});
