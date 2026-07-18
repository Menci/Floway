import { expect, test } from 'vitest';

import { ResponsesAttemptState } from './attempt-state.ts';

test('attempt-private payload is request scoped', () => {
  const state = new ResponsesAttemptState();
  state.begin(new Map([['item', { first: true }]]), new Map([['item', 'item_upstream']]));
  state.setPrivatePayload('second', { value: 2 });
  expect(state.getPrivatePayload('item')).toBeUndefined();
  expect(state.getPrivatePayload('item_upstream')).toEqual({ first: true });
  expect(state.getPrivatePayload('second')).toEqual({ value: 2 });
  state.begin(new Map(), new Map());
  expect(state.getPrivatePayload('item_upstream')).toBeUndefined();
});
