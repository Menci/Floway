// The one transcription, and the several documents that are renderings of it.
//
// `response_format` picks a rendering, and it travels to the upstream in the form the client
// sent, so the rendering the client asked for is the rendering the upstream answers in. That
// is what makes one canonical value enough: whichever rendering arrived is the one that goes
// back, and no rendering is ever derived from a value read out of a different one.
//
// A document rendering is **carried**, never written again. `text`, `srt` and `vtt` are
// documents the upstream wrote for the client to read, and re-writing one from what we read
// out of it changes bytes nobody asked to have changed: a cue writer of our own terminates
// the last cue with a blank line the upstream may not have written, renumbers a SubRip cue
// the upstream numbered from something else, and rounds a timestamp to its own precision. So
// the canonical value holds the bytes that arrived and hands them straight back, and what it
// reads out of them is what the record shows and what usage is measured from.
//
// Which is as well, because the renderings are not equally rich. `verbose_json` carries a
// whole transcript and its cues; `json` carries the transcript with usage beside it; `srt`
// and `vtt` carry the cues alone; `text` carries the transcript alone and nothing else at
// all. Those are properties of the renderings, not gaps in the reading.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L745

import type { OpenAIAudioTranscriptionCue } from './subtitles.ts';
import { parseSubtitleDocument } from './subtitles.ts';

// `diarized_json` joined the enum with `gpt-4o-transcribe-diarize`; it is a JSON rendering
// and needs nothing of its own here.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L28527-L28545
export const OPENAI_AUDIO_TRANSCRIPTION_RESPONSE_FORMATS = ['json', 'text', 'srt', 'verbose_json', 'vtt', 'diarized_json'] as const;
export type OpenAIAudioTranscriptionResponseFormat = typeof OPENAI_AUDIO_TRANSCRIPTION_RESPONSE_FORMATS[number];

/** The form field is optional and the protocol's own default is `json`. */
export const parseOpenAIAudioTranscriptionResponseFormat = (value: unknown): OpenAIAudioTranscriptionResponseFormat => {
  if (value === undefined) return 'json';
  if (typeof value === 'string' && (OPENAI_AUDIO_TRANSCRIPTION_RESPONSE_FORMATS as readonly string[]).includes(value)) {
    return value as OpenAIAudioTranscriptionResponseFormat;
  }
  throw new Error(`OpenAI Audio Transcriptions response_format is invalid: ${JSON.stringify(value)}`);
};

/** A JSON rendering answers with an object; `text`, `srt` and `vtt` answer with a document.
 *  The split decides how the body is read and written, and it is the whole of what the
 *  response format decides for a non-streaming answer. */
export type OpenAIAudioTranscriptionObjectFormat = 'json' | 'verbose_json' | 'diarized_json';

export const isOpenAIAudioTranscriptionObjectFormat = (
  format: OpenAIAudioTranscriptionResponseFormat,
): format is OpenAIAudioTranscriptionObjectFormat =>
  format === 'json' || format === 'verbose_json' || format === 'diarized_json';

/** Token-billed and duration-billed models report usage under one discriminated key. A
 *  transcription answered in `text`, `srt` or `vtt` reports none, because those renderings
 *  cannot express it. */
export type OpenAIAudioTranscriptionUsage =
  | {
    readonly kind: 'tokens';
    readonly inputTokens: number;
    /** Split out of `inputTokens` when the upstream broke it down, because audio input is
     *  priced apart from text input. */
    readonly inputAudioTokens?: number;
    readonly outputTokens: number;
  }
  | { readonly kind: 'duration'; readonly seconds: number };

export interface CanonicalOpenAIAudioTranscription {
  /** What the upstream sent, byte for byte. Every rendering but the objects is written back
   *  from this, and so is a body the reading below could not open.
   *
   *  Bytes rather than a string, because a decode is a reading like any other: a document
   *  under a charset nothing here asked about survives being carried and does not survive
   *  being decoded and encoded again. */
  readonly document: Uint8Array;
  /** The whole transcript, as the rendering stated it. A subtitle document does not carry
   *  one, so for `srt` and `vtt` this is the cues' texts joined by newlines — which is what
   *  Whisper's own text writer produces from the same result, and is not the string a `text`
   *  request would have returned. Absent on a document the reading could not open.
   *  https://github.com/openai/whisper/blob/v20250625/whisper/utils.py#L109-L116 */
  readonly text?: string;
  /** The timed cues. This is the whole of `srt` and `vtt`; `verbose_json` and
   *  `diarized_json` carry the same thing as `segments`. */
  readonly cues?: readonly OpenAIAudioTranscriptionCue[];
  /** The upstream's own object, kept whole for the renderings that are objects. A JSON
   *  answer is re-serialized from this, so a field this type does not name — a segment's
   *  `avg_logprob`, a `logprobs` array, a `speaker` label — reaches the client unchanged,
   *  and it is also what usage is read out of. */
  readonly raw?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const seconds = (value: unknown, where: string): number => {
  if (!isFiniteNumber(value) || value < 0) throw new Error(`OpenAI Audio Transcriptions ${where} must be a finite non-negative number`);
  return value;
};

const count = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`OpenAI Audio Transcriptions ${where} must be a non-negative safe integer`);
  }
  return value;
};

