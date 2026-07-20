import { expect, test } from 'vitest';

import { terminal } from './responses-event-builder.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

const response = (status: ResponsesResult['status']): ResponsesResult => ({
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
    .toThrow(`Cannot emit a terminal Responses event for status '${status}'`);
});
