import type { OpenAIImagesStreamItem } from './index.ts';
import { decodeOpenAISseWireEventsWithType, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';

export const decodeOpenAIImagesGenerationsStream = <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIImagesStreamItem, Failure> => decodeOpenAISseWireEventsWithType(body, 'OpenAI Images Generations');

export const decodeOpenAIImagesEditsStream = <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIImagesStreamItem, Failure> => decodeOpenAISseWireEventsWithType(body, 'OpenAI Images Edits');
