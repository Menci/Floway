import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

// Older mapping tests specify only the deltas under test. Supply their native
// item/part lifecycle so they exercise the same reader as complete SSE streams.
export const structuredResponsesFixture = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const items = new Set<number>();
  const parts = new Set<string>();
  for await (const frame of frames) {
    if (frame.type === 'event') {
      const event = frame.event as any;
      if (event.type === 'response.output_item.added') items.add(event.output_index);
      if (event.type === 'response.content_part.added') parts.add(`${event.output_index}/${event.content_index}`);
      if (event.output_index !== undefined && !items.has(event.output_index) && event.type !== 'response.output_item.done') {
        const reasoning = event.type.includes('reasoning');
        const item = reasoning ? { type: 'reasoning', id: event.item_id, summary: [] } : { type: 'message', id: event.item_id, role: 'assistant', status: 'in_progress', content: [] };
        yield eventFrame({ type: 'response.output_item.added', output_index: event.output_index, item } as OpenAIResponsesStreamEventEx);
        items.add(event.output_index);
      }
      if (['response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done'].includes(event.type) && !parts.has(`${event.output_index}/${event.content_index}`)) {
        yield eventFrame({ type: 'response.content_part.added', output_index: event.output_index, content_index: event.content_index, item_id: event.item_id, part: event.type.includes('refusal') ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] } } as OpenAIResponsesStreamEventEx);
        parts.add(`${event.output_index}/${event.content_index}`);
      }
    }
    yield frame;
  }
};
