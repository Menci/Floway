import { expect, test } from 'vitest';

import { clearInProcessCopilotTokenCache } from '../../src/auth.ts';
import { createCopilotPipelines } from '../../src/pipelines.ts';
import { emptyCopilotUpstreamState } from '../../src/state.ts';
import { move, run } from '@floway-dev/pipeline';
import { initProviderRepo, providerModelFacts, type ProviderChatServices, type ProviderOperationRequest, type UpstreamRecord } from '@floway-dev/provider';
import { jsonResponse, noopUpstreamCallOptions, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const auth = { id: 'up_pipeline', githubHost: 'github.com', githubToken: 'test-token' };
const setup = (): void => {
  clearInProcessCopilotTokenCache();
  const upstream: UpstreamRecord = { id: auth.id, kind: 'copilot', name: 'Test', enabled: true, sortOrder: 0, createdAt: '', updatedAt: '', config: {}, state: { ...emptyCopilotUpstreamState(), copilotToken: { token: 'access-token', expiresAt: 4102444800, baseUrl: 'https://copilot.example' } }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210 };
  initProviderRepo(() => ({ upstreams: { getById: async () => upstream, saveState: async () => {} } }));
};
const services: ProviderChatServices = { httpCall: () => ({ ...noopUpstreamCallOptions(), signal: undefined }), recordProtocolFrames: frames => frames };

test('Copilot compaction runs vendor request stages and normalizes the generated value in the same run', async () => {
  setup();
  const pipeline = createCopilotPipelines(auth).openaiResponsesCompact;
  if (pipeline === undefined) throw new Error('Missing compact chain');
  const model = stubProviderModel({ id: 'gpt-5.4', providerData: { rawModels: [{ id: 'gpt-5.4', supported_endpoints: ['/responses'] }] } });
  const input: ProviderOperationRequest<'openaiResponsesCompact'> = move({
    'request.provider.model': providerModelFacts(model),
    'request.provider.payload': { input: [{ type: 'message', role: 'user', content: 'hello' }], store: true, service_tier: 'priority', tools: [{ type: 'namespace', name: 'tools', description: '', tools: [] }] },
    'request.http.callId': 1,
    'request.http.headers': [],
  });
  await withMockedFetch(async request => {
    expect(request.url).toBe('https://copilot.example/responses');
    expect(request.headers.get('authorization')).toBe('Bearer access-token');
    const body = await request.json() as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-5.4', store: false, stream: false, tools: [{ type: 'namespace', description: 'Tools in the tools namespace.' }] });
    expect(body).not.toHaveProperty('service_tier');
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }, { type: 'compaction_trigger' }]);
    return jsonResponse({ id: 'response', object: 'response', output: [{ type: 'compaction', id: 'upstream-compaction-id', encrypted_content: 'opaque' }] });
  }, async () => {
    const executed = await run(pipeline, input, services);
    const output = executed.facts['response.provider.output'];
    if (output === null || !('kind' in output) || output.kind !== 'value') throw new Error('Expected compact value');
    expect(output.body.object).toBe('response.compaction');
    expect(output.body.output).toHaveLength(2);
    expect(output.body.output[1]).toMatchObject({ type: 'compaction' });
    expect(output.body.output[1].id).not.toBe('upstream-compaction-id');
    expect(executed.facts['response.provider.called']).toBe(true);
    expect(executed.facts['response.provider.modelKey']).toBe('gpt-5.4');
    expect(input['request.provider.payload'].store).toBe(true);
    await executed.drain();
  });
});

test('unsupported Anthropic Fast Mode is a preflight value with no model endpoint observation', async () => {
  setup();
  const pipeline = createCopilotPipelines(auth).anthropicMessages;
  if (pipeline === undefined) throw new Error('Missing Messages chain');
  const input: ProviderOperationRequest<'anthropicMessages'> = move({
    'request.provider.model': providerModelFacts(stubProviderModel({ id: 'claude-sonnet-4.6', providerData: { rawModels: [{ id: 'claude-sonnet-4.6', supported_endpoints: ['/v1/messages'] }] } })),
    'request.provider.payload': { max_tokens: 16, messages: [], speed: 'fast' },
    'request.provider.anthropicBeta': [],
    'request.http.callId': 1,
    'request.http.headers': [],
  });
  await withMockedFetch(() => { throw new Error('No network request expected'); }, async () => {
    const executed = await run(pipeline, input, services);
    expect(executed.facts['response.provider.called']).toBe(false);
    expect(executed.facts['response.provider.previousCalls']).toEqual([]);
    expect(executed.facts['response.http.exchange']).toMatchObject({ type: 'response', status: 400 });
    await executed.drain();
  });
});
