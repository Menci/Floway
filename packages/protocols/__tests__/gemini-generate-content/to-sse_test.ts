import { test } from 'vitest';

import { doneFrame, eventFrame } from '../../src/common/index.ts';
import type { GeminiGenerateContentStreamEvent } from '../../src/gemini-generate-content/index.ts';
import { geminiGenerateContentProtocolFrameToSSEFrame } from '../../src/gemini-generate-content/to-sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('geminiGenerateContentProtocolFrameToSSEFrame emits data-only JSON chunks', () => {
  const chunk = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: 'Hello' }] },
      },
    ],
    modelVersion: 'gemini-test',
  } satisfies GeminiGenerateContentStreamEvent;

  const frames = [eventFrame(chunk), doneFrame()].map(geminiGenerateContentProtocolFrameToSSEFrame).filter(frame => frame !== null);

  assertEquals(frames, [
    {
      type: 'sse',
      event: undefined,
      data: JSON.stringify(chunk),
    },
  ]);
});

test('geminiGenerateContentProtocolFrameToSSEFrame serializes events without owning termination', () => {
  const first = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: 'Hello' }] },
      },
    ],
  } satisfies GeminiGenerateContentStreamEvent;
  const terminal = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: ' world' }] },
        finishReason: 'STOP',
      },
    ],
  } satisfies GeminiGenerateContentStreamEvent;
  const afterTerminal = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: ' ignored' }] },
      },
    ],
  } satisfies GeminiGenerateContentStreamEvent;

  const frames = [eventFrame(first), eventFrame(terminal), eventFrame(afterTerminal)].map(geminiGenerateContentProtocolFrameToSSEFrame).filter(frame => frame !== null);

  assertEquals(
    frames.map(frame => frame.data),
    [JSON.stringify(first), JSON.stringify(terminal), JSON.stringify(afterTerminal)],
  );
  assertEquals(
    frames.some(frame => frame.data === '[DONE]'),
    false,
  );
});
