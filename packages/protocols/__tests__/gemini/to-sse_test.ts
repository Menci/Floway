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

test('geminiProtocolFrameToSSEFrame serializes events without owning termination', () => {
  const first = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: 'Hello' }] },
      },
    ],
  } satisfies GeminiStreamEvent;
  const terminal = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: ' world' }] },
        finishReason: 'STOP',
      },
    ],
  } satisfies GeminiStreamEvent;
  const afterTerminal = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: ' ignored' }] },
      },
    ],
  } satisfies GeminiStreamEvent;

  const frames = [eventFrame(first), eventFrame(terminal), eventFrame(afterTerminal)].map(geminiProtocolFrameToSSEFrame).filter(frame => frame !== null);

  assertEquals(
    frames.map(frame => frame.data),
    [JSON.stringify(first), JSON.stringify(terminal), JSON.stringify(afterTerminal)],
  );
  assertEquals(
    frames.some(frame => frame.data === '[DONE]'),
    false,
  );
});
