import { describe, expect, it } from 'vitest';

import {
  parseAudioTranscription,
  parseAudioTranscriptionResponseFormat,
  parseAudioTranscriptionUsage,
  renderAudioTranscription,
} from '../../src/audio/index.ts';

// Whisper's own writers, which is what `whisper-1` runs: SubRip numbers its cues and always
// writes the hour component, WebVTT opens with its signature and drops the hour component
// below one hour, and both terminate every cue with a blank line.
// https://github.com/openai/whisper/blob/v20250625/whisper/utils.py#L238-L262
const SRT = '1\n00:00:00,000 --> 00:00:03,320\n The beach was a popular spot.\n\n'
  + '2\n00:00:03,320 --> 00:00:08,470\n People were swimming in the ocean.\n\n';
const VTT = 'WEBVTT\n\n00:00.000 --> 00:03.320\n The beach was a popular spot.\n\n'
  + '00:03.320 --> 00:08.470\n People were swimming in the ocean.\n\n';

const VERBOSE = {
  task: 'transcribe',
  language: 'english',
  duration: 8.47,
  text: ' The beach was a popular spot. People were swimming in the ocean.',
  segments: [
    { id: 0, seek: 0, start: 0, end: 3.32, text: ' The beach was a popular spot.', tokens: [50364], temperature: 0, avg_logprob: -0.28, compression_ratio: 1.23, no_speech_prob: 0.009 },
  ],
};

describe('the renderings of a transcription', () => {
  it('is the protocol default when the form left the field out', () => {
    expect(parseAudioTranscriptionResponseFormat(undefined)).toBe('json');
    expect(() => parseAudioTranscriptionResponseFormat('yaml')).toThrow('response_format is invalid');
  });

  // The claim the family rests on: `response_format` travels to the upstream inside the
  // form, so the rendering an answer arrives in is the rendering it is written back in, and
  // reading then writing has to be the identity on every one of the six.
  it.each([
    ['json', { text: 'hello' }],
    ['verbose_json', VERBOSE],
    ['diarized_json', { task: 'transcribe', duration: 2, text: 'Agent: hi', segments: [{ type: 'transcript.text.segment', id: 'seg_1', start: 0, end: 2, text: 'hi', speaker: 'agent' }] }],
    ['text', ' The beach was a popular spot.\n'],
    ['srt', SRT],
    ['vtt', VTT],
  ] as const)('reads and writes %s back unchanged', (format, body) => {
    expect(renderAudioTranscription(format, parseAudioTranscription(format, body))).toEqual(body);
  });

  // What the canonical value holds is what its rendering carried, and the renderings are not
  // equally rich. This is the whole of why a rendering is never derived from a value read
  // out of a different one.
  it('holds a transcript and its cues where the rendering carried both', () => {
    expect(parseAudioTranscription('verbose_json', VERBOSE)).toMatchObject({
      text: VERBOSE.text,
      cues: [{ start: 0, end: 3.32, text: ' The beach was a popular spot.' }],
    });
  });

  it('holds no cues where the rendering carried none, so no subtitle can be written from it', () => {
    const fromJson = parseAudioTranscription('json', { text: 'hello' });
    expect(fromJson.cues).toBeUndefined();
    expect(() => renderAudioTranscription('srt', fromJson)).toThrow('carries no cues');
  });

  // A subtitle document states the transcript only as its cues' texts, so the transcript on
  // the canonical value is rebuilt the way Whisper's own text writer rebuilds it and is not
  // claimed to be the string a `text` request would have returned.
  // https://github.com/openai/whisper/blob/v20250625/whisper/utils.py#L109-L116
  it('rebuilds the transcript of a subtitle document from its cues', () => {
    expect(parseAudioTranscription('srt', SRT).text).toBe(' The beach was a popular spot.\n People were swimming in the ocean.');
  });

  it('cannot write a JSON rendering from a value that was not read from an object', () => {
    expect(() => renderAudioTranscription('json', parseAudioTranscription('text', 'hello'))).toThrow('not read from an object');
  });

  it('refuses a body the rendering cannot be read from', () => {
    expect(() => parseAudioTranscription('json', { transcript: 'hello' })).toThrow('text must be a string');
    expect(() => parseAudioTranscription('vtt', SRT)).toThrow('must open with WEBVTT');
  });
});

describe('what a transcription says it will be billed for', () => {
  it('splits the audio share out of the input tokens the upstream broke down', () => {
    expect(parseAudioTranscriptionUsage({
      usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 10, audio_tokens: 4 }, output_tokens: 101, total_tokens: 115 },
    })).toEqual({ kind: 'tokens', inputTokens: 14, inputAudioTokens: 4, outputTokens: 101 });
  });

  it('reads a duration report, and whisper\'s top-level duration where there is no report', () => {
    expect(parseAudioTranscriptionUsage({ usage: { type: 'duration', seconds: 43 } })).toEqual({ kind: 'duration', seconds: 43 });
    expect(parseAudioTranscriptionUsage(VERBOSE)).toEqual({ kind: 'duration', seconds: 8.47 });
  });

  // A report that cannot be read is, from here, no report — which the caller states by
  // naming the billed entity with no quantities rather than by naming zero.
  it('is no report where the shape is not one the protocol names', () => {
    expect(parseAudioTranscriptionUsage({ text: 'hello' })).toBeUndefined();
    expect(parseAudioTranscriptionUsage({ usage: { type: 'tokens', input_tokens: -1, output_tokens: 2 } })).toBeUndefined();
    expect(parseAudioTranscriptionUsage({ usage: { type: 'credits', spent: 3 } })).toBeUndefined();
  });
});
