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

test('GenerateContent errors are compact bare JSON', () => {
  const error = { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } satisfies GeminiGenerateContentStreamEvent;
  assertEquals(geminiGenerateContentProtocolFrameToSSEFrame(eventFrame(error)), { type: 'sse-raw', data: JSON.stringify(error) });
});
