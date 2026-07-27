import { test } from 'vitest';

import { audioTranscriptionUsageMeasurement } from '../../../src/data-plane/audio/usage.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('audio transcription usage preserves duration seconds as a base-unit metric', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: { type: 'duration', seconds: 91 },
    duration: 91.8,
  }), {
    quantities: { input_audio_seconds: '91' },
    pricingFacts: {},
    dumpTokenUsage: null,
  });
});

test('audio transcription usage reads Whisper verbose JSON duration', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    task: 'transcribe',
    duration: 91.8,
    text: 'hello',
  }), {
    quantities: { input_audio_seconds: '91.8' },
    pricingFacts: {},
    dumpTokenUsage: null,
  });
});

test('audio transcription usage maps text and audio input token details to disjoint metrics', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: {
      type: 'tokens',
      input_tokens: 14,
      input_token_details: { text_tokens: 4, audio_tokens: 10 },
      output_tokens: 45,
      total_tokens: 59,
    },
  }), {
    quantities: { input_tokens: '4', input_audio_tokens: '10', output_tokens: '45' },
    pricingFacts: { inputTokens: 14 },
    dumpTokenUsage: { input: 14, output: 45 },
  });
});

test('audio transcription usage keeps aggregate input tokens general when details are absent', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 59 },
  }).quantities, { input_tokens: '14', output_tokens: '45' });
});

test('audio transcription usage accepts partial details and leaves unclassified input general', () => {
  for (const [input_token_details, quantities] of [
    [{}, { input_tokens: '14', output_tokens: '45' }],
    [{ text_tokens: 4 }, { input_tokens: '14', output_tokens: '45' }],
    [{ audio_tokens: 10 }, { input_tokens: '4', input_audio_tokens: '10', output_tokens: '45' }],
  ] as const) {
    assertEquals(audioTranscriptionUsageMeasurement({
      usage: { type: 'tokens', input_tokens: 14, input_token_details, output_tokens: 45, total_tokens: 59 },
    }).quantities, quantities);
  }
});

test('audio transcription usage without a recognized metric is request-only', () => {
  for (const body of [
    { usage: { seconds: 10 } },
    { usage: { type: 'future_metric', samples: 10 } },
  ]) {
    assertEquals(audioTranscriptionUsageMeasurement(body), {
      quantities: {}, pricingFacts: {}, dumpTokenUsage: null,
    });
  }
});

test('audio transcription usage rejects malformed declared metrics', () => {
  for (const [body, message] of [
    [{ duration: '10' }, 'duration must be'],
    [{ usage: null }, 'usage must be an object'],
    [{ usage: 'tokens' }, 'usage must be an object'],
    [{ usage: { type: 'duration' } }, 'duration usage.seconds'],
    [{ usage: { type: 'duration', seconds: '10' } }, 'duration usage.seconds'],
    [{ usage: { type: 'tokens', input_tokens: -1, output_tokens: 45, total_tokens: 44 } }, 'token usage.input_tokens'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: Number.NaN, total_tokens: 59 } }, 'token usage.output_tokens'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: '59' } }, 'token usage.total_tokens'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 58 } }, 'total_tokens must equal'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: null, output_tokens: 45, total_tokens: 59 } }, 'input_token_details must be an object'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 4, audio_tokens: '10' }, output_tokens: 45, total_tokens: 59 } }, 'audio_tokens must be'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 6, audio_tokens: 9 }, output_tokens: 45, total_tokens: 59 } }, 'input_token_details must not exceed'],
  ] as const) {
    assertThrows(() => audioTranscriptionUsageMeasurement(body), Error, message);
  }
});
