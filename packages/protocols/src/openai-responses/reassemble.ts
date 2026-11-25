import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from './index.ts';
import { collectOpenAIResponsesProtocolEventsToResult } from './to-result.ts';
import { eventFrame } from '../common/sse.ts';

export async function reassembleOpenAIResponsesEvents(events: AsyncIterable<OpenAIResponsesStreamEventEx>): Promise<OpenAIResponsesResultEx> {
  const frames = async function* () {
    for await (const event of events) yield eventFrame(event);
  };
  const result = await collectOpenAIResponsesProtocolEventsToResult(frames());
  if (!result.ok) throw result.error.cause;
  return result.value;
}
