import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import type { GeminiGenerateContentStreamEvent } from '../../src/gemini-generate-content/index.ts';
import { geminiGenerateContentProtocolFrameToSSEFrame } from '../../src/gemini-generate-content/to-sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('GenerateContent errors are compact bare JSON', () => {
  const error = { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } satisfies GeminiGenerateContentStreamEvent;
  assertEquals(geminiGenerateContentProtocolFrameToSSEFrame(eventFrame(error)), { type: 'sse-raw', data: JSON.stringify(error) });
});
