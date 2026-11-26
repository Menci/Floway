import { isOpenAIAudioTranscriptionDoneEvent, type OpenAIAudioSpeechStreamEvent, type OpenAIAudioTranscriptionStreamEvent, type OpenAIAudioTranscriptionStreamItem } from './index.ts';
import { decodeOpenAISseEvents, decodeOpenAISseWireEvents, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';

export const decodeOpenAIAudioSpeechStream = <Failure>(body: ProtocolByteStream<Failure>) =>
  decodeOpenAISseEvents<OpenAIAudioSpeechStreamEvent, Failure>(body, 'OpenAI Audio Speech');

export const decodeOpenAIAudioTranscriptionsStream = <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIAudioTranscriptionStreamItem, Failure> =>
  decodeOpenAISseWireEvents<OpenAIAudioTranscriptionStreamEvent, Failure>(body, 'OpenAI Audio Transcriptions', {
    event: isOpenAIAudioTranscriptionDoneEvent,
    missing: 'OpenAI Transcriptions stream ended without a transcript.text.done event.',
  });
