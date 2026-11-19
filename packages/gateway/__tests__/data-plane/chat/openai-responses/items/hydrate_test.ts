import { describe, expect, test } from 'vitest';

import { hydrateOpenAIResponsesPayload } from '../../../../../src/data-plane/chat/openai-responses/items/hydrate.ts';
import { createOpenAIResponsesHttpStore } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { testOpenAIResponsesStatePolicy } from '../test-policy.ts';

describe('OpenAI Responses stored-item hydration', () => {
  test('rejects any missing item reference without an id-format prefilter', () => {
    initRepo(new InMemoryRepo());
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    expect(() => hydrateOpenAIResponsesPayload({
      model: 'model',
      input: [{ type: 'item_reference', id: 'arbitrary-missing-id' }],
    }, store)).toThrow();
  });

});
