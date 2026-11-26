import { expect, test } from 'vitest';

import { serializeSseFrame } from '../../../src/data-plane/shared/sse.ts';
import { sseFrame } from '@floway-dev/protocols/common';

test('SSE serialization emits a data field for every line of a named event', () => {
  const wire = serializeSseFrame(sseFrame('first\r\nsecond\r\n\nlast', 'message'));
  expect(wire).toBe('event: message\ndata: first\ndata: second\ndata: \ndata: last\n\n');
});
