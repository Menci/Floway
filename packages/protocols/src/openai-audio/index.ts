// OpenAI-compatible audio transcription. One request shape — a multipart form — and
// several response renderings, which is the family's whole character: `response_format`
// picks between three JSON objects and three text documents, and `stream` picks a sequence
// of events instead of any of them.

export type { OpenAIAudioTranscriptionCue, SubtitleDialect } from './subtitles.ts';
export { parseSubtitleDocument } from './subtitles.ts';

export type {
  OpenAIAudioTranscriptionObjectFormat,
  OpenAIAudioTranscriptionResponseFormat,
  OpenAIAudioTranscriptionUsage,
  CanonicalOpenAIAudioTranscription,
} from './transcription.ts';
export {
  OPENAI_AUDIO_TRANSCRIPTION_RESPONSE_FORMATS,
  isOpenAIAudioTranscriptionObjectFormat,
  parseOpenAIAudioTranscription,
  parseOpenAIAudioTranscriptionResponseFormat,
  parseOpenAIAudioTranscriptionUsage,
  renderOpenAIAudioTranscription,
} from './transcription.ts';

export type { OpenAIAudioTranscriptionDoneEvent, OpenAIAudioTranscriptionStreamEvent } from './stream.ts';
export {
  isOpenAIAudioTranscriptionDoneEvent,
  parseOpenAIAudioTranscriptionStreamEvent,
  parseOpenAIAudioTranscriptionStreamUsage,
} from './stream.ts';
