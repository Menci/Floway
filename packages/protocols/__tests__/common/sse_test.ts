import { expect, test } from 'vitest';

import { doneFrame, eventFrame, sseCommentFrame, sseFrame } from '../../src/common/sse.ts';

test('eventFrame carries structured protocol events', () => {
  expect(eventFrame({ type: 'message_stop' })).toEqual({
    type: 'event',
    event: { type: 'message_stop' },
  });
});

test('doneFrame marks protocol sentinels without raw SSE text', () => {
  expect(doneFrame()).toEqual({ type: 'done' });
});

test('sseFrame preserves upstream payload shape', () => {
  expect(sseFrame('{}', 'message_stop')).toEqual({
    type: 'sse',
    event: 'message_stop',
    data: '{}',
  });
});

test('sseCommentFrame carries comment keepalive payloads', () => {
  expect(sseCommentFrame('keepalive')).toEqual({
    type: 'sse-comment',
    comment: 'keepalive',
  });
});
