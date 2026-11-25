import { expect, test } from 'vitest';

import { serializeSseFrame } from '../../../src/data-plane/shared/sse.ts';
import { sseFrame, sseRawFrame } from '@floway-dev/protocols/common';

test('SSE serialization emits a data field for every line of a named event', () => {
  const wire = serializeSseFrame(sseFrame('first\r\nsecond\r\n\nlast', 'message'));
  expect(wire).toBe('event: message\ndata: first\ndata: second\ndata: \ndata: last\n\n');
});

test('SSE serialization preserves a raw frame', () => {
  const data = '{"error":{"code":500,"status":"INTERNAL","message":"failure"}}';
  expect(serializeSseFrame(sseRawFrame(data))).toBe(data);
});
