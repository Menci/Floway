import { expect, test } from 'vitest';

import { terminal } from '../../../src/shared/openai-responses-via/openai-responses-event-builder.ts';
import type { OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';

const response = (status: OpenAIResponsesResult['status']): OpenAIResponsesResult => ({
  id: 'resp_test',
  object: 'response',
  model: 'test-model',
  output: [],
  status,
  error: null,
  incomplete_details: null,
});

test.each(['queued', 'in_progress', 'cancelled'] as const)('terminal builder rejects nonterminal status %s', status => {
  expect(() => terminal({ sequenceNumber: 0 }, response(status)))
    .toThrow(`Cannot emit a terminal OpenAI Responses event for status '${status}'`);
});
