import type { OpenAICompletionsStreamEvent } from './index.ts';
import { decodeOpenAISseEvents, type ProtocolByteStream } from '../common/decode-sse-events.ts';

export const decodeOpenAICompletionsStream = <Failure>(body: ProtocolByteStream<Failure>) =>
  decodeOpenAISseEvents<OpenAICompletionsStreamEvent, Failure>(body, 'OpenAI Completions', {
    done: true,
    missing: 'OpenAI Completions stream ended without a [DONE] sentinel.',
  });
