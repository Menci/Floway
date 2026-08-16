import { describe, expect, it } from 'vitest';

import {
  parseAudioTranscription,
  parseAudioTranscriptionResponseFormat,
  parseAudioTranscriptionUsage,
  renderAudioTranscription,
  type AudioTranscriptionResponseFormat,
} from '../../src/audio/index.ts';

const bytes = (document: string): Uint8Array => new TextEncoder().encode(document);

/** What a carried rendering says, and a failure where an object rendering came back
 *  instead — the two are never interchangeable and a test that read one as the other would
 *  pass on the wrong thing. */
const carried = (rendered: Record<string, unknown> | Uint8Array): string => {
  if (!(rendered instanceof Uint8Array)) throw new Error(`expected a carried document, got ${JSON.stringify(rendered)}`);
  return new TextDecoder().decode(rendered);
};

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

const carries = (format: AudioTranscriptionResponseFormat, document: string): string =>
  carried(renderAudioTranscription(format, parseAudioTranscription(format, bytes(document))));

describe('the renderings of a transcription', () => {
  it('is the protocol default when the form left the field out', () => {
    expect(parseAudioTranscriptionResponseFormat(undefined)).toBe('json');
    expect(() => parseAudioTranscriptionResponseFormat('yaml')).toThrow('response_format is invalid');
  });

  // The claim the family rests on: `response_format` travels to the upstream inside the
  // form, so the rendering an answer arrives in is the rendering it is written back in, and
  // reading then writing has to be the identity on every one of the six.
  it.each([
    ['json', JSON.stringify({ text: 'hello' })],
    ['verbose_json', JSON.stringify(VERBOSE)],
    ['diarized_json', JSON.stringify({ task: 'transcribe', duration: 2, text: 'Agent: hi', segments: [{ type: 'transcript.text.segment', id: 'seg_1', start: 0, end: 2, text: 'hi', speaker: 'agent' }] })],
    ['text', ' The beach was a popular spot.\n'],
    ['srt', SRT],
    ['vtt', VTT],
  ] as const)('reads and writes %s back unchanged', (format, document) => {
    const rendered = renderAudioTranscription(format, parseAudioTranscription(format, bytes(document)));
    expect(rendered instanceof Uint8Array ? carried(rendered) : JSON.stringify(rendered)).toBe(document);
  });

  // A document is carried and not reproduced, so what the upstream wrote survives every
  // convention it did not follow. Each of these is a byte a writer of ours would have
  // changed: the terminating blank line Whisper always writes, the ordinal it always starts
  // at 1, the line ending it always writes as `\n`, and the millisecond precision it always
  // pads to three digits.
  it.each([
    ['srt', '1\n00:00:00,000 --> 00:00:03,320\nno terminating blank line'],
    ['srt', '7\r\n00:00:00,000 --> 00:00:03,320\r\nnumbered from seven, with CRLF\r\n\r\n'],
    ['vtt', 'WEBVTT\n\n00:00.0 --> 00:03.32\nfewer fraction digits than Whisper writes\n\n'],
    ['text', 'a transcript with no trailing newline'],
  ] as const)('carries a %s document byte for byte, however it was written', (format, document) => {
    expect(carries(format, document)).toBe(document);
  });

  // What the canonical value holds is what its rendering carried, and the renderings are not
  // equally rich. This is the whole of why a rendering is never derived from a value read
  // out of a different one.
  it('holds a transcript and its cues where the rendering carried both', () => {
    expect(parseAudioTranscription('verbose_json', bytes(JSON.stringify(VERBOSE)))).toMatchObject({
      text: VERBOSE.text,
      cues: [{ start: 0, end: 3.32, text: ' The beach was a popular spot.' }],
    });
  });

  it('holds no cues where the rendering carried none', () => {
    expect(parseAudioTranscription('json', bytes(JSON.stringify({ text: 'hello' }))).cues).toBeUndefined();
  });

  // A subtitle document states the transcript only as its cues' texts, so the transcript on
  // the canonical value is rebuilt the way Whisper's own text writer rebuilds it and is not
  // claimed to be the string a `text` request would have returned.
  // https://github.com/openai/whisper/blob/v20250625/whisper/utils.py#L109-L116
  it('rebuilds the transcript of a subtitle document from its cues', () => {
    expect(parseAudioTranscription('srt', bytes(SRT)).text).toBe(' The beach was a popular spot.\n People were swimming in the ocean.');
  });

  it('refuses a body the rendering cannot be read from', () => {
    expect(() => parseAudioTranscription('json', bytes('{not-json'))).toThrow(SyntaxError);
    expect(() => parseAudioTranscription('json', bytes(JSON.stringify({ transcript: 'hello' })))).toThrow('text must be a string');
    expect(() => parseAudioTranscription('vtt', bytes(SRT))).toThrow('must open with WEBVTT');
  });

  // The other half of that refusal: a caller that could not read the body still has the body,
  // and what it writes back is what arrived. A 2xx nobody could parse is still the upstream's
  // answer to the client's request.
  it('writes back a body no reading could open', () => {
    expect(carried(renderAudioTranscription('json', { document: bytes('{not-json') }))).toBe('{not-json');
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

  // Nothing was stated, or what was stated is not something this reading names. A metric
  // invented after this was written is not a malformed one, and the caller bills neither.
  it('is no report where nothing this reading names was stated', () => {
    expect(parseAudioTranscriptionUsage({ text: 'hello' })).toBeUndefined();
    expect(parseAudioTranscriptionUsage({ usage: { type: 'credits', spent: 3 } })).toBeUndefined();
  });

  // An upstream that reported under a name this reading does know, in a shape it cannot read,
  // is a third situation and it says so — which is what lets the caller warn rather than
  // record the request as though the upstream had metered nothing.
  it('reports a block it names and cannot read, rather than reading it as nothing', () => {
    expect(() => parseAudioTranscriptionUsage({ usage: { type: 'duration', seconds: 'invalid' } }))
      .toThrow('usage.seconds must be a finite non-negative number');
    expect(() => parseAudioTranscriptionUsage({ usage: { type: 'tokens', input_tokens: -1, output_tokens: 2 } }))
      .toThrow('usage.input_tokens must be a non-negative safe integer');
    expect(() => parseAudioTranscriptionUsage({ usage: { type: 'tokens', input_tokens: 4, input_token_details: { audio_tokens: 9 }, output_tokens: 2 } }))
      .toThrow('audio_tokens must not exceed usage.input_tokens');
    expect(() => parseAudioTranscriptionUsage({ usage: 'billed' })).toThrow('usage must be an object');
    expect(() => parseAudioTranscriptionUsage({ duration: 'a while' })).toThrow('duration must be a finite non-negative number');
  });
});
