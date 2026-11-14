import { expect, test } from 'vitest';

import { prepareAzureRequest } from '../../src/stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import type { HttpMultipartBody } from '@floway-dev/http/request-content';
import { compose } from '@floway-dev/pipeline';
import { observeProviderCall, providerModelFacts, type ProviderRequest, type ProviderResponse } from '@floway-dev/provider';
import { collectHttpPipeline, noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

test('audio prepare omits model fields selected by the deployment URL', async () => {
  const file = { bytes: new TextEncoder().encode('audio'), name: 'meeting.wav', type: 'audio/wav' };
  const entries = [{ name: 'model', value: 'public-model' }, { name: 'file', value: file }, { name: 'response_format', value: 'json' }];
  const pipeline = compose<ProviderRequest<{ entries: typeof entries }>, ProviderResponse & Record<string, unknown>>('audio.deployment', [prepareAzureRequest({ endpoint: 'https://azure.example', apiKey: 'key', models: [] }, 'openaiAudioTranscriptions'), observeProviderCall, http]);
  const executed = await collectHttpPipeline(pipeline, { 'request.provider.model': providerModelFacts(stubProviderModel({ providerData: { upstreamModelId: 'deployment' } })), 'request.provider.payload': { entries }, 'request.http.callId': 0, 'request.http.headers': [] }, { httpCall: () => ({ ...noopUpstreamCallOptions(), fetcher: async () => new Response('{}'), signal: undefined }) });
  const body = executed.facts['request.http.body'] as HttpMultipartBody;
  expect(body.entries.map(entry => entry.name)).toEqual(['file', 'response_format']);
  expect(body.entries[0]!.value).toBe(file);
  expect(executed.facts['request.http.url']).toBe('https://azure.example/openai/deployments/deployment/audio/transcriptions?api-version=2025-04-01-preview');
});
