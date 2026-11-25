import type { OpenAIImagesStreamEvent } from './index.ts';
import { decodeOpenAISseEvents, type ProtocolByteStream } from '../common/decode-sse-events.ts';

export const decodeOpenAIImagesGenerationsStream = <Failure>(body: ProtocolByteStream<Failure>) =>
  decodeOpenAISseEvents<OpenAIImagesStreamEvent, Failure>(body, 'OpenAI Images Generations');

export const decodeOpenAIImagesEditsStream = <Failure>(body: ProtocolByteStream<Failure>) =>
  decodeOpenAISseEvents<OpenAIImagesStreamEvent, Failure>(body, 'OpenAI Images Edits');
