// OpenAI-compatible audio transcription. One request shape — a multipart form — and
// several response renderings, which is the family's whole character: `response_format`
// picks between three JSON objects and three text documents, and `stream` picks a sequence
// of events instead of any of them.

export type { AudioTranscriptionCue, SubtitleDialect } from './subtitles.ts';
export { parseSubtitleDocument, renderSubtitleDocument } from './subtitles.ts';

export type {
  AudioTranscriptionObjectFormat,
  AudioTranscriptionResponseFormat,
  AudioTranscriptionUsage,
  CanonicalAudioTranscription,
} from './transcription.ts';
export {
  AUDIO_TRANSCRIPTION_RESPONSE_FORMATS,
  isAudioTranscriptionObjectFormat,
  parseAudioTranscription,
  parseAudioTranscriptionResponseFormat,
  parseAudioTranscriptionUsage,
  renderAudioTranscription,
} from './transcription.ts';

export type { AudioTranscriptionDoneEvent, AudioTranscriptionStreamEvent } from './stream.ts';
export {
  isAudioTranscriptionDoneEvent,
  parseAudioTranscriptionStreamEvent,
  parseAudioTranscriptionStreamUsage,
} from './stream.ts';
