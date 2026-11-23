import { expect, test, vi } from 'vitest';

import { readHttpBytes, responsesFixture, responsesUpstream, wireEvents, type WireRequest } from './fixture.ts';
import { syntheticEventsFromResult } from '../../../../src/data-plane/chat/openai-responses/items/output.ts';

test('generate filters out candidates whose endpoints do not satisfy the Responses preference', async () => {
  const respond = vi.fn(() => { throw new Error('Unexpected provider call'); });
  const source = responsesUpstream('unsupported', respond);
  const fixture = responsesFixture([{ ...source, candidate: { ...source.candidate, endpoints: { openaiCompletions: {} } } }]);
  const handle = fixture.request({ model: 'wrong-endpoint-model', input: 'hello' });
  const { 'response.http': response } = await handle.result;
  expect(response.status).toBe(400);
  expect(JSON.parse((await readHttpBytes(response.body)).utf8())).toMatchObject({
    error: { type: 'invalid_request_error', message: 'Model wrong-endpoint-model does not support the /responses endpoint.' },
  });
  expect(respond).toHaveBeenCalledTimes(0);
  expect(await handle.done).toEqual({ ok: true });
});

test('alias resolution passes the target model and overlays rules onto the native Responses payload', async () => {
  const respond = vi.fn((_request: WireRequest) => wireEvents(syntheticEventsFromResult({
    id: 'response', object: 'response', model: 'gpt-5.4', output: [], status: 'completed', error: null, incomplete_details: null,
  })));
  const source = responsesUpstream('responses', respond);
  const fixture = responsesFixture([{
    ...source,
    candidate: {
      ...source.candidate, modelId: 'gpt-5.4', upstreamModelId: 'gpt-5.4',
      providerModel: { ...source.candidate.providerModel, id: 'gpt-5.4', upstreamModelId: 'gpt-5.4' },
      rules: { reasoning: { effort: 'high', summary: 'detailed' }, verbosity: 'medium', serviceTier: 'priority' },
    },
  }]);
  const handle = fixture.request({ model: 'gpt-fast', input: 'hello' });
  const response = (await handle.result)['response.http'];
  expect(response.status).toBe(200);
  expect(fixture.requestedModels).toEqual(['gpt-fast']);
  const request = respond.mock.calls[0]?.[0];
  expect(request?.payload.model).toBe('gpt-5.4');
  expect(request?.payload).toMatchObject({
    reasoning: { effort: 'high', summary: 'detailed' }, text: { verbosity: 'medium' }, service_tier: 'priority',
  });
  expect(await handle.done).toEqual({ ok: true });
});
