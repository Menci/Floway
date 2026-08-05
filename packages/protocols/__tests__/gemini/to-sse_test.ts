import { test } from 'vitest';

import { doneFrame, eventFrame } from '../../src/common/index.ts';
import type { GeminiStreamEvent } from '../../src/gemini/index.ts';
import { geminiProtocolFrameToSSEFrame } from '../../src/gemini/to-sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('geminiProtocolFrameToSSEFrame emits data-only JSON chunks', () => {
  const chunk = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: 'Hello' }] },
      },
    ],
    modelVersion: 'gemini-test',
  } satisfies GeminiStreamEvent;

  const frames = [eventFrame(chunk), doneFrame()].map(geminiProtocolFrameToSSEFrame).filter(frame => frame !== null);

  assertEquals(frames, [
    {
      type: 'sse',
      event: undefined,
      data: JSON.stringify(chunk),
    },
  ]);
});
