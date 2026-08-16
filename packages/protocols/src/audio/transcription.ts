// The one transcription, and the several documents that are renderings of it.
//
// `response_format` picks a rendering, and it travels to the upstream in the form the
// client sent, so the rendering the client asked for is the rendering the upstream answers
// in. That is what makes one canonical value enough: the gateway reads whichever document
// arrived and writes the same one back, and no rendering is ever derived from a value that
// was read out of a different one.
//
// Which is as well, because the renderings are not equally rich. `verbose_json` carries a
// whole transcript and its cues; `json` carries the transcript with usage beside it; `srt`
// and `vtt` carry the cues alone; `text` carries the transcript alone and nothing else at
// all. So a `srt` answer holds no `language`, no `duration` and no usage, and its transcript
// exists only as the cues' texts. Those are properties of the renderings, not gaps in the
// reading.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L745

import type { AudioTranscriptionCue } from './subtitles.ts';
import { parseSubtitleDocument, renderSubtitleDocument } from './subtitles.ts';

// `diarized_json` joined the enum with `gpt-4o-transcribe-diarize`; it is a JSON rendering
// and needs nothing of its own here.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L28527-L28545
export const AUDIO_TRANSCRIPTION_RESPONSE_FORMATS = ['json', 'text', 'srt', 'verbose_json', 'vtt', 'diarized_json'] as const;
export type AudioTranscriptionResponseFormat = typeof AUDIO_TRANSCRIPTION_RESPONSE_FORMATS[number];

/** The form field is optional and the protocol's own default is `json`. */
export const parseAudioTranscriptionResponseFormat = (value: unknown): AudioTranscriptionResponseFormat => {
  if (value === undefined) return 'json';
  if (typeof value === 'string' && (AUDIO_TRANSCRIPTION_RESPONSE_FORMATS as readonly string[]).includes(value)) {
    return value as AudioTranscriptionResponseFormat;
  }
  throw new Error(`Audio transcription response_format is invalid: ${JSON.stringify(value)}`);
};

/** A JSON rendering answers with an object; `text`, `srt` and `vtt` answer with a document.
 *  The split decides how the body is read and written, and it is the whole of what the
 *  response format decides for a non-streaming answer. */
export type AudioTranscriptionObjectFormat = 'json' | 'verbose_json' | 'diarized_json';

export const isAudioTranscriptionObjectFormat = (
  format: AudioTranscriptionResponseFormat,
): format is AudioTranscriptionObjectFormat =>
  format === 'json' || format === 'verbose_json' || format === 'diarized_json';

/** Token-billed and duration-billed models report usage under one discriminated key. A
 *  transcription answered in `text`, `srt` or `vtt` reports none, because those renderings
 *  cannot express it. */
export type AudioTranscriptionUsage =
  | {
    readonly kind: 'tokens';
    readonly inputTokens: number;
    /** Split out of `inputTokens` when the upstream broke it down, because audio input is
     *  priced apart from text input. */
    readonly inputAudioTokens?: number;
    readonly outputTokens: number;
  }
  | { readonly kind: 'duration'; readonly seconds: number };

