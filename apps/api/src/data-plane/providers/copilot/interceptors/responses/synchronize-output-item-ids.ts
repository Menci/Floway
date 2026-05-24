import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

/**
 * Copilot `/responses` streams have been seen to emit one `item.id` on
 * `response.output_item.added` and a different `item.id` on the matching
 * `response.output_item.done` for the same `output_index`. Downstream clients
 * then treat one logical output item as two separate objects.
 *
 * We pin the id from `.added` and force `.done` to reuse it.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/736afa499133a20c83734f2226f2e9639fd23a31
 * - https://github.com/caozhiyuan/copilot-api/commit/4f22448a56b77ac5e5c93e6cdfc24724d3bfdcc7
 */
interface StreamIdTracker {
  outputItemIds: Map<number, string>;
}

const fixResponsesStreamIds = (event: ResponsesStreamEvent, tracker: StreamIdTracker): ResponsesStreamEvent => {
  if (event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done') return event;

  const item = event.item as { id?: unknown };
  if (typeof event.output_index !== 'number' || typeof item.id !== 'string') {
    return event;
  }

  if (event.type === 'response.output_item.added') {
    tracker.outputItemIds.set(event.output_index, item.id);
    return event;
  }

  const originalId = tracker.outputItemIds.get(event.output_index);
  if (!originalId || item.id === originalId) return event;

  return {
    ...event,
    item: { ...item, id: originalId },
  } as ResponsesStreamEvent;
};

export const withOutputItemIdsSynchronized: ResponsesInterceptor = async (_ctx, _request, run) => {
  const result = await run();
  if (result.type !== 'events') return result;

  const tracker: StreamIdTracker = { outputItemIds: new Map() };

  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        yield frame.type === 'event' ? { ...frame, event: fixResponsesStreamIds(frame.event, tracker) } : frame;
      }
    })(),
  };
};
