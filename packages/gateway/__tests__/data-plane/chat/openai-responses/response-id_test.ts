import { expect, test } from 'vitest';

import { createOpenAIResponsesResponseId } from '../../../../src/data-plane/chat/openai-responses/response-id.ts';

test('creates distinct opaque response envelope ids', () => {
  const first = createOpenAIResponsesResponseId();
  const second = createOpenAIResponsesResponseId();

  expect(first).toMatch(/^resp_.+$/u);
  expect(second).toMatch(/^resp_.+$/u);
  expect(second).not.toBe(first);
});
