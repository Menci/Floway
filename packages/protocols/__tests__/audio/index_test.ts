import { test } from 'vitest';

import { isAudioTranscriptionDoneEvent } from '../../src/audio/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('isAudioTranscriptionDoneEvent recognizes only the transcription terminal', () => {
  assertEquals(isAudioTranscriptionDoneEvent({ type: 'transcript.text.done', text: 'complete' }), true);
  assertEquals(isAudioTranscriptionDoneEvent({ type: 'transcript.text.delta', delta: 'partial' }), false);
  assertEquals(isAudioTranscriptionDoneEvent({ type: 'transcript.text.done' }), false);
  assertEquals(isAudioTranscriptionDoneEvent('[DONE]'), false);
});
