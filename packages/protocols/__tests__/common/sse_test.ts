import { expect, test } from 'vitest';

import { doneFrame, eventFrame, sseCommentFrame, sseFrame } from '../../src/common/sse.ts';

test('protocol frame constructors preserve their exact wire-neutral shapes', () => {
  expect([
    eventFrame({ type: 'message_stop' }),
    doneFrame(),
    sseFrame('{}', 'message_stop'),
    sseCommentFrame('keepalive'),
  ]).toEqual([
    { type: 'event', event: { type: 'message_stop' } },
    { type: 'done' },
    { type: 'sse', event: 'message_stop', data: '{}' },
    { type: 'sse-comment', comment: 'keepalive' },
  ]);
});
