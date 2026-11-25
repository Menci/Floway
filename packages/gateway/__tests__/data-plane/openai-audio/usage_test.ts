import { expect, test, vi } from 'vitest';

import { measureOpenAIAudioTranscriptionsResult, measureOpenAIAudioTranscriptionUsage, openaiAudioTranscriptionUsageMeasurement } from '../../../src/data-plane/openai-audio/usage.ts';
import { toProviderModelFact } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

test('audio transcription usage preserves duration seconds as a base-unit metric', () => {
  assertEquals(openaiAudioTranscriptionUsageMeasurement({
    usage: { type: 'duration', seconds: 91 },
    duration: 91.8,
  }), {
    ok: true,
    value: {
      quantities: { input_audio_seconds: '91' },
      pricingFacts: {},
      dumpTokenUsage: null,
    },
  });
});

test('audio transcription usage reads Whisper verbose JSON duration', () => {
  assertEquals(openaiAudioTranscriptionUsageMeasurement({
    task: 'transcribe',
    duration: 91.8,
    text: 'hello',
  }), {
    ok: true,
    value: {
      quantities: { input_audio_seconds: '91.8' },
      pricingFacts: {},
      dumpTokenUsage: null,
    },
  });
});

test('audio transcription usage accepts partial details and leaves unclassified input general', () => {
  for (const [input_token_details, quantities] of [
    [{ text_tokens: 4 }, { input_tokens: '14', output_tokens: '45' }],
    [{ audio_tokens: 10 }, { input_tokens: '4', input_audio_tokens: '10', output_tokens: '45' }],
  ] as const) {
    expect(openaiAudioTranscriptionUsageMeasurement({
      usage: { type: 'tokens', input_tokens: 14, input_token_details, output_tokens: 45, total_tokens: 59 },
    })).toMatchObject({ ok: true, value: { quantities } });
  }
});

test('audio transcription usage rejects malformed declared metrics', () => {
  for (const [body, message] of [
    [{ duration: '10' }, 'duration must be'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 58 } }, 'total_tokens must equal'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 6, audio_tokens: 9 }, output_tokens: 45, total_tokens: 59 } }, 'input_token_details must not exceed'],
  ] as const) {
    expect(openaiAudioTranscriptionUsageMeasurement(body)).toEqual({ ok: false, error: expect.stringContaining(message) });
  }
});

test('audio transcription usage propagates defects while measuring the provider response', () => {
  const defect = new TypeError('unexpected usage access');
  const body = { get usage() { throw defect; } };
  expect(() => measureOpenAIAudioTranscriptionUsage(body, '/audio/transcriptions')).toThrow(defect);
});

test('audio transcription usage ignores invalid JSON and propagates a parser defect', () => {
  const bytes = new TextEncoder().encode('{');
  const context = {
    candidate: {
      upstream: { id: 'upstream', name: 'Provider', kind: 'custom' as const, config: {} },
      model: toProviderModelFact(stubProviderModel({ kind: 'transcription' })),
    },
    http: { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']] as const, body: null },
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const defect = new TypeError('unexpected JSON parser failure');
  const parse = vi.spyOn(JSON, 'parse');
  try {
    expect(measureOpenAIAudioTranscriptionsResult(bytes, context)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    parse.mockImplementationOnce(() => { throw defect; });
    expect(() => measureOpenAIAudioTranscriptionsResult(bytes, context)).toThrow(defect);
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    parse.mockRestore();
    warn.mockRestore();
  }
});
