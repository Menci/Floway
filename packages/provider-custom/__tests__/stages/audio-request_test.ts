import { expect, test } from 'vitest';

import { prepareCustomRequest } from '../../src/stages/prepare-request.ts';
import { http } from '@floway-dev/http/pipeline';
import type { HttpMultipartBody } from '@floway-dev/http/request-content';
import { compose } from '@floway-dev/pipeline';
import { observeProviderCall, providerModelFacts, type ProviderRequest, type ProviderResponse } from '@floway-dev/provider';
import { collectHttpPipeline, noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

test('audio prepare preserves ordered fields and file metadata while replacing the selected model', async () => {
  const file = { bytes: new Uint8Array([1, 2, 3, 4]), name: 'meeting.wav', type: 'audio/wav', lastModified: 1_700_000_000_000 };
  const entries = [{ name: 'file', value: file }, { name: 'language', value: 'en' }, { name: 'model', value: 'public-model' }, { name: 'timestamp_granularities[]', value: 'word' }, { name: 'timestamp_granularities[]', value: 'segment' }];
  const prepare = prepareCustomRequest({ baseUrl: 'https://custom.example', authStyle: 'none', endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] }, 'openaiAudioTranscriptions');
  const pipeline = compose<ProviderRequest<{ entries: typeof entries }>, ProviderResponse & Record<string, unknown>>('audio.metadata', [prepare, observeProviderCall, http]);
  const executed = await collectHttpPipeline(pipeline, { 'request.provider.model': providerModelFacts(stubProviderModel({ providerData: 'upstream-model' })), 'request.provider.payload': { entries }, 'request.http.callId': 0, 'request.http.headers': [] }, { httpCall: () => ({ ...noopUpstreamCallOptions(), fetcher: async () => new Response('{}'), signal: undefined }) });
  const body = executed.facts['request.http.body'] as HttpMultipartBody;
  expect(body.entries.map(entry => entry.name)).toEqual(['file', 'language', 'model', 'timestamp_granularities[]', 'timestamp_granularities[]']);
  expect(body.entries[0]!.value).toBe(file);
  expect(body.entries[0]!.value).toMatchObject({ name: 'meeting.wav', type: 'audio/wav', lastModified: file.lastModified, bytes: new Uint8Array([1, 2, 3, 4]) });
  expect(body.entries[2]!.value).toBe('upstream-model');
  expect(body.entries.slice(3).map(entry => entry.value)).toEqual(['word', 'segment']);
  expect(entries[2]!.value).toBe('public-model');
});
