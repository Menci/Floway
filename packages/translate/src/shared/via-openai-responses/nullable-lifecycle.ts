import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

// Translation needs callable identity before its argument deltas. Nullable
// lifecycles disclose that identity only at a finalized item or terminal snapshot.
// Keep this projection internal; native Responses retains its nullable payloads.
// https://github.com/openresponses/openresponses/blob/7078a8f1aecd3d1cd41c9891e21c307fcda7f4af/schema/events.tsp#L39-L80
export const materializeNullableResponsesLifecycle = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const evidence = new Map<number, OpenAIResponsesOutputItemEx>();
  const pending = new Set<number>();
  const recovered = new Set<number>();
  const buffered: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];

  const project = function* (frame: ProtocolFrame<OpenAIResponsesStreamEventEx>): Generator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    if (frame.type === 'done') { yield frame; return; }
    const event = frame.event;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = event.item ?? evidence.get(event.output_index);
      if (item === undefined) { yield frame; return; }
      if (event.type === 'response.output_item.added' && event.item === null) {
        recovered.add(event.output_index);
        const opener = item.type === 'function_call' ? { ...item, arguments: '' }
          : item.type === 'custom_tool_call' ? { ...item, input: '' }
            : item.type === 'reasoning' ? { ...item, summary: [] } : item;
        yield eventFrame({ ...event, item: opener });
        return;
      }
      if (event.type === 'response.output_item.done' && (recovered.has(event.output_index) || event.item === null) && item.type === 'function_call') {
        if (item.id === undefined) throw new TypeError('Finalized OpenAI Responses function call has no item id.');
        yield eventFrame({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: event.output_index, arguments: item.arguments });
      }
      if (event.type === 'response.output_item.done' && (recovered.has(event.output_index) || event.item === null) && item.type === 'message') {
        if (item.id === undefined) throw new TypeError('Finalized OpenAI Responses message has no item id.');
        for (const [contentIndex, part] of item.content.entries()) {
          const position = { item_id: item.id, output_index: event.output_index, content_index: contentIndex };
          yield eventFrame(part.type === 'output_text'
            ? { type: 'response.output_text.done', ...position, text: part.text }
            : { type: 'response.refusal.done', ...position, refusal: part.refusal });
        }
      }
      yield event.item === null ? eventFrame({ ...event, item }) : frame;
      return;
    }
    if ((event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done'
      || event.type === 'response.custom_tool_call_input.delta' || event.type === 'response.custom_tool_call_input.done')
      && pending.has(event.output_index) && !evidence.has(event.output_index)) {
      throw new TypeError(`OpenAI Responses callable output_index ${event.output_index} has no finalized item evidence.`);
    }
    yield frame;
  };

  for await (const frame of frames) {
    if (frame.type === 'event') {
      const event = frame.event;
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        if (event.item === null) pending.add(event.output_index);
        else if (event.type === 'response.output_item.done') {
          evidence.set(event.output_index, event.item);
          pending.delete(event.output_index);
        }
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
        event.response.output.forEach((item, index) => evidence.set(index, item));
        if (event.type === 'response.failed' && [...pending].some(index => !evidence.has(index))) { yield frame; return; }
        for (const bufferedFrame of buffered.splice(0)) yield* project(bufferedFrame);
        pending.clear();
      } else if (event.type === 'error') {
        if (pending.size > 0) { yield frame; return; }
      }
    }
    if (pending.size > 0) buffered.push(frame);
    else {
      for (const bufferedFrame of buffered.splice(0)) yield* project(bufferedFrame);
      yield* project(frame);
    }
  }
  for (const frame of buffered) yield* project(frame);
};
