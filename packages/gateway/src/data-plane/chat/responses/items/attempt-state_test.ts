import { expect, test } from 'vitest';

import { ResponsesItemState } from './attempt-state.ts';

test('attempt-private payload and output identity are request scoped', () => {
  const state = new ResponsesItemState();
  state.begin(new Map([['item', { first: true }]]), { upstreamId: 'upstream-a', restoresItemIds: true });

  expect(state.getPrivatePayload('item')).toEqual({ first: true });
  expect(state.outputItemSource('rs_upstream')).toEqual({
    upstreamId: 'upstream-a',
    upstreamItemId: 'rs_upstream',
  });

  state.setPrivatePayload('ws_gw_synthetic', { value: 2 });
  expect(state.getPrivatePayload('ws_gw_synthetic')).toEqual({ value: 2 });
  expect(state.outputItemSource('ws_gw_synthetic')).toBeNull();
  expect(state.outputItemSource('rs_tmp_0000000000000000000000')).toBeNull();

  state.begin(new Map(), { upstreamId: 'upstream-b', restoresItemIds: false });
  expect(state.getPrivatePayload('item')).toBeUndefined();
  expect(state.outputItemSource('rs_upstream')).toBeNull();
});