export interface CanonicalAudioTranscription {
  /** The whole transcript. A subtitle document does not carry one, so for `srt` and `vtt`
   *  this is the cues' texts joined by newlines — which is what Whisper's own text writer
   *  produces from the same result, and is not claimed to be byte-identical to what a
   *  `text` request would have returned.
   *  https://github.com/openai/whisper/blob/v20250625/whisper/utils.py#L109-L116 */
  readonly text: string;
  /** The timed cues. This is the whole of `srt` and `vtt`; `verbose_json` and
   *  `diarized_json` carry the same thing as `segments`. */
  readonly cues?: readonly AudioTranscriptionCue[];
  /** The upstream's own object, kept whole for the renderings that are objects. A JSON
   *  answer is re-serialized from this, so a field this type does not name — a segment's
   *  `avg_logprob`, a `logprobs` array, a `speaker` label — reaches the client unchanged. */
  readonly raw?: Record<string, unknown>;
  readonly usage?: AudioTranscriptionUsage;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * What the upstream said it will bill for, or `undefined` when it said nothing this reading
 * recognizes. There is no third answer: a report that cannot be read is, from here, no
 * report, and the caller says so by naming the entity with no quantities.
 *
 * Whisper's `verbose_json` predates the `usage` block and states the same duration at the
 * top level, so that is read where no block is present.
 * https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36513-L36545
 * https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L61968-L62051
 */
export const parseAudioTranscriptionUsage = (value: unknown): AudioTranscriptionUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const usage = value.usage;
  if (!isRecord(usage)) {
    return isFiniteNumber(value.duration) && value.duration >= 0
      ? { kind: 'duration', seconds: value.duration }
      : undefined;
  }
  if (usage.type === 'duration') {
    return isFiniteNumber(usage.seconds) && usage.seconds >= 0 ? { kind: 'duration', seconds: usage.seconds } : undefined;
  }
  if (usage.type !== 'tokens' || !isCount(usage.input_tokens) || !isCount(usage.output_tokens)) return undefined;
  const details = usage.input_token_details;
  const audioTokens = isRecord(details) && isCount(details.audio_tokens) ? details.audio_tokens : undefined;
  if (audioTokens !== undefined && audioTokens > usage.input_tokens) return undefined;
  return {
    kind: 'tokens',
    inputTokens: usage.input_tokens,
    ...(audioTokens === undefined ? {} : { inputAudioTokens: audioTokens }),
    outputTokens: usage.output_tokens,
  };
};

const requiredText = (value: unknown, where: string): string => {
  if (typeof value !== 'string') throw new Error(`Audio transcription ${where} must be a string`);
  return value;
};

/** `verbose_json` and `diarized_json` both time their segments with seconds and text; the
 *  fields they do not share stay in `raw` and reach the client through it. */
const objectCues = (value: Record<string, unknown>): readonly AudioTranscriptionCue[] | undefined => {
  if (!Array.isArray(value.segments)) return undefined;
  return value.segments.map((segment: unknown, index) => {
    if (!isRecord(segment) || !isFiniteNumber(segment.start) || !isFiniteNumber(segment.end)) {
      throw new Error(`Audio transcription segment ${index} must carry numeric start and end`);
    }
    return { start: segment.start, end: segment.end, text: requiredText(segment.text, `segment ${index} text`) };
  });
};

/**
 * The one reading. A JSON rendering hands in the parsed object; `text`, `srt` and `vtt`
 * hand in the document itself.
 */
export const parseAudioTranscription = (
  format: AudioTranscriptionResponseFormat,
  body: unknown,
): CanonicalAudioTranscription => {
  if (isAudioTranscriptionObjectFormat(format)) {
    if (!isRecord(body)) throw new Error('Audio transcription response body must be an object');
    const cues = objectCues(body);
    const usage = parseAudioTranscriptionUsage(body);
    return {
      text: requiredText(body.text, 'text'),
      ...(cues === undefined ? {} : { cues }),
      raw: body,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  const document = requiredText(body, 'response body');
  if (format === 'text') return { text: document };
  const cues = parseSubtitleDocument(format, document);
  return { text: cues.map(cue => cue.text).join('\n'), cues };
};

/**
 * The one writing, back into the rendering the client asked for. A JSON rendering is the
 * upstream's own object re-serialized; a subtitle rendering is written from the cues; `text`
 * is the transcript alone.
 */
export const renderAudioTranscription = (
  format: AudioTranscriptionResponseFormat,
  transcription: CanonicalAudioTranscription,
): Record<string, unknown> | string => {
  if (isAudioTranscriptionObjectFormat(format)) {
    if (transcription.raw === undefined) {
      throw new Error(`Audio transcription cannot be rendered as ${format}: it was not read from an object`);
    }
    return transcription.raw;
  }
  if (format === 'text') return transcription.text;
  if (transcription.cues === undefined) {
    throw new Error(`Audio transcription cannot be rendered as ${format}: it carries no cues`);
  }
  return renderSubtitleDocument(format, transcription.cues);
};
