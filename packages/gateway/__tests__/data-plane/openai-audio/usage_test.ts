import { test } from 'vitest';

import { openaiAudioTranscriptionUsageMeasurement } from '../../../src/data-plane/openai-audio/usage.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('audio transcription usage preserves duration seconds as a base-unit metric', () => {
  assertEquals(openaiAudioTranscriptionUsageMeasurement({
    usage: { type: 'duration', seconds: 91 },
    duration: 91.8,
  }), {
    quantities: { input_audio_seconds: '91' },
    pricingFacts: {},
    dumpTokenUsage: null,
  });
});

test('audio transcription usage reads Whisper verbose JSON duration', () => {
  assertEquals(openaiAudioTranscriptionUsageMeasurement({
    task: 'transcribe',
    duration: 91.8,
    text: 'hello',
  }), {
    quantities: { input_audio_seconds: '91.8' },
    pricingFacts: {},
    dumpTokenUsage: null,
  });
});

test('audio transcription usage accepts partial details and leaves unclassified input general', () => {
  for (const [input_token_details, quantities] of [
    [{ text_tokens: 4 }, { input_tokens: '14', output_tokens: '45' }],
    [{ audio_tokens: 10 }, { input_tokens: '4', input_audio_tokens: '10', output_tokens: '45' }],
  ] as const) {
    assertEquals(openaiAudioTranscriptionUsageMeasurement({
      usage: { type: 'tokens', input_tokens: 14, input_token_details, output_tokens: 45, total_tokens: 59 },
    }).quantities, quantities);
  }
});

test('audio transcription usage rejects malformed declared metrics', () => {
  for (const [body, message] of [
    [{ duration: '10' }, 'duration must be'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 58 } }, 'total_tokens must equal'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 6, audio_tokens: 9 }, output_tokens: 45, total_tokens: 59 } }, 'input_token_details must not exceed'],
  ] as const) {
    assertThrows(() => openaiAudioTranscriptionUsageMeasurement(body), Error, message);
  }
});