/**
 * What the upstream said it will bill for.
 *
 * `undefined` is "nothing this reading recognizes was stated": no report at all, or one under
 * a discriminator this protocol does not name — a metric invented after this was written is
 * not a malformed one. A report that *is* one of the two and cannot be read is the other
 * situation entirely, and it throws, so the caller can say so rather than bill an upstream
 * that did meter as though it had not.
 *
 * Whisper's `verbose_json` predates the `usage` block and states the same duration at the top
 * level, so that is read where no block is present.
 * https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36513-L36545
 * https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L61968-L62051
 */
export const parseOpenAIAudioTranscriptionUsage = (value: unknown): OpenAIAudioTranscriptionUsage | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.usage === undefined) {
    if (value.duration === undefined) return undefined;
    return { kind: 'duration', seconds: seconds(value.duration, 'duration') };
  }
  const usage = value.usage;
  if (!isRecord(usage)) throw new Error('OpenAI Audio Transcriptions usage must be an object');
  if (usage.type === 'duration') return { kind: 'duration', seconds: seconds(usage.seconds, 'usage.seconds') };
  if (usage.type !== 'tokens') return undefined;

  const inputTokens = count(usage.input_tokens, 'usage.input_tokens');
  const outputTokens = count(usage.output_tokens, 'usage.output_tokens');
  const details = usage.input_token_details;
  if (details !== undefined && !isRecord(details)) throw new Error('OpenAI Audio Transcriptions usage.input_token_details must be an object');
  const audioTokens = details?.audio_tokens === undefined
    ? undefined
    : count(details.audio_tokens, 'usage.input_token_details.audio_tokens');
  if (audioTokens !== undefined && audioTokens > inputTokens) {
    throw new Error('OpenAI Audio Transcriptions usage.input_token_details.audio_tokens must not exceed usage.input_tokens');
  }
  return {
    kind: 'tokens',
    inputTokens,
    ...(audioTokens === undefined ? {} : { inputAudioTokens: audioTokens }),
    outputTokens,
  };
};

const requiredText = (value: unknown, where: string): string => {
  if (typeof value !== 'string') throw new Error(`OpenAI Audio Transcriptions ${where} must be a string`);
  return value;
};

/** `verbose_json` and `diarized_json` both time their segments with seconds and text; the
 *  fields they do not share stay in `raw` and reach the client through it. */
const objectCues = (value: Record<string, unknown>): readonly OpenAIAudioTranscriptionCue[] | undefined => {
  if (!Array.isArray(value.segments)) return undefined;
  return value.segments.map((segment: unknown, index) => {
    if (!isRecord(segment) || !isFiniteNumber(segment.start) || !isFiniteNumber(segment.end)) {
      throw new Error(`OpenAI Audio Transcriptions segment ${index} must carry numeric start and end`);
    }
    return { start: segment.start, end: segment.end, text: requiredText(segment.text, `segment ${index} text`) };
  });
};

/**
 * The one reading, over the bytes the upstream sent.
 *
 * It throws on a body it cannot open, and a caller that carries the document rather than
 * serializing one from what it read answers anyway: what a failed reading costs is the
 * transcript in the record and the usage measured beside it, never the answer.
 */
export const parseOpenAIAudioTranscription = (
  format: OpenAIAudioTranscriptionResponseFormat,
  document: Uint8Array,
): CanonicalOpenAIAudioTranscription => {
  const decoded = new TextDecoder().decode(document);
  if (isOpenAIAudioTranscriptionObjectFormat(format)) {
    const body: unknown = JSON.parse(decoded);
    if (!isRecord(body)) throw new Error('OpenAI Audio Transcriptions response body must be an object');
    const cues = objectCues(body);
    return {
      document,
      text: requiredText(body.text, 'text'),
      ...(cues === undefined ? {} : { cues }),
      raw: body,
    };
  }
  if (format === 'text') return { document, text: decoded };
  const cues = parseSubtitleDocument(format, decoded);
  return { document, text: cues.map(cue => cue.text).join('\n'), cues };
};

/**
 * The one writing, back into the rendering the client asked for.
 *
 * An object rendering is the upstream's own object re-serialized, which is what keeps a field
 * this protocol does not name on its way to the client. Everything else is the document that
 * arrived, handed back untouched — and so is an object rendering whose body the reading could
 * not open, because bytes nobody could read are still the answer the upstream gave.
 */
export const renderOpenAIAudioTranscription = (
  format: OpenAIAudioTranscriptionResponseFormat,
  transcription: CanonicalOpenAIAudioTranscription,
): Record<string, unknown> | Uint8Array =>
  isOpenAIAudioTranscriptionObjectFormat(format) && transcription.raw !== undefined
    ? transcription.raw
    : transcription.document;
