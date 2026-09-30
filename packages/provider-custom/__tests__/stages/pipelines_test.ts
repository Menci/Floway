import { expect, test } from 'vitest';

import { createCustomPipelines } from '../../src/pipelines.ts';
import { move, run, type Event } from '@floway-dev/pipeline';
import { providerModelFacts, type ProviderChatServices, type ProviderOperationRequest } from '@floway-dev/provider';
import { jsonResponse, noopUpstreamCallOptions, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const pipelines = createCustomPipelines({ baseUrl: 'https://custom.example', authStyle: 'bearer', apiKey: 'secret-key', endpoints: {}, ingressHeadersRules: [{ key: 'x-many', value: 'first' }, { key: 'x-many', value: 'second' }], pathOverrides: { '/responses': '/overridden' }, modelsFetch: { enabled: false }, models: [] });
const services: ProviderChatServices = { httpCall: () => ({ ...noopUpstreamCallOptions(), signal: undefined }), recordProtocolFrames: frames => frames };

test('custom compact chain derives URL and wire payload from immutable action facts', async () => {
  const pipeline = pipelines.openaiResponsesCompact;
  if (pipeline === undefined) throw new Error('Missing compact chain');
  const input: ProviderOperationRequest<'openaiResponsesCompact'> = move({
    'request.provider.model': providerModelFacts(stubProviderModel({ providerData: 'wire-model' })),
    'request.provider.payload': { input: [{ type: 'message', role: 'user', content: 'hello' }], store: true, max_output_tokens: 30 },
    'request.http.callId': 1,
    'request.http.headers': [],
  });
  await withMockedFetch(async request => {
    expect(request.url).toBe('https://custom.example/overridden/compact');
    expect(request.headers.get('authorization')).toBe('Bearer secret-key');
    expect(request.headers.get('x-many')).toBe('first, second');
    expect(await request.json()).toEqual({ model: 'wire-model', input: [{ type: 'message', role: 'user', content: 'hello' }] });
    return jsonResponse({ object: 'response.compaction', output: [] });
  }, async () => {
    const events: Event[] = [];
    const executed = await run(pipeline, input, { ...services, dump: (event: Event) => { events.push(event); } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage.entered', facts: expect.objectContaining({ 'request.provider.responsesAction': 'compact' }) }));
    expect(executed.facts['response.provider.called']).toBe(true);
    expect(executed.facts['response.provider.output']).toEqual({ kind: 'value', body: { object: 'response.compaction', output: [] } });
    expect(input['request.provider.payload'].store).toBe(true);
    await executed.drain();
  });
});

test('count_tokens forwards typed beta intent and retains raw HTTP response facts', async () => {
  const pipeline = pipelines.anthropicMessagesCountTokens;
  if (pipeline === undefined) throw new Error('Missing count chain');
  const input: ProviderOperationRequest<'anthropicMessagesCountTokens'> = move({
    'request.provider.model': providerModelFacts(stubProviderModel({ providerData: 'wire-model' })),
    'request.provider.payload': { max_tokens: 12, messages: [] },
    'request.provider.anthropicBeta': ['future-beta'],
    'request.http.callId': 1,
    'request.http.headers': [['anthropic-beta', 'discard-ordinary-header']],
  });
  await withMockedFetch(async request => {
    expect(request.url).toBe('https://custom.example/v1/messages/count_tokens');
    expect(request.headers.get('anthropic-beta')).toBe('future-beta');
    expect(await request.json()).toEqual({ model: 'wire-model', max_tokens: 12, messages: [] });
    return jsonResponse({ input_tokens: 19 });
  }, async () => {
    const executed = await run(pipeline, input, services);
    expect(executed.facts['response.provider.output']).toEqual({ kind: 'value', body: { input_tokens: 19 } });
    expect(executed.facts['response.http.exchange']).toMatchObject({ type: 'response', status: 200 });
    await executed.drain();
  });
});
