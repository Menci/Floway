import { isOpenAIAudioTranscriptionDoneEvent, type OpenAIAudioSpeechStreamEvent, type OpenAIAudioTranscriptionStreamEvent, type OpenAIAudioTranscriptionStreamItem } from './index.ts';
import { decodeOpenAISseWireEvents, decodeOpenAISseWireEventsWithType, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';

export const decodeOpenAIAudioSpeechStream = async function* <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIAudioSpeechStreamEvent, Failure> {
  for await (const item of decodeOpenAISseWireEventsWithType(body, 'OpenAI Audio Speech')) {
    if (!item.ok) {
      yield item;
      return;
    }
    const { data, eventName } = item.value;
    yield { ok: true, value: data.type === undefined && eventName !== undefined ? { ...data, type: eventName } : data };
  }
};

export const decodeOpenAIAudioTranscriptionsStream = <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIAudioTranscriptionStreamItem, Failure> =>
  decodeOpenAISseWireEvents<OpenAIAudioTranscriptionStreamEvent, Failure>(body, 'OpenAI Audio Transcriptions', {
    event: isOpenAIAudioTranscriptionDoneEvent,
    missing: 'OpenAI Transcriptions stream ended without a transcript.text.done event.',
  });
