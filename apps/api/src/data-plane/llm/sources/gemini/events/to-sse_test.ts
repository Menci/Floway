import { test } from 'vitest';

import { geminiProtocolFrameToSSEFrame } from './to-sse.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';

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
