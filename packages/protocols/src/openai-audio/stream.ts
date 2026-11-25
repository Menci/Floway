import { isOpenAIAudioTranscriptionDoneEvent, type OpenAIAudioSpeechStreamEvent, type OpenAIAudioTranscriptionStreamEvent } from './index.ts';
import { decodeOpenAISseEvents, type ProtocolByteStream } from '../common/decode-sse-events.ts';

export const decodeOpenAIAudioSpeechStream = <Failure>(body: ProtocolByteStream<Failure>) =>
  decodeOpenAISseEvents<OpenAIAudioSpeechStreamEvent, Failure>(body, 'OpenAI Audio Speech');

export const decodeOpenAIAudioTranscriptionsStream = <Failure>(body: ProtocolByteStream<Failure>) =>
  decodeOpenAISseEvents<OpenAIAudioTranscriptionStreamEvent, Failure>(body, 'OpenAI Audio Transcriptions', {
    event: isOpenAIAudioTranscriptionDoneEvent,
    missing: 'OpenAI Transcriptions stream ended without a transcript.text.done event.',
  });
