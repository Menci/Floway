import { expect, test, vi } from 'vitest';

import { scalarToResponsesReasoningItem, toResponsesReasoningItem } from './reasoning.ts';
import type { ResponsesInputReasoning } from '@floway-dev/protocols/responses';

test('reasoning fallback IDs are generated only when an item needs one', () => {
  const random = vi.spyOn(crypto, 'getRandomValues');

  expect(scalarToResponsesReasoningItem<ResponsesInputReasoning>(undefined)).toBeNull();
  expect(toResponsesReasoningItem<ResponsesInputReasoning>({
    type: 'reasoning',
    id: 'rs_existing',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toBe('rs_existing');
  expect(random).not.toHaveBeenCalled();

  expect(toResponsesReasoningItem<ResponsesInputReasoning>({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toMatch(/^rs_[0-9a-f]{32}$/);
  expect(random).toHaveBeenCalledOnce();
});
