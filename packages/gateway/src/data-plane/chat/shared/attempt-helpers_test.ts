import { describe, expect, test } from 'vitest';

import { chatTargetPicker } from './attempt-helpers.ts';
import { setupAppTest } from '../../../test-helpers.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// Drains SWR background revalidate so a rejection surfaces in the runner
// instead of being swallowed.
const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};

// Azure resolves its catalog without HTTP, giving deterministic candidates.
const azureUpstream = (id: string, sortOrder: number, modelIds: string[], endpoints: ModelEndpoints): UpstreamRecord => ({
  id,
  provider: 'azure',
  name: id,
  enabled: true,
  sortOrder,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {
    endpoint: `https://${id}.openai.azure.com`,
    apiKey: 'az-key',
    models: modelIds.map(upstreamModelId => ({ upstreamModelId, endpoints })),
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

describe('chatTargetPicker', () => {
  test('canServe returns true when at least one preferred key matches the endpoint surface', () => {
    const picker = chatTargetPicker(['messages', 'responses']);
    assertEquals(picker.canServe({ messages: {} }), true);
    assertEquals(picker.canServe({ responses: {} }), true);
    assertEquals(picker.canServe({ messages: {}, responses: {} }), true);
  });

  test('canServe returns false when none of the preferred keys appear on the endpoint surface', () => {
    const picker = chatTargetPicker(['messages']);
    assertEquals(picker.canServe({ chatCompletions: {} }), false);
    assertEquals(picker.canServe({ responses: {} }), false);
    assertEquals(picker.canServe({}), false);
  });

  test('pick returns the first preferred key whose endpoint exists', () => {
    const picker = chatTargetPicker(['responses', 'messages', 'chat-completions']);
    assertEquals(picker.pick({ messages: {}, responses: {}, chatCompletions: {} }), 'responses');
    assertEquals(picker.pick({ messages: {}, chatCompletions: {} }), 'messages');
    assertEquals(picker.pick({ chatCompletions: {} }), 'chat-completions');
  });

  test('pick honours the preference order even when later preferences are present', () => {
    const messagesFirst = chatTargetPicker(['messages', 'responses']);
    const responsesFirst = chatTargetPicker(['responses', 'messages']);
    const endpoints = { messages: {}, responses: {} };
    assertEquals(messagesFirst.pick(endpoints), 'messages');
    assertEquals(responsesFirst.pick(endpoints), 'responses');
  });

  test('pick throws on a candidate the picker rejects — serve must filter via canServe first', () => {
    const picker = chatTargetPicker(['messages']);
    // The throw itself is the contract; the exact message text is not.
    expect(() => picker.pick({ chatCompletions: {} })).toThrow(Error);
  });
});

describe('enumerateModelCandidates + chatTargetPicker', () => {
  test('a multi-endpoint candidate is filterable by canServe and pickable by every matching preference', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_multi', 10, ['test-model'], { messages: {}, responses: {} }));

    const { candidates } = await enumerateModelCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });
    assertEquals(candidates.length, 1);

    const messagesFirst = chatTargetPicker(['messages', 'responses']);
    const responsesFirst = chatTargetPicker(['responses', 'messages']);
    assertEquals(messagesFirst.canServe(candidates[0].model.endpoints), true);
    assertEquals(responsesFirst.canServe(candidates[0].model.endpoints), true);
    assertEquals(messagesFirst.pick(candidates[0].model.endpoints), 'messages');
    assertEquals(responsesFirst.pick(candidates[0].model.endpoints), 'responses');
  });

  test('a candidate whose endpoint surface lacks every preferred key is filtered out by canServe', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { chatCompletions: {} }));

    const { candidates } = await enumerateModelCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      currentColo: 'TEST',
    });
    assertEquals(candidates.length, 1);

    const messagesOnly = chatTargetPicker(['messages']);
    const chatCompletionsPicker = chatTargetPicker(['chat-completions']);
    assertEquals(messagesOnly.canServe(candidates[0].model.endpoints), false);
    assertEquals(chatCompletionsPicker.canServe(candidates[0].model.endpoints), true);
    assertEquals(chatCompletionsPicker.pick(candidates[0].model.endpoints), 'chat-completions');
  });
});
