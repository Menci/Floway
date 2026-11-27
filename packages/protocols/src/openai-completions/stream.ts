import type { OpenAICompletionsStreamEvent } from './index.ts';
import { decodeOpenAISseEvents, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';

export const decodeOpenAICompletionsStream = <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAICompletionsStreamEvent, Failure> => decodeOpenAISseEvents(body, 'OpenAI Completions', {
  done: true,
  missing: 'OpenAI Completions stream ended without a [DONE] sentinel.',
});
