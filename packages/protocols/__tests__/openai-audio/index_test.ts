import { test } from 'vitest';

import { isOpenAIAudioTranscriptionDoneEvent } from '../../src/openai-audio/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('isOpenAIAudioTranscriptionDoneEvent recognizes only the transcription terminal', () => {
  assertEquals(isOpenAIAudioTranscriptionDoneEvent({ type: 'transcript.text.done', text: 'complete' }), true);
  assertEquals(isOpenAIAudioTranscriptionDoneEvent({ type: 'transcript.text.delta', delta: 'partial' }), false);
  assertEquals(isOpenAIAudioTranscriptionDoneEvent({ type: 'transcript.text.done' }), false);
  assertEquals(isOpenAIAudioTranscriptionDoneEvent('[DONE]'), false);
});
