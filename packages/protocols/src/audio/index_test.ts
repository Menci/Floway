import { test } from 'vitest';

import { isAudioTranscriptionDoneEvent } from './index.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('isAudioTranscriptionDoneEvent recognizes only the transcription terminal', () => {
  assertEquals(isAudioTranscriptionDoneEvent({ type: 'transcript.text.done', text: 'complete' }), true);
  assertEquals(isAudioTranscriptionDoneEvent({ type: 'transcript.text.delta', delta: 'partial' }), false);
  assertEquals(isAudioTranscriptionDoneEvent('[DONE]'), false);
});
