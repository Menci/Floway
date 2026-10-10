import { expect, test, vi } from 'vitest';

import { createOpenAIResponsesOutputOrderState, recordOpenAIResponsesOutputOrderEvent, shouldDeferForEarlierOpenAIResponsesOutput } from '../../../src/shared/via-openai-responses/openai-responses-stream-order.ts';

test('null additions do not track an item and null completion releases an earlier tracked index', () => {
  const state = createOpenAIResponsesOutputOrderState();
  const track = vi.fn(() => true);
  recordOpenAIResponsesOutputOrderEvent({ type: 'response.output_item.added', item: null, output_index: 0 }, state, track);
  expect(track).not.toHaveBeenCalled();
  expect(state.pendingOutputIndexes.size).toBe(0);
  recordOpenAIResponsesOutputOrderEvent({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1', summary: [] }, output_index: 0 }, state, track);
  const later = { type: 'response.output_text.delta' as const, delta: 'answer', output_index: 1, content_index: 0, item_id: 'msg_1' };
  expect(shouldDeferForEarlierOpenAIResponsesOutput(later, state)).toBe(true);
  recordOpenAIResponsesOutputOrderEvent({ type: 'response.output_item.done', item: null, output_index: 0 }, state, track);
  expect(shouldDeferForEarlierOpenAIResponsesOutput(later, state)).toBe(false);
});
