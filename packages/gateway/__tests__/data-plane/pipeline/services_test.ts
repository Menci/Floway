import { expect, test, vi } from 'vitest';

import { createOpenAIResponsesWsSession } from '../../../src/data-plane/chat/openai-responses/items/store.ts';
import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { setupAppTest } from '../../test-utils/app.ts';

test('shares the OpenAI Responses store across one turn and isolates separate turns', async () => {
  const { apiKey } = await setupAppTest();
  const session = createOpenAIResponsesWsSession();
  const factory = vi.fn((startedAt: number, store: boolean | undefined) => session.createStore(apiKey, startedAt, store));
  const options = {
    apiKey,
    subject: { id: apiKey.userId, isAdmin: false },
    runtimeLocation: 'TEST',
    dump: null,
    openaiResponsesStore: factory,
  };
  const startedAt = Date.now();
  const first = createGatewayServices(options);
  const firstStore = first.openaiResponsesStore(startedAt, undefined);
  expect(first.openaiResponsesStore(startedAt, true)).toBe(firstStore);
  expect(() => first.openaiResponsesStore(startedAt, false)).toThrow('changed the client storage preferences');
  expect(factory.mock.calls).toEqual([[startedAt, undefined]]);

  const second = createGatewayServices(options);
  const secondStore = second.openaiResponsesStore(startedAt + 1, false);
  expect(second.openaiResponsesStore(startedAt + 1, false)).toBe(secondStore);
  expect(secondStore).not.toBe(firstStore);
  expect(factory.mock.calls).toEqual([[startedAt, undefined], [startedAt + 1, false]]);
});
