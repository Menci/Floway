import { describe, expect, test } from 'vitest';

import { chatTargetPicker } from '../../../../src/data-plane/chat/shared/target-picker.ts';
import { enumerateModelCandidates } from '../../../../src/data-plane/providers/resolution.ts';
import { setupAppTest } from '../../../test-utils/app.ts';
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
  kind: 'azure',
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
  modelsCache: null,
  hue: 210,
});

describe('chatTargetPicker', () => {
  test('canServe returns true when at least one preferred key matches the endpoint surface', () => {
    const picker = chatTargetPicker(['anthropicMessages', 'openaiResponses']);
    assertEquals(picker.canServe({ anthropicMessages: {} }), true);
    assertEquals(picker.canServe({ openaiResponses: {} }), true);
    assertEquals(picker.canServe({ anthropicMessages: {}, openaiResponses: {} }), true);
  });

  test('canServe returns false when none of the preferred keys appear on the endpoint surface', () => {
    const picker = chatTargetPicker(['anthropicMessages']);
    assertEquals(picker.canServe({ openaiChatCompletions: {} }), false);
    assertEquals(picker.canServe({ openaiResponses: {} }), false);
    assertEquals(picker.canServe({}), false);
  });

  test('pick returns the first preferred key whose endpoint exists', () => {
    const picker = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);
    assertEquals(picker.pick({ anthropicMessages: {}, openaiResponses: {}, openaiChatCompletions: {} }), 'openaiResponses');
    assertEquals(picker.pick({ anthropicMessages: {}, openaiChatCompletions: {} }), 'anthropicMessages');
    assertEquals(picker.pick({ openaiChatCompletions: {} }), 'openai-chat-completions');
  });

  test('pick honours the preference order even when later preferences are present', () => {
    const anthropicMessagesFirst = chatTargetPicker(['anthropicMessages', 'openaiResponses']);
    const openaiResponsesFirst = chatTargetPicker(['openaiResponses', 'anthropicMessages']);
    const endpoints = { anthropicMessages: {}, openaiResponses: {} };
    assertEquals(anthropicMessagesFirst.pick(endpoints), 'anthropicMessages');
    assertEquals(openaiResponsesFirst.pick(endpoints), 'openaiResponses');
  });

  test('pick throws on a candidate the picker rejects — serve must filter via canServe first', () => {
    const picker = chatTargetPicker(['anthropicMessages']);
    // The throw itself is the contract; the exact message text is not.
    expect(() => picker.pick({ openaiChatCompletions: {} })).toThrow(Error);
  });
});

describe('enumerateModelCandidates + chatTargetPicker', () => {
  test('a multi-endpoint candidate is filterable by canServe and pickable by every matching preference', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_multi', 10, ['test-model'], { anthropicMessages: {}, openaiResponses: {} }));

    const { candidates } = await enumerateModelCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      runtimeLocation: 'TEST',
    });
    assertEquals(candidates.length, 1);

    const anthropicMessagesFirst = chatTargetPicker(['anthropicMessages', 'openaiResponses']);
    const openaiResponsesFirst = chatTargetPicker(['openaiResponses', 'anthropicMessages']);
    assertEquals(anthropicMessagesFirst.canServe(candidates[0].model.endpoints), true);
    assertEquals(openaiResponsesFirst.canServe(candidates[0].model.endpoints), true);
    assertEquals(anthropicMessagesFirst.pick(candidates[0].model.endpoints), 'anthropicMessages');
    assertEquals(openaiResponsesFirst.pick(candidates[0].model.endpoints), 'openaiResponses');
  });

  test('a candidate whose endpoint surface lacks every preferred key is filtered out by canServe', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { openaiChatCompletions: {} }));

    const { candidates } = await enumerateModelCandidates({
      upstreamIds: null,
      model: 'test-model',
      kind: 'chat',
      scheduler: testScheduler,
      runtimeLocation: 'TEST',
    });
    assertEquals(candidates.length, 1);

    const anthropicMessagesOnly = chatTargetPicker(['anthropicMessages']);
    const openaiChatCompletionsPicker = chatTargetPicker(['openaiChatCompletions']);
    assertEquals(anthropicMessagesOnly.canServe(candidates[0].model.endpoints), false);
    assertEquals(openaiChatCompletionsPicker.canServe(candidates[0].model.endpoints), true);
    assertEquals(openaiChatCompletionsPicker.pick(candidates[0].model.endpoints), 'openai-chat-completions');
  });
});
